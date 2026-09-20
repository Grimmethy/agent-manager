"""Tests for /api/hygiene/inventory (the Hygiene tab's backend) -- see routes/hygiene.py.

Run: .venv/bin/python -m unittest python.dashboard.test_hygiene_inventory_route -v
"""
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes import hygiene  # noqa: E402


def inventory(**open_by_family):
    fams = []
    for key in ("observability", "performance", "function_length", "unused_export", "arch", "change_review"):
        o = {"waitingFlags": 0, "waitingCandidates": 0, "stuckCandidates": 0, "inFlight": 0, "needsHuman": 0, "awaitingMerge": 0}
        o.update(open_by_family.get(key, {}))
        fams.append({"key": key, "label": key, "open": o})
    return {"generatedAt": "2026-09-19T00:00:00Z", "projectTag": "proj", "families": fams, "totals": {}, "notes": []}


def stats_db(rows):
    """rows: [(task_id, latency_ms, started_at_offset_days)] -> path to a real sqlite model-stats file."""
    d = tempfile.mkdtemp()
    path = Path(d) / "model-stats.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE model_calls (call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT, model TEXT, started_at TEXT NOT NULL, latency_ms INTEGER)")
    for i, (task_id, latency_ms, days_ago) in enumerate(rows):
        conn.execute("INSERT INTO model_calls VALUES (?,?,?,?,datetime('now', ?),?)", (f"c{i}", task_id, "implement", "m", f"-{days_ago} days", latency_ms))
    conn.commit()
    conn.close()
    return path


