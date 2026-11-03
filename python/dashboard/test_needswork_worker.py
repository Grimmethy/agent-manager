"""The Workers tab's Needs-Work worker card payload (routes/needswork_worker.py), 2026-11-03.

Everything the route reads is faked or lives in a temp dir: no real ledger, no real drain, no network.
Run: .venv/bin/python -m unittest python.dashboard.test_needswork_worker -v   (from the repo root)
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
from routes import needswork_worker as nw  # noqa: E402

_ISO_DIR = tempfile.mkdtemp(prefix="needswork-worker-tests-")
_ISO_ENV = mock.patch.dict(os.environ, {"HOME": _ISO_DIR, "NEEDSWORK_DISABLED_PATH": os.path.join(_ISO_DIR, "marker"), "NEEDSWORK_LEDGER_PATH": os.path.join(_ISO_DIR, "ledger.jsonl")})


def setUpModule():
    # Every test runs with HOME and every state path in a temp dir: even a broken rule can only ever write here, never the real ~/.local/state/pipeline-ops.
    _ISO_ENV.start()


def tearDownModule():
    _ISO_ENV.stop()


NOW = 1_800_000_000.0                       # 2027-01-15T08:00:00Z
ISO = lambda secs_ago: datetime.fromtimestamp(NOW - secs_ago, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731


def row(phase, branch, outcome, ago, mode="on", result=None, sha="s1", project="alpha", **extra):
    r = {"at": ISO(ago), "mode": mode, "project": project, "branch": branch, "sha": sha, "outcome": outcome, "reason": "because " + str(outcome), "phase": phase}
    if result is not None:
        r["result"] = result
    return {**r, **extra}


TRIG = {"state": "idle", "endedAt": "2027-01-15T07:59:00Z", "endedAgeS": 60, "stopped": "idle", "iterations": 1}


def build(rows=(), trigger=TRIG, env=None, switch=None):
    return nw.build_needswork_worker(env=env or {}, now=NOW, read_rows=lambda p: list(rows), trigger=lambda: trigger,
                                     read_sw=(lambda e: switch) if switch is not None else (lambda e: {"disabled": False, "disabledAt": None}))


class Payload(unittest.TestCase):
    def test_nothing_at_all_is_not_configured(self):
        self.assertEqual(build(trigger=None), {"configured": False})

    def test_any_single_trace_is_enough(self):
        self.assertTrue(build()["configured"])
        self.assertTrue(build(trigger=None, rows=[row("intent", "a", "HOLD-FOR-OWNER", 5, mode="dry-run")])["configured"])
        self.assertTrue(build(trigger=None, switch={"disabled": True, "disabledAt": "x"})["configured"])

    def test_result_replaces_its_intent_and_todays_results_are_counted_by_outcome(self):
        rows = [row("intent", "a", "FILE-REPLACEMENT-TASK", 100, result="planned"), row("result", "a", "FILE-REPLACEMENT-TASK", 99, result="filed: t1"),
                row("intent", "b", "ESCALATE-MECHANISM", 90, result="planned"), row("result", "b", "ESCALATE-MECHANISM", 89, result="failed: HTTP 500"),
                row("result", "c", None, 70, result="no action"),
                row("intent", "e", "HOLD-FOR-OWNER", 60, result="planned")]          # an intent still open: not a result, not counted
        p = build(rows)
        self.assertEqual(p["decisions"], 4)
        self.assertEqual(p["today"], {"FILE-REPLACEMENT-TASK": 1, "ESCALATE-MECHANISM": 1, "no action": 1})
        self.assertEqual((p["actedToday"], p["failedToday"]), (2, 1))   # acted = live results that did not fail or refuse

    def test_dry_run_results_count_as_decisions_but_never_as_acted(self):
        p = build([row("result", "a", "HOLD-FOR-OWNER", 5, mode="dry-run", result="dry-run: not executed")])
        self.assertEqual((p["today"], p["actedToday"], p["failedToday"]), ({"HOLD-FOR-OWNER": 1}, 0, 0))

    def test_a_dry_run_row_is_never_acted_whatever_its_result_says(self):
        p = build([row("result", "a", "REDRAFT-DELEGATED", 5, mode="dry-run", result="waiting for the redraft sweep")])
        self.assertEqual((p["today"], p["actedToday"]), ({"REDRAFT-DELEGATED": 1}, 0))

    def test_the_same_branch_in_another_project_is_its_own_decision_even_with_an_open_intent(self):
        rows = [row("intent", "a", "HOLD-FOR-OWNER", 100, result="planned"), row("result", "a", "HOLD-FOR-OWNER", 90, project="beta")]
        self.assertEqual(build(rows)["decisions"], 2)

    def test_a_second_intent_of_the_same_branch_does_not_replace_the_open_one(self):
        rows = [row("intent", "a", "HOLD-FOR-OWNER", 100, result="planned"), row("intent", "a", "HOLD-FOR-OWNER", 90, result="planned")]
        self.assertEqual(build(rows)["decisions"], 2)

    def test_backlog_keeps_two_projects_with_the_same_branch_name_apart(self):
        rows = [row("result", "a", "HOLD-FOR-OWNER", 100), row("result", "a", "FILE-REPLACEMENT-TASK", 90, project="beta", result="filed: t")]
        self.assertEqual(build(rows)["backlog"], {"total": 2, "byOutcome": {"HOLD-FOR-OWNER": 1, "FILE-REPLACEMENT-TASK": 1}})

    def test_the_mode_is_the_newest_rows_mode(self):
        rows = [row("result", "a", "REDRAFT-DELEGATED", 500, mode="dry-run"), row("result", "b", "REDRAFT-DELEGATED", 100, mode="on")]
        self.assertEqual(build(rows)["mode"], "on")

    def test_refused_counts_as_failed_not_acted(self):
        p = build([row("result", "a", "FILE-REPLACEMENT-TASK", 5, result="refused: already filed")])
        self.assertEqual((p["actedToday"], p["failedToday"]), (0, 1))

    def test_a_new_head_of_the_same_branch_is_its_own_decision_and_so_is_another_project(self):
        rows = [row("result", "a", "REDRAFT-DELEGATED", 100, sha="s1"), row("result", "a", "REDRAFT-DELEGATED", 50, sha="s2"), row("result", "a", "REDRAFT-DELEGATED", 40, project="beta")]
        self.assertEqual(build(rows)["decisions"], 3)

    def test_a_result_for_another_head_does_not_replace_an_open_intent(self):
        rows = [row("intent", "a", "REDRAFT-DELEGATED", 100, result="planned", sha="s1"), row("result", "a", "REDRAFT-DELEGATED", 90, sha="s2")]
        self.assertEqual(build(rows)["decisions"], 2)

    def test_lines_without_a_branch_are_not_decisions(self):
        rows = [{"at": ISO(5), "mode": "on", "phase": "result", "result": "x"}, row("result", "a", "REDRAFT-DELEGATED", 4)]
        self.assertEqual(build(rows)["decisions"], 1)

    def test_yesterdays_results_are_not_today(self):
        p = build([row("result", "a", "REDRAFT-DELEGATED", 86400 * 2, result="waiting")])
        self.assertEqual((p["today"], p["actedToday"]), ({}, 0))

    def test_backlog_counts_the_newest_outcome_of_each_branch(self):
        rows = [row("result", "a", "REDRAFT-DELEGATED", 300), row("result", "a", "FILE-REPLACEMENT-TASK", 200, result="filed: t"),
                row("result", "b", "HOLD-FOR-OWNER", 150), row("result", "c", "HOLD-FOR-OWNER", 100), row("result", "d", None, 90)]
        b = build(rows)["backlog"]
        self.assertEqual(b, {"total": 3, "byOutcome": {"FILE-REPLACEMENT-TASK": 1, "HOLD-FOR-OWNER": 2}})

    def test_holds_carry_the_question_and_recommendation_oldest_first(self):
        rows = [row("result", "young", "HOLD-FOR-OWNER", 100, question="Merge or discard?", recommendation="discard: rival merged"),
                row("result", "old", "HOLD-FOR-OWNER", 5000, question="Keep which?", recommendation="keep a"),
                row("result", "noq", "HOLD-FOR-OWNER", 50)]
        p = build(rows)
        self.assertEqual([h["branch"] for h in p["holds"]], ["old", "young", "noq"])
        self.assertEqual(p["holds"][0], {"branch": "old", "project": "alpha", "question": "Keep which?", "recommendation": "keep a", "at": ISO(5000), "ageS": 5000})
        self.assertEqual(p["holds"][2]["question"], "because HOLD-FOR-OWNER")      # no question field: the reason stands in
        self.assertEqual(p["holdCount"], 3)

    def test_a_later_decision_supersedes_a_hold_and_an_open_intent_is_not_a_hold(self):
        rows = [row("result", "a", "HOLD-FOR-OWNER", 500, question="q"), row("result", "a", "FILE-REPLACEMENT-TASK", 100, result="filed: t"),
                row("intent", "b", "HOLD-FOR-OWNER", 50, question="q2", result="planned")]
        p = build(rows)
        self.assertEqual((p["holds"], p["holdCount"]), ([], 0))

    def test_holds_are_capped_but_counted(self):
        rows = [row("result", f"b{i}", "HOLD-FOR-OWNER", 1000 + i, question="q") for i in range(nw.HOLDS_CAP + 3)]
        p = build(rows)
        self.assertEqual((len(p["holds"]), p["holdCount"]), (nw.HOLDS_CAP, nw.HOLDS_CAP + 3))

    def test_mode_age_and_recent_order(self):
        rows = [row("result", f"b{i}", "REDRAFT-DELEGATED", 1000 - i * 100, result="waiting") for i in range(10)]
        p = build(rows)
        self.assertEqual(p["mode"], "on")
        self.assertEqual(p["lastTickAgeS"], 100)
        self.assertEqual(len(p["recent"]), 8)
        self.assertEqual(p["recent"][0]["branch"], "b9")
        self.assertEqual(p["recent"][0]["reason"], "because REDRAFT-DELEGATED")

    def test_dry_run_is_reported_as_the_mode(self):
        self.assertEqual(build([row("intent", "a", "HOLD-FOR-OWNER", 5, mode="dry-run", result="dry-run: not executed")])["mode"], "dry-run")

    def test_trigger_flows_through(self):
        p = build(trigger={"state": "backlog", "endedAgeS": 5})
        self.assertEqual(p["trigger"], {"state": "backlog", "endedAgeS": 5})
        self.assertIsNone(build(trigger=None, rows=[row("result", "a", None, 5)])["trigger"])

    def test_a_failing_reader_never_raises(self):
        def boom(*a, **k):
            raise RuntimeError("x")
        p = nw.build_needswork_worker(env={}, now=NOW, read_rows=boom, trigger=boom, read_sw=boom)
        self.assertEqual(p, {"configured": False})


class Files(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(dir=_ISO_DIR))
        self.env = {"NEEDSWORK_DISABLED_PATH": str(self.d / "marker"), "NEEDSWORK_LEDGER_PATH": str(self.d / "l.jsonl")}

    def test_default_paths_are_the_ones_the_worker_uses(self):
        base = os.path.join(os.path.expanduser("~"), ".local", "state", "pipeline-ops")
        self.assertEqual(nw.switch_path({}), os.path.join(base, "needswork-disabled"))
        self.assertEqual(nw.ledger_path({}), os.path.join(base, "needswork-ledger.jsonl"))
        self.assertEqual(nw.switch_path({"HOME": "/h"}), "/h/.local/state/pipeline-ops/needswork-disabled")

    def test_switch_round_trip_and_idempotence(self):
        self.assertEqual(nw.read_switch(self.env), {"disabled": False, "disabledAt": None})
        off = nw.set_enabled(False, self.env, now=NOW)
        self.assertTrue(off["disabled"] and off["disabledAt"].startswith("2027-01-15T08:00:00"))
        self.assertEqual(nw.read_switch(self.env), off)
        self.assertEqual(nw.set_enabled(True, self.env), {"disabled": False, "disabledAt": None})
        self.assertEqual(nw.set_enabled(True, self.env), {"disabled": False, "disabledAt": None})
        self.assertFalse((self.d / "marker").exists())

    def test_a_marker_time_that_is_not_text_is_ignored(self):
        (self.d / "marker").write_text('{"disabledAt": 5}')
        self.assertEqual(nw.read_switch(self.env), {"disabled": True, "disabledAt": None})

    def test_a_hand_made_empty_marker_still_means_off_and_a_directory_means_on(self):
        (self.d / "marker").write_text("")
        self.assertEqual(nw.read_switch(self.env), {"disabled": True, "disabledAt": None})
        (self.d / "marker").unlink()
        (self.d / "marker").mkdir()
        self.assertFalse(nw.read_switch(self.env)["disabled"])

    def test_the_ledger_is_read_with_the_shared_tail_reader(self):
        (self.d / "l.jsonl").write_text('{"branch":"a"}\nnot json\n{"branch":"b"}\n{"bra')
        self.assertEqual([r["branch"] for r in nw.read_ledger_tail(nw.ledger_path(self.env))], ["a", "b"])


class Routes(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self.marker = Path(os.environ["NEEDSWORK_DISABLED_PATH"])
        self.addCleanup(lambda: self.marker.exists() and self.marker.unlink())

    def test_get_is_json_and_hidden_without_a_trace(self):
        r = self.client.get("/api/needswork-worker")
        self.assertEqual((r.status_code, r.get_json()), (200, {"configured": False}))

    def test_get_reports_the_real_trigger_files_of_this_worker_and_not_the_verifiers(self):
        d = Path(os.environ["HOME"]) / ".local" / "state" / "pipeline-ops"
        d.mkdir(parents=True, exist_ok=True)
        (d / "needswork-trigger.json").write_text(json.dumps({"sig": "s", "endedAt": ISO(5), "backlog": False, "stopped": "idle", "iterations": 2}))
        self.addCleanup(lambda: (d / "needswork-trigger.json").unlink())
        p = self.client.get("/api/needswork-worker").get_json()
        self.assertEqual((p["configured"], p["trigger"]["state"], p["trigger"]["iterations"]), (True, "idle", 2))

    def test_post_off_then_on(self):
        r = self.client.post("/api/needswork-worker/enabled", json={"enabled": False})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["switch"]["disabled"] and self.marker.is_file())
        r = self.client.post("/api/needswork-worker/enabled", json={"enabled": True})
        self.assertFalse(r.get_json()["switch"]["disabled"] or self.marker.exists())

    def test_bad_bodies_are_400_and_write_nothing(self):
        for body in ({}, {"enabled": "yes"}, {"enabled": 1}, [True], None):
            r = self.client.post("/api/needswork-worker/enabled", json=body) if body is not None else self.client.post("/api/needswork-worker/enabled", data="x")
            self.assertEqual(r.status_code, 400, body)
        self.assertFalse(self.marker.exists())

    def test_a_filesystem_failure_is_a_500_with_a_reason(self):
        with mock.patch.object(nw, "set_enabled", side_effect=OSError("disk full")):
            r = self.client.post("/api/needswork-worker/enabled", json={"enabled": False})
        self.assertEqual(r.status_code, 500)
        self.assertIn("disk full", r.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
