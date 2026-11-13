"""The Workers tab's cards for the pipeline-ops workers (routes/pipeline_ops_workers.py), 2026-11-04.

Everything the route reads is faked or lives in a temp dir: no real ledger, no real drain, no network.
Run: .venv/bin/python -m unittest python.dashboard.test_pipeline_ops_workers -v   (from the repo root)
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes import pipeline_ops_workers as po  # noqa: E402

_ISO_DIR = tempfile.mkdtemp(prefix="po-workers-tests-")
_ISO_ENV = mock.patch.dict(os.environ, {"HOME": _ISO_DIR})


def setUpModule():
    # Every test runs with HOME in a temp dir: even a broken path rule can only ever write here, never the real ~/.local/state/pipeline-ops.
    _ISO_ENV.start()


def tearDownModule():
    _ISO_ENV.stop()


NOW = 1_800_000_000.0                       # 2027-01-15T08:00:00Z
ISO = lambda secs_ago: datetime.fromtimestamp(NOW - secs_ago, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731


def row(key, outcome, ago, phase="result", mode="dry-run", result="dry-run: not executed", action="none", **extra):
    return {"at": ISO(ago), "mode": mode, "key": key, "version": "v1", "outcome": outcome, "reason": "because " + str(outcome), "evidence_keys": ["facts.x"], "factsKey": key + "|none",
            "phase": phase, "action": action, "result": result, **extra}


TRIG = {"state": "listening", "checkedAgeS": 12, "endedAgeS": 60, "stopped": "idle", "iterations": 1}
OFF = {"disabled": False, "disabledAt": None}


def build(rows=(), trigger=TRIG, switch=OFF, name="scout"):
    return po.build_worker(name, env={}, now=NOW, read_rows=lambda p: list(rows), trigger=lambda: trigger, read_sw=lambda n, e: switch)


class BuildWorker(unittest.TestCase):
    def test_nothing_at_all_is_not_configured(self):
        self.assertEqual(build(trigger=None), {"configured": False, "name": "scout"})

    def test_any_single_trace_is_enough(self):
        self.assertTrue(build(rows=[row("a", "NO-NEW-POLLS", 5)], trigger=None)["configured"])
        self.assertTrue(build(trigger=TRIG)["configured"])
        self.assertTrue(build(trigger=None, switch={"disabled": True, "disabledAt": "2027-01-15T07:00:00Z"})["configured"])

    def test_only_result_rows_are_decisions_and_todays_are_counted_by_outcome(self):
        rows = [row("a", "FILE-TASK", 100, phase="intent"), row("a", "FILE-TASK", 99), row("b", "NO-NEW-POLLS", 50), row("b", "NO-NEW-POLLS", 40), row("c", "FILE-TASK", 90000),
                {"at": ISO(5), "phase": "result", "result": "x"}, {"at": ISO(5), "phase": "result", "key": "d"}]
        p = build(rows)
        self.assertEqual(p["decisions"], 4)
        self.assertEqual(p["today"], {"FILE-TASK": 1, "NO-NEW-POLLS": 2})
        self.assertEqual(p["items"]["total"], 3)
        self.assertEqual(p["items"]["byOutcome"], {"FILE-TASK": 2, "NO-NEW-POLLS": 1})

    def test_dry_run_rows_are_never_acted_and_failures_are_counted_apart(self):
        rows = [row("a", "FILE-TASK", 50, mode="on", action="file-task", result="filed: T1"), row("b", "FILE-TASK", 40, mode="dry-run", action="file-task"),
                row("c", "FILE-TASK", 30, mode="on", action="file-task", result="failed: queue is full"), row("d", "NO-NEW-POLLS", 20, mode="on", result="no action"),
                row("e", "NO-NEW-POLLS", 10, mode="on", result="refused: bad"), row("f", "NO-NEW-POLLS", 8, mode="on", result="ledger unwritable (x): no action taken")]
        p = build(rows)
        self.assertEqual(p["actedToday"], 1)
        self.assertEqual(p["failedToday"], 3)

    def test_the_mode_is_the_newest_rows_mode(self):
        self.assertEqual(build([row("a", "X", 50, mode="dry-run"), row("b", "X", 5, mode="on")])["mode"], "on")
        self.assertIsNone(build([])["mode"])

    def test_items_keep_the_latest_decision_of_each_key(self):
        p = build([row("a", "BASELINE-CREATED", 100), row("a", "NO-NEW-POLLS", 50), row("b", "FILE-TASK", 40)])
        self.assertEqual(p["items"]["byOutcome"], {"NO-NEW-POLLS": 1, "FILE-TASK": 1})

    def test_holds_are_the_latest_decision_being_a_hold_oldest_first_with_question_and_recommendation(self):
        rows = [row("young", "HOLD-FOR-OWNER", 600, question="Q young?"), row("old", "HOLD-FOR-OWNER", 90000, question="Q old?", recommendation="do x"),
                row("gone", "HOLD-FOR-OWNER", 5000, question="Q gone?"), row("gone", "NO-NEW-POLLS", 100), row("plain", "HOLD-FOR-OWNER", 50)]
        p = build(rows)
        self.assertEqual([h["key"] for h in p["holds"]], ["old", "young", "plain"])
        self.assertEqual(p["holdCount"], 3)
        self.assertEqual(p["holds"][0]["question"], "Q old?")
        self.assertEqual(p["holds"][0]["recommendation"], "do x")
        self.assertIsNone(p["holds"][1]["recommendation"])
        self.assertEqual(p["holds"][2]["question"], "because HOLD-FOR-OWNER")      # no question: the reason
        self.assertEqual(p["holds"][0]["ageS"], 90000)

    def test_holds_are_capped(self):
        rows = [row(f"k{i}", "HOLD-FOR-OWNER", 100 + i, question="q") for i in range(po.HOLDS_CAP + 7)]
        p = build(rows)
        self.assertEqual(len(p["holds"]), po.HOLDS_CAP)
        self.assertEqual(p["holdCount"], po.HOLDS_CAP + 7)

    def test_recent_is_the_newest_decisions_first_and_capped(self):
        rows = [row(f"k{i}", "NO-NEW-POLLS", 1000 - i * 10) for i in range(po.RECENT_COUNT + 4)]
        p = build(rows)
        self.assertEqual(len(p["recent"]), po.RECENT_COUNT)
        self.assertEqual(p["recent"][0]["key"], f"k{po.RECENT_COUNT + 3}")
        self.assertEqual(set(p["recent"][0]), {"at", "key", "outcome", "mode", "action", "result", "reason"})

    def test_last_tick_comes_from_the_newest_row_of_any_phase(self):
        p = build([row("a", "X", 125), row("a", "X", 30, phase="intent")])
        self.assertEqual(p["lastTickAgeS"], 30)
        self.assertEqual(p["lastTickAt"], ISO(30))
        self.assertIsNone(build(trigger=TRIG)["lastTickAgeS"])

    def test_a_failing_reader_never_raises_and_a_torn_ledger_row_is_skipped_by_the_default_reader(self):
        def boom(*a, **k):
            raise RuntimeError("x")
        p = po.build_worker("scout", env={}, now=NOW, read_rows=boom, trigger=boom, read_sw=boom)
        self.assertEqual(p, {"configured": False, "name": "scout"})
        f = os.path.join(_ISO_DIR, "scout-ledger.jsonl")
        with open(f, "w") as fh:
            fh.write(json.dumps(row("a", "NO-NEW-POLLS", 5)) + "\n{\"torn\n")
        got = po.build_worker("scout", env={"HOME": _ISO_DIR, "SCOUT_LEDGER_PATH": f}, now=NOW, trigger=lambda: None, read_sw=lambda n, e: OFF)
        self.assertEqual(got["decisions"], 1)

    def test_workers_are_independent_and_named(self):
        self.assertEqual(po.WORKERS, ("scout", "checker", "merger", "steward", "hub", "atomizer"))
        self.assertEqual(build(name="checker", trigger=TRIG)["name"], "checker")


class Paths(unittest.TestCase):
    def test_defaults_overrides_and_the_marker_name_per_worker(self):
        home = "/h"
        base = os.path.join(home, ".local", "state", "pipeline-ops")
        self.assertEqual(po.ledger_path("scout", {"HOME": home}), os.path.join(base, "scout-ledger.jsonl"))
        self.assertEqual(po.switch_path("checker", {"HOME": home}), os.path.join(base, "checker-disabled"))
        self.assertEqual(po.ledger_path("scout", {"HOME": home, "SCOUT_LEDGER_PATH": "/x/l"}), "/x/l")
        self.assertEqual(po.switch_path("scout", {"HOME": home, "SCOUT_DISABLED_PATH": "/x/m"}), "/x/m")
        self.assertEqual(po.switch_path("scout", {"HOME": home, "SCOUT_DISABLED_PATH": "  "}), os.path.join(base, "scout-disabled"))
        self.assertEqual(po.switch_path("scout", {"HOME": home, "CHECKER_DISABLED_PATH": "/x/m"}), os.path.join(base, "scout-disabled"))
        self.assertEqual(po.switch_path("checker", {"HOME": home, "CHECKER_DISABLED_PATH": "/x/m"}), "/x/m")
        self.assertEqual(po.ledger_path("merger", {"HOME": home, "MERGER_LEDGER_PATH": "/x/l"}), "/x/l")
        self.assertEqual(po.ledger_path("steward", {"HOME": home}), os.path.join(base, "steward-ledger.jsonl"))
        # the hub worker (docs/hub-worker.md) uses the same keyed paths and variable names as the others
        self.assertEqual(po.ledger_path("hub", {"HOME": home}), os.path.join(base, "hub-ledger.jsonl"))
        self.assertEqual(po.ledger_path("hub", {"HOME": home, "HUB_LEDGER_PATH": "/x/h"}), "/x/h")
        self.assertEqual(po.switch_path("hub", {"HOME": home}), os.path.join(base, "hub-disabled"))
        self.assertEqual(po.switch_path("hub", {"HOME": home, "HUB_DISABLED_PATH": "/x/m"}), "/x/m")


class Switch(unittest.TestCase):
    def setUp(self):
        self.env = {"HOME": tempfile.mkdtemp(prefix="po-sw-", dir=_ISO_DIR)}

    def test_off_writes_the_marker_atomically_and_on_removes_it_idempotently(self):
        self.assertEqual(po.read_switch("scout", self.env), OFF)
        got = po.set_enabled("scout", False, self.env, now=NOW)
        self.assertEqual(got, {"disabled": True, "disabledAt": "2027-01-15T08:00:00.000Z"})
        self.assertEqual(po.read_switch("scout", self.env), got)
        self.assertTrue(os.path.isfile(po.switch_path("scout", self.env)))
        self.assertEqual([f for f in os.listdir(os.path.dirname(po.switch_path("scout", self.env))) if f.endswith(".tmp")], [])
        self.assertEqual(po.set_enabled("scout", True, self.env), OFF)
        self.assertEqual(po.set_enabled("scout", True, self.env), OFF)
        self.assertFalse(os.path.exists(po.switch_path("scout", self.env)))

    def test_workers_have_their_own_markers(self):
        po.set_enabled("scout", False, self.env, now=NOW)
        self.assertFalse(po.read_switch("checker", self.env)["disabled"])

    def test_an_empty_or_garbled_marker_still_means_off_and_a_directory_means_on(self):
        path = po.switch_path("scout", self.env)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w").close()
        self.assertEqual(po.read_switch("scout", self.env), {"disabled": True, "disabledAt": None})
        with open(path, "w") as f:
            f.write("{bad")
        self.assertEqual(po.read_switch("scout", self.env), {"disabled": True, "disabledAt": None})
        with open(path, "w") as f:
            f.write('{"disabledAt": 5}')
        self.assertEqual(po.read_switch("scout", self.env), {"disabled": True, "disabledAt": None})     # a non-text time is not shown
        os.unlink(path)
        os.mkdir(path)
        self.assertEqual(po.read_switch("scout", self.env), OFF)


class Routes(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_get_returns_every_worker_and_unconfigured_ones_are_marked_so(self):
        with mock.patch.dict(os.environ, {"HOME": tempfile.mkdtemp(prefix="po-get-", dir=_ISO_DIR)}):
            body = self.client.get("/api/pipeline-ops-workers").get_json()
        self.assertEqual(sorted(body["workers"]), sorted(po.WORKERS))
        self.assertTrue(all(w == {"configured": False, "name": n} for n, w in body["workers"].items()))

    def test_post_switches_one_worker_off_and_on_and_get_shows_it(self):
        home = tempfile.mkdtemp(prefix="po-post-", dir=_ISO_DIR)
        with mock.patch.dict(os.environ, {"HOME": home}):
            r = self.client.post("/api/pipeline-ops-workers/scout/enabled", json={"enabled": False})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.get_json()["switch"]["disabled"], True)
            self.assertTrue(os.path.isfile(os.path.join(home, ".local", "state", "pipeline-ops", "scout-disabled")))
            self.assertFalse(os.path.exists(os.path.join(home, ".local", "state", "pipeline-ops", "checker-disabled")))
            got = self.client.get("/api/pipeline-ops-workers").get_json()["workers"]
            self.assertTrue(got["scout"]["configured"])
            self.assertTrue(got["scout"]["switch"]["disabled"])
            self.assertFalse(got["checker"]["configured"])
            r = self.client.post("/api/pipeline-ops-workers/scout/enabled", json={"enabled": True})
            self.assertEqual(r.get_json()["switch"], OFF)
            self.assertFalse(os.path.exists(os.path.join(home, ".local", "state", "pipeline-ops", "scout-disabled")))

    def test_an_unknown_worker_is_404_and_a_bad_body_is_400_and_neither_writes(self):
        home = tempfile.mkdtemp(prefix="po-bad-", dir=_ISO_DIR)
        with mock.patch.dict(os.environ, {"HOME": home}):
            self.assertEqual(self.client.post("/api/pipeline-ops-workers/nope/enabled", json={"enabled": False}).status_code, 404)
            self.assertEqual(self.client.post("/api/pipeline-ops-workers/../x/enabled", json={"enabled": False}).status_code, 404)
            for body in ({}, {"enabled": "yes"}, {"enabled": 1}, [True]):
                self.assertEqual(self.client.post("/api/pipeline-ops-workers/scout/enabled", json=body).status_code, 400, body)
            self.assertEqual(self.client.post("/api/pipeline-ops-workers/scout/enabled", data="not json", content_type="application/json").status_code, 400)
        self.assertFalse(os.path.exists(os.path.join(home, ".local")))

    def test_a_filesystem_failure_is_a_500_with_a_reason(self):
        with mock.patch.object(po, "set_enabled", side_effect=OSError("disk full")):
            r = self.client.post("/api/pipeline-ops-workers/scout/enabled", json={"enabled": False})
        self.assertEqual(r.status_code, 500)
        self.assertIn("disk full", r.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