class HygieneRouteTest(unittest.TestCase):
    def setUp(self):
        hygiene._cache.update({"key": None, "at": 0.0, "payload": None})
        self.client = app.app.test_client()
        self._p = [
            mock.patch.object(app, "get_active_repo_root", return_value="/repo/a"),
            mock.patch.object(app, "get_pipeline_dir", return_value=Path("/pipe/a")),
        ]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()

    # --- estimate -----------------------------------------------------------------------------------------------

    def test_estimate_is_open_units_times_average_model_time_per_finished_task(self):
        # 3 finished change-review tasks; each task's calls sum to 100s, 200s, 300s -> average 200s.
        db = stats_db([("change-review-a", 60000, 1), ("change-review-a", 40000, 1), ("change-review-b", 200000, 2), ("change-review-c", 300000, 3)])
        inv = inventory(change_review={"inFlight": 349, "needsHuman": 2, "awaitingMerge": 5, "stuckCandidates": 4})
        with mock.patch.object(app, "model_stats_db_path", return_value=db):
            est = hygiene.build_estimate(inv)
        self.assertTrue(est["available"])
        cr = est["byFamily"]["change_review"]
        self.assertEqual(cr["units"], 349, "in-flight counts; needs-human, awaiting-merge and stuck do not")
        self.assertEqual(cr["avgSecondsPerTask"], 200.0)
        self.assertEqual(cr["samples"], 3)
        self.assertEqual(est["seconds"], 349 * 200)
        self.assertEqual(est["hours"], round(349 * 200 / 3600.0, 1))
        self.assertEqual(est["unitsWithoutBasis"], 0)

    def test_a_family_with_too_few_finished_tasks_gets_no_estimate_rather_than_a_made_up_one(self):
        db = stats_db([("performance-a", 90000, 1), ("performance-b", 90000, 1)])   # only 2 samples
        inv = inventory(performance={"waitingFlags": 75})
        with mock.patch.object(app, "model_stats_db_path", return_value=db):
            est = hygiene.build_estimate(inv)
        self.assertIsNone(est["byFamily"]["performance"]["avgSecondsPerTask"])
        self.assertNotIn("seconds", est["byFamily"]["performance"])
        self.assertEqual(est["unitsWithoutBasis"], 75)
        self.assertEqual(est["seconds"], 0)

    def test_calls_older_than_the_window_are_ignored(self):
        db = stats_db([("arch-x", 100000, 1), ("arch-y", 100000, 2), ("arch-z", 100000, 3), ("arch-old", 9000000, 90)])
        inv = inventory(arch={"waitingCandidates": 2})
        with mock.patch.object(app, "model_stats_db_path", return_value=db):
            est = hygiene.build_estimate(inv)
        self.assertEqual(est["byFamily"]["arch"]["samples"], 3)
        self.assertEqual(est["byFamily"]["arch"]["avgSecondsPerTask"], 100.0)

    def test_estimate_degrades_cleanly_with_no_database(self):
        with mock.patch.object(app, "model_stats_db_path", return_value=Path("/nonexistent/model-stats.db")):
            est = hygiene.build_estimate(inventory(arch={"waitingCandidates": 1}))
        self.assertFalse(est["available"])
        with mock.patch.object(app, "model_stats_db_path", return_value=None):
            self.assertFalse(hygiene.build_estimate(inventory())["available"])

    # --- the route ------------------------------------------------------------------------------------------------

    def test_route_serves_the_inventory_plus_an_estimate_and_caches_briefly(self):
        inv = inventory(function_length={"stuckCandidates": 43})
        with mock.patch.object(hygiene, "run_inventory", return_value=(inv, None)) as run, \
             mock.patch.object(hygiene, "build_estimate", return_value={"available": False, "reason": "x"}):
            a = self.client.get("/api/hygiene/inventory").get_json()
            b = self.client.get("/api/hygiene/inventory").get_json()
            self.assertTrue(a["available"])
            self.assertEqual(a["projectTag"], "proj")
            self.assertEqual(a["estimate"], {"available": False, "reason": "x"})
            self.assertEqual(a, b)
            self.assertEqual(run.call_count, 1, "the second call inside the TTL is served from cache")
            self.client.get("/api/hygiene/inventory?refresh=1")
            self.assertEqual(run.call_count, 2, "?refresh=1 bypasses the cache")

    def test_switching_the_active_project_invalidates_the_cache(self):
        with mock.patch.object(hygiene, "run_inventory", return_value=(inventory(), None)) as run, \
             mock.patch.object(hygiene, "build_estimate", return_value={"available": False}):
            self.client.get("/api/hygiene/inventory")
            with mock.patch.object(app, "get_active_repo_root", return_value="/repo/b"):
                self.client.get("/api/hygiene/inventory")
            self.assertEqual(run.call_count, 2, "a different active project is a different cache key")

    def test_a_failure_is_reported_with_its_reason_and_never_cached(self):
        with mock.patch.object(hygiene, "run_inventory", return_value=(None, "boom")) as run:
            body = self.client.get("/api/hygiene/inventory").get_json()
            self.assertEqual(body, {"available": False, "reason": "boom"})
            self.client.get("/api/hygiene/inventory")
            self.assertEqual(run.call_count, 2)

    # --- the Node call ----------------------------------------------------------------------------------------------

    def _run(self, **kw):
        with mock.patch("routes.hygiene.subprocess.run", **kw) as sp, mock.patch.object(app, "read_env_file", return_value={"AGENT_MANAGER_REGISTER_PATH": "/x/register.js"}):
            return hygiene.run_inventory(), sp

    def test_run_inventory_passes_the_pipeline_env_and_parses_the_json(self):
        cp = subprocess.CompletedProcess([], 0, stdout=json.dumps({"families": [], "projectTag": "p"}), stderr="")
        (data, err), sp = self._run(return_value=cp)
        self.assertEqual((data["projectTag"], err), ("p", None))
        args, kwargs = sp.call_args
        self.assertEqual(args[0][0], "node")
        self.assertTrue(args[0][1].endswith("hygiene-inventory.js"))
        self.assertEqual(kwargs["env"]["AGENT_MANAGER_REGISTER_PATH"], "/x/register.js", "plugins are registered for the child")

    def test_run_inventory_failure_modes(self):
        (d, e), _ = self._run(return_value=subprocess.CompletedProcess([], 1, stdout="", stderr="bad thing"))
        self.assertEqual((d, e), (None, "bad thing"))
        (d, e), _ = self._run(return_value=subprocess.CompletedProcess([], 0, stdout="not json", stderr=""))
        self.assertEqual(d, None); self.assertIn("non-JSON", e)
        (d, e), _ = self._run(return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps({"error": "no repo"}), stderr=""))
        self.assertEqual((d, e), (None, "no repo"))
        (d, e), _ = self._run(side_effect=subprocess.TimeoutExpired("node", 45))
        self.assertEqual(d, None); self.assertIn("timed out", e)


if __name__ == "__main__":
    unittest.main()
