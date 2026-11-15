"""/api/pipeline-map: the topology is cached by what `node src/task-sources.js --dump-topology` reads and refreshed in the background (swr_cache.py), not started on every request
(ADR-0024, 'UI triggers, not polls' piece 6).

Run: .venv/bin/python -m unittest test_pipeline_map_cache -v   (from python/dashboard)
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import swr_cache  # noqa: E402
from routes import job_types  # noqa: E402


def topo(*names):
    return [{"name": n, "kind": "x"} for n in names]


class PipelineMapCache(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        root = Path(self.td.name)
        self.env_file = root / "agent-manager.env"
        self.env_file.write_text("A=1\n")
        self.plugins = root / "plugins.json"
        self.plugins.write_text("[]")
        self.settings = root / "dashboard-settings.json"
        self.settings.write_text("{}")
        job_types._TOPOLOGY_CACHE.update(at=0.0, topology=[])
        job_types._TOPOLOGY_CACHE.pop("key", None)
        job_types._TOPOLOGY_STATE.update(error=None, status=200)
        swr_cache._inflight.clear()
        self.jobs = []
        self.calls = []
        self.answer = [topo("alpha", "beta")]
        self.live = {"alpha": {"pending": 2}, "ghost": {"review": 1}}

        self.kwargs = []

        def fake_run(cmd, **kw):
            self.calls.append(cmd)
            self.kwargs.append(kw)
            a = self.answer[0]
            if isinstance(a, Exception):
                raise a
            return mock.Mock(returncode=a[0], stdout=a[1], stderr=a[2]) if isinstance(a, tuple) else mock.Mock(returncode=0, stdout=json.dumps(a), stderr="")
        env = {k: v for k, v in os.environ.items() if not k.startswith("AGENT_MANAGER_")}
        patches = [
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(app, "ENV_FILE_PATH", self.env_file),
            mock.patch.object(app, "PLUGINS_MANIFEST_PATH", self.plugins),
            mock.patch("app_settings_helpers.DASHBOARD_SETTINGS_PATH", self.settings),
            mock.patch.object(app, "read_env_file", return_value={}),
            mock.patch.object(app, "queue_dir", lambda: root / "queue"),
            mock.patch.object(app, "_pipeline_live_counts", lambda q: {k: dict(v) for k, v in self.live.items()}),
            mock.patch("model_stats_client.get_turns_summary", lambda *a, **k: {"bySource": [{"source": "alpha", "avg": 3}]}),
            mock.patch.object(job_types.subprocess, "run", fake_run),
            mock.patch.object(swr_cache, "run_background", self.jobs.append),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(swr_cache._inflight.clear)
        self.client = app.app.test_client()

    def get(self):
        return self.client.get("/api/pipeline-map")

    def run_jobs(self):
        jobs, self.jobs[:] = list(self.jobs), []
        for j in jobs:
            j()

    def test_node_runs_once_while_nothing_it_reads_changes(self):
        first = self.get().get_json()
        for _ in range(4):
            self.assertEqual(self.get().get_json(), first)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][-1], "--dump-topology")
        self.assertEqual(self.jobs, [])

    def test_node_is_started_as_before_with_a_15_second_limit_in_the_source_directory(self):
        self.get()
        kw = self.kwargs[0]
        self.assertEqual(kw["timeout"], 15)
        self.assertEqual(kw["cwd"], str(app.SRC_DIR))
        self.assertTrue(kw["capture_output"] and kw["text"])
        self.assertIn("env", kw)

    def test_the_payload_keeps_its_shape_live_counts_turns_and_unregistered(self):
        body = self.get().get_json()
        self.assertTrue(body["available"])
        by = {s["name"]: s for s in body["sources"]}
        self.assertEqual(by["alpha"]["liveCounts"], {"pending": 2})
        self.assertEqual(by["alpha"]["turnsStats"], {"source": "alpha", "avg": 3})
        self.assertEqual(by["beta"]["liveCounts"], {})
        self.assertIsNone(by["beta"]["turnsStats"])
        self.assertEqual(body["unregistered"], [{"name": "ghost", "liveCounts": {"review": 1}}])

    def test_live_counts_are_fresh_on_every_request_and_never_leak_into_the_cache(self):
        self.get()
        self.live = {"beta": {"approved": 7}}
        body = self.get().get_json()
        by = {s["name"]: s for s in body["sources"]}
        self.assertEqual(by["alpha"]["liveCounts"], {})
        self.assertEqual(by["beta"]["liveCounts"], {"approved": 7})
        self.assertNotIn("liveCounts", job_types._TOPOLOGY_CACHE["topology"][0])
        self.assertEqual(len(self.calls), 1)

    def test_a_changed_env_file_serves_the_old_topology_at_once_and_refreshes_in_the_background(self):
        self.get()
        self.env_file.write_text("A=22\n")
        self.answer[0] = topo("gamma")
        with mock.patch.object(job_types.subprocess, "run", side_effect=AssertionError("a request must not wait for node")):
            body = self.get().get_json()
        self.assertEqual([s["name"] for s in body["sources"]], ["alpha", "beta"])
        self.assertEqual(len(self.jobs), 1)
        self.run_jobs()
        self.assertEqual([s["name"] for s in self.get().get_json()["sources"]], ["gamma"])

    def test_each_input_changing_makes_the_key_change(self):
        base = job_types._topology_key()
        self.assertEqual(job_types._topology_key(), base)
        self.env_file.write_text("A=333\n")
        k1 = job_types._topology_key()
        self.assertNotEqual(k1, base)
        self.plugins.write_text('[{"name": "x"}]')
        k2 = job_types._topology_key()
        self.assertNotEqual(k2, k1)
        self.settings.write_text('{"a": 1}')
        k3 = job_types._topology_key()
        self.assertNotEqual(k3, k2)
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_TASK_SOURCES": "a,b"}):
            self.assertNotEqual(job_types._topology_key(), k3)
        with mock.patch.dict(os.environ, {"SOME_UNRELATED_VARIABLE": "1"}):
            self.assertEqual(job_types._topology_key(), k3)

    def test_the_registry_script_is_part_of_the_key(self):
        seen = []
        real = os.stat
        with mock.patch.object(job_types.os, "stat", side_effect=lambda p, *a, **k: seen.append(str(p)) or real(p, *a, **k)):
            job_types._topology_key()
        self.assertIn(str(app.SRC_DIR / "task-sources.js"), seen)

    def test_a_timeout_reports_504_and_the_reason_and_caches_nothing(self):
        self.answer[0] = subprocess.TimeoutExpired("node", 15)
        r = self.get()
        self.assertEqual(r.status_code, 504)
        self.assertEqual(r.get_json(), {"available": False, "reason": "task-sources.js --dump-topology timed out"})
        self.answer[0] = topo("alpha")
        self.assertTrue(self.get().get_json()["available"])
        self.assertEqual(len(self.calls), 2)

    def test_a_non_zero_exit_reports_its_stderr_cut_to_500_characters(self):
        self.answer[0] = (1, "", "boom " * 200)
        r = self.get()
        self.assertEqual(r.status_code, 200)
        reason = r.get_json()["reason"]
        self.assertFalse(r.get_json()["available"])
        self.assertEqual(len(reason), 500)
        self.answer[0] = (1, "", "")
        self.assertEqual(self.get().get_json()["reason"], "task-sources.js exited non-zero")

    def test_non_json_output_and_an_empty_or_non_list_topology_are_unavailable(self):
        self.answer[0] = (0, "not json", "")
        self.assertEqual(self.get().get_json()["reason"], "task-sources.js --dump-topology returned non-JSON output")
        for out in ("[]", "{}", '"x"'):
            self.answer[0] = (0, out, "")
            self.assertEqual(self.get().get_json()["reason"], "task-sources.js --dump-topology returned no sources", out)

    def test_a_failed_refresh_keeps_serving_the_last_good_topology(self):
        self.get()
        self.env_file.write_text("A=9\n")
        self.answer[0] = (1, "", "boom")
        body = self.get().get_json()
        self.run_jobs()
        self.assertEqual([s["name"] for s in body["sources"]], ["alpha", "beta"])
        self.assertEqual([s["name"] for s in self.get().get_json()["sources"]], ["alpha", "beta"])

    def test_the_default_ttl_is_the_slow_reconcile(self):
        self.assertEqual(job_types._TOPOLOGY_TTL_S, 600.0)


if __name__ == "__main__":
    unittest.main()
