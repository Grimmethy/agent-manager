"""The Workers tab's Branch-verifier card payload (routes/verifier_worker.py), 2026-11-02.

Everything the route reads is faked or lives in a temp dir: no real ledger, no real systemd, no network.
Run: .venv/bin/python -m unittest python.dashboard.test_verifier_worker -v   (from the repo root)
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes import verifier_worker as vw  # noqa: E402

_ISO_DIR = tempfile.mkdtemp(prefix="verifier-worker-tests-")
_ISO_ENV = mock.patch.dict(os.environ, {"HOME": _ISO_DIR, "VERIFIER_DISABLED_PATH": os.path.join(_ISO_DIR, "marker"), "VERIFIER_LEDGER_PATH": os.path.join(_ISO_DIR, "ledger.jsonl"),
                                        "VERIFIER_INDEX_PATH": os.path.join(_ISO_DIR, "index.json")})


def setUpModule():
    # Every test runs with HOME and every state path in a temp dir: even a broken rule can only ever write here, never the real ~/.local/state/pipeline-ops.
    _ISO_ENV.start()


def tearDownModule():
    _ISO_ENV.stop()


NOW = 1_800_000_000.0                       # 2027-01-15T08:00:00Z
ISO = lambda secs_ago: datetime.fromtimestamp(NOW - secs_ago, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731


def row(phase, branch, verdict, ago, mode="on", result=None, sha="s1", **extra):
    r = {"at": ISO(ago), "mode": mode, "project": "alpha", "branch": branch, "sha": sha, "verdict": verdict, "reasons": ["Automated check: " + str(verdict)], "phase": phase}
    if result is not None:
        r["result"] = result
    return {**r, **extra}


def build(rows=(), index=None, timer=True, env=None, switch=None):
    return vw.build_verifier_worker(env=env or {}, now=NOW, read_rows=lambda p: list(rows), read_index=lambda p: index, timer=lambda: timer,
                                    read_sw=(lambda e: switch) if switch is not None else (lambda e: {"disabled": False, "disabledAt": None}))


class Payload(unittest.TestCase):
    def test_nothing_at_all_is_not_configured(self):
        self.assertEqual(build(timer=False), {"configured": False})
        self.assertEqual(build(timer=None), {"configured": False})

    def test_any_single_trace_is_enough(self):
        self.assertTrue(build(timer=True)["configured"])
        self.assertTrue(build(timer=False, index={"branches": 3, "builtAt": None})["configured"])
        self.assertTrue(build(timer=False, rows=[row("intent", "a", "merge", 5, mode="dry-run")])["configured"])
        self.assertTrue(build(timer=False, switch={"disabled": True, "disabledAt": "x"})["configured"])

    def test_result_replaces_its_intent_and_only_live_results_count_today(self):
        rows = [row("intent", "a", "merge", 100, result="planned"), row("result", "a", "merge", 99, result="recorded"),
                row("intent", "b", "needs-work", 90, result="planned"), row("result", "b", "needs-work", 89, result="failed: HTTP 500"),
                row("intent", "c", "merge", 80, mode="dry-run", result="dry-run: not executed"),
                row("result", "d", None, 70, result="no verdict recorded"),
                row("intent", "e", "hold", 60, result="planned")]          # an intent still open: not a result, not counted
        p = build(rows)
        self.assertEqual(p["decisions"], 5)
        self.assertEqual(p["today"], {"merge": 1, "needs-work": 1, "no verdict": 1})
        self.assertEqual((p["recordedToday"], p["failedToday"]), (1, 1))

    def test_a_new_head_of_the_same_branch_is_its_own_decision(self):
        rows = [row("result", "a", "merge", 100, result="recorded", sha="s1"), row("result", "a", "needs-work", 50, result="recorded", sha="s2")]
        self.assertEqual(build(rows)["decisions"], 2)

    def test_a_result_for_another_head_does_not_replace_an_open_intent(self):
        rows = [row("intent", "a", "merge", 100, result="planned", sha="s1"), row("result", "a", "merge", 90, result="recorded", sha="s2")]
        self.assertEqual(build(rows)["decisions"], 2)

    def test_lines_without_a_branch_are_not_decisions(self):
        rows = [{"at": ISO(5), "mode": "on", "phase": "result", "result": "x"}, row("result", "a", "merge", 4, result="recorded")]
        self.assertEqual(build(rows)["decisions"], 1)

    def test_a_dry_run_result_line_is_not_counted_as_a_live_verdict(self):
        rows = [row("result", "a", None, 5, mode="dry-run", result="no verdict recorded")]
        p = build(rows)
        self.assertEqual((p["today"], p["recordedToday"], p["failedToday"]), ({}, 0, 0))

    def test_recent_carries_the_first_reason(self):
        rows = [row("result", "a", "merge", 5, result="recorded", reasons=["first", "second"])]
        self.assertEqual(build(rows)["recent"][0]["reason"], "first")

    def test_pending_record_counts_as_recorded_and_head_moved_as_failed(self):
        rows = [row("result", "a", "merge", 10, result="recorded: pending until the branch list refreshes"), row("result", "b", "merge", 9, result="head moved: again later"),
                row("result", "c", "merge", 8, result="refused: x")]
        p = build(rows)
        self.assertEqual((p["recordedToday"], p["failedToday"]), (1, 2))

    def test_yesterdays_results_are_not_today(self):
        p = build([row("result", "a", "merge", 86400 * 2, result="recorded")])
        self.assertEqual((p["today"], p["recordedToday"]), ({}, 0))

    def test_mode_age_and_recent_order(self):
        rows = [row("result", f"b{i}", "merge", 1000 - i * 100, result="recorded") for i in range(10)]
        p = build(rows)
        self.assertEqual(p["mode"], "on")
        self.assertEqual(p["lastTickAgeS"], 100)
        self.assertEqual(len(p["recent"]), 8)
        self.assertEqual(p["recent"][0]["branch"], "b9")
        self.assertEqual(p["recent"][0]["reason"], "Automated check: merge")

    def test_dry_run_is_reported_as_the_mode(self):
        self.assertEqual(build([row("intent", "a", "merge", 5, mode="dry-run", result="dry-run: not executed")])["mode"], "dry-run")

    def test_index_and_timer_flow_through(self):
        p = build(index={"branches": 7, "builtAt": ISO(5)}, timer=False)
        self.assertEqual((p["indexed"]["branches"], p["timerActive"]), (7, False))

    def test_a_failing_reader_never_raises(self):
        def boom(*a, **k):
            raise RuntimeError("x")
        p = vw.build_verifier_worker(env={}, now=NOW, read_rows=boom, read_index=boom, timer=boom, read_sw=boom)
        self.assertEqual(p, {"configured": False})


class Files(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(dir=_ISO_DIR))
        self.env = {"VERIFIER_DISABLED_PATH": str(self.d / "marker"), "VERIFIER_LEDGER_PATH": str(self.d / "l.jsonl"), "VERIFIER_INDEX_PATH": str(self.d / "i.json")}

    def test_default_marker_path_is_the_one_the_worker_reads(self):
        self.assertEqual(vw.switch_path({}), os.path.join(os.path.expanduser("~"), ".local", "state", "pipeline-ops", "verifier-disabled"))
        self.assertEqual(vw.ledger_path({}), os.path.join(os.path.expanduser("~"), ".local", "state", "pipeline-ops", "verifier-ledger.jsonl"))
        self.assertEqual(vw.index_path({}), os.path.join(os.path.expanduser("~"), ".local", "state", "pipeline-ops", "branch-index.json"))

    def test_switch_round_trip_and_idempotence(self):
        self.assertEqual(vw.read_switch(self.env), {"disabled": False, "disabledAt": None})
        off = vw.set_enabled(False, self.env, now=NOW)
        self.assertTrue(off["disabled"] and off["disabledAt"].startswith("2027-01-15T08:00:00"))
        self.assertEqual(vw.read_switch(self.env), off)
        self.assertEqual(vw.set_enabled(True, self.env), {"disabled": False, "disabledAt": None})
        self.assertEqual(vw.set_enabled(True, self.env), {"disabled": False, "disabledAt": None})
        self.assertFalse((self.d / "marker").exists())

    def test_a_hand_made_empty_marker_still_means_off_and_a_directory_means_on(self):
        (self.d / "marker").write_text("")
        self.assertEqual(vw.read_switch(self.env), {"disabled": True, "disabledAt": None})
        (self.d / "marker").unlink()
        (self.d / "marker").mkdir()
        self.assertFalse(vw.read_switch(self.env)["disabled"])

    def test_ledger_tail_skips_torn_and_foreign_lines(self):
        (self.d / "l.jsonl").write_text('{"branch":"a"}\nnot json\n[1,2]\n\n{"branch":"b"}\n{"bra')
        self.assertEqual([r["branch"] for r in vw.read_ledger_tail(str(self.d / "l.jsonl"))], ["a", "b"])
        self.assertEqual(vw.read_ledger_tail(str(self.d / "missing")), [])

    def test_ledger_tail_drops_the_partial_first_line_of_a_seek(self):
        lines = "".join(json.dumps({"branch": f"b{i}", "pad": "x" * 50}) + "\n" for i in range(50))
        (self.d / "l.jsonl").write_text(lines)
        rows = vw.read_ledger_tail(str(self.d / "l.jsonl"), max_bytes=400)
        self.assertTrue(0 < len(rows) < 50)
        self.assertEqual(rows[-1]["branch"], "b49")

    def test_index_count_is_cached_by_mtime_and_size_and_tolerates_junk(self):
        p = self.d / "i.json"
        p.write_text(json.dumps({"entries": [{}, {}], "builtAt": "t"}))
        self.assertEqual(vw.read_index_count(str(p)), {"branches": 2, "builtAt": "t"})
        p.write_text(json.dumps({"entries": [{}, {}, {}], "builtAt": "t"}))
        self.assertEqual(vw.read_index_count(str(p))["branches"], 3)
        p.write_text("{nope")
        self.assertIsNone(vw.read_index_count(str(p)))
        self.assertIsNone(vw.read_index_count(str(self.d / "absent")))

    def test_index_is_not_reread_while_the_file_is_unchanged(self):
        p = self.d / "i.json"
        p.write_text(json.dumps({"entries": [{}], "builtAt": "t"}))
        vw.read_index_count(str(p))
        with mock.patch.object(vw.json, "load", side_effect=AssertionError("re-read")):
            self.assertEqual(vw.read_index_count(str(p))["branches"], 1)

    def test_timer_state(self):
        def run(out=None, exc=None):
            def f(*a, **k):
                if exc:
                    raise exc
                return subprocess.CompletedProcess(a, 0, stdout=out)
            return f
        self.assertIs(vw.timer_state(run("active\n")), True)
        self.assertIs(vw.timer_state(run("inactive\n")), False)
        self.assertIs(vw.timer_state(run("weird\n")), None)
        self.assertIs(vw.timer_state(run(exc=OSError())), None)
        self.assertIs(vw.timer_state(run(exc=subprocess.TimeoutExpired("x", 1))), None)


class Routes(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self.marker = Path(os.environ["VERIFIER_DISABLED_PATH"])
        self.addCleanup(lambda: self.marker.exists() and self.marker.unlink())

    def test_get_is_json_and_hidden_without_a_trace(self):
        with mock.patch.object(vw.subprocess, "run", return_value=subprocess.CompletedProcess([], 3, stdout="inactive\n")):
            r = self.client.get("/api/branch-verifier")
        self.assertEqual((r.status_code, r.get_json()), (200, {"configured": False}))

    def test_get_reports_a_running_timer_through_the_real_subprocess_hook(self):
        with mock.patch.object(vw.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="active\n")):
            p = self.client.get("/api/branch-verifier").get_json()
        self.assertEqual((p["configured"], p["timerActive"]), (True, True))

    def test_post_off_then_on(self):
        r = self.client.post("/api/branch-verifier/enabled", json={"enabled": False})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["switch"]["disabled"] and self.marker.is_file())
        r = self.client.post("/api/branch-verifier/enabled", json={"enabled": True})
        self.assertFalse(r.get_json()["switch"]["disabled"] or self.marker.exists())

    def test_bad_bodies_are_400_and_write_nothing(self):
        for body in ({}, {"enabled": "yes"}, {"enabled": 1}, [True], None):
            r = self.client.post("/api/branch-verifier/enabled", json=body) if body is not None else self.client.post("/api/branch-verifier/enabled", data="x")
            self.assertEqual(r.status_code, 400, body)
        self.assertFalse(self.marker.exists())

    def test_a_filesystem_failure_is_a_500_with_a_reason(self):
        with mock.patch.object(vw, "set_enabled", side_effect=OSError("disk full")):
            r = self.client.post("/api/branch-verifier/enabled", json={"enabled": False})
        self.assertEqual(r.status_code, 500)
        self.assertIn("disk full", r.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
