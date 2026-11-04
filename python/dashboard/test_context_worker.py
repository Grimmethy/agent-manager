"""The Workers tab's payload for the two context workers (routes/context_worker.py), 2026-11-04.

Everything the route reads is faked or lives in a temp dir: no real ledger, no real drain, no network.
Run: .venv/bin/python -m unittest python.dashboard.test_context_worker -v   (from the repo root)
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
from routes import context_worker as cw  # noqa: E402

_ISO_DIR = tempfile.mkdtemp(prefix="context-worker-tests-")
_ISO_ENV = mock.patch.dict(os.environ, {"HOME": _ISO_DIR, "AGENT_MANAGER_CONTEXT_OPS_STATE_DIR": os.path.join(_ISO_DIR, "state"),
                                        "CONTEXT_MAP_DISABLED_PATH": os.path.join(_ISO_DIR, "map-marker"), "CONTEXT_MEMORY_DISABLED_PATH": os.path.join(_ISO_DIR, "memory-marker")})


def setUpModule():
    # Every test runs with HOME and every state path in a temp dir: even a broken rule can only ever write here, never the real ~/.local/state/pipeline-ops.
    _ISO_ENV.start()


def tearDownModule():
    _ISO_ENV.stop()


NOW = 1_800_000_000.0                       # 2027-01-15T08:00:00Z
ISO = lambda secs_ago: datetime.fromtimestamp(NOW - secs_ago, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
ITEMS = {"map": "codebase-map", "memory": "memory-index"}
SWITCH_ON = {"disabled": False, "disabledAt": None}
TRIG = {"state": "listening", "endedAt": "2027-01-15T07:59:00Z", "endedAgeS": 60, "stopped": "idle", "iterations": 1}


def pair(name, outcome, ago, mode="dry-run", executed=None, detail=None, result_detail=None, result_outcome=None):
    """An intent line then its result line, as src/ledger.js withIntent writes them (a dry run's result detail is {executed: false})."""
    item = ITEMS[name]
    idetail = {"mode": mode, "factsKey": "k-" + outcome, **(detail or {})}
    dry = executed is False or (executed is None and mode == "dry-run")
    rdetail = {"executed": False} if dry else (result_detail if result_detail is not None else {"ok": True})
    return [{"kind": "intent", "at": ISO(ago + 1), "loop": name, "item": item, "outcome": outcome, "detail": idetail},
            {"kind": "result", "at": ISO(ago), "loop": name, "item": item, "outcome": result_outcome or outcome, "detail": rdetail}]


def build(name="map", rows=(), trigger=TRIG, env=None, switch=SWITCH_ON, now=NOW):
    return cw.build_context_worker(name, env=env or {}, now=now, read_rows=lambda p: list(rows), trigger=lambda: trigger, read_sw=lambda n, e: switch)


class Paths(unittest.TestCase):
    def test_defaults_are_pinned(self):
        env = {"HOME": "/h"}
        self.assertEqual(cw.ledger_path("map", env), "/h/.local/state/pipeline-ops/context-map-ledger.jsonl")
        self.assertEqual(cw.ledger_path("memory", env), "/h/.local/state/pipeline-ops/context-memory-ledger.jsonl")
        self.assertEqual(cw.switch_path("map", env), "/h/.local/state/pipeline-ops/context-map-disabled")
        self.assertEqual(cw.switch_path("memory", env), "/h/.local/state/pipeline-ops/context-memory-disabled")

    def test_the_state_override_moves_the_ledger_but_not_the_marker(self):
        env = {"HOME": "/h", "AGENT_MANAGER_CONTEXT_OPS_STATE_DIR": "/s"}
        self.assertEqual(cw.ledger_path("map", env), "/s/context-map-ledger.jsonl")
        self.assertEqual(cw.switch_path("map", env), "/h/.local/state/pipeline-ops/context-map-disabled")

    def test_the_marker_overrides_are_per_worker_and_a_blank_one_is_ignored(self):
        env = {"HOME": "/h", "CONTEXT_MAP_DISABLED_PATH": "/x/m", "CONTEXT_MEMORY_DISABLED_PATH": "  "}
        self.assertEqual(cw.switch_path("map", env), "/x/m")
        self.assertEqual(cw.switch_path("memory", env), "/h/.local/state/pipeline-ops/context-memory-disabled")
        self.assertEqual(cw.state_dir({"HOME": "/h", "AGENT_MANAGER_CONTEXT_OPS_STATE_DIR": "   "}), "/h/.local/state/pipeline-ops")


class Payload(unittest.TestCase):
    def test_nothing_at_all_is_not_configured(self):
        for name in ITEMS:
            self.assertEqual(build(name, trigger=None), {"configured": False})

    def test_any_single_trace_is_enough(self):
        self.assertTrue(build()["configured"])
        self.assertTrue(build(trigger=None, rows=pair("map", "NOTHING-TO-FIX", 5))["configured"])
        self.assertTrue(build(trigger=None, switch={"disabled": True, "disabledAt": "x"})["configured"])

    def test_shape_and_identity(self):
        p = build("memory", rows=pair("memory", "OK", 30, detail={"outcomes": ["OK"]}))
        self.assertEqual((p["name"], p["worker"], p["enabled"], p["mode"], p["decisions"]), ("memory", "context-memory", True, "dry-run", 1))
        self.assertEqual(p["trigger"], TRIG)
        self.assertEqual((p["lastTickAt"], p["lastTickAgeS"]), (ISO(30), 30))

    def test_a_decision_is_a_result_line_paired_with_its_intent_line(self):
        rows = pair("map", "FILE-TASK", 100) + [{"kind": "intent", "at": ISO(5), "loop": "map", "item": "codebase-map", "outcome": "FILE-TASK", "detail": {"mode": "on"}}]
        p = build(rows=rows)
        self.assertEqual(p["decisions"], 1)                   # the trailing intent has no result yet
        self.assertEqual(p["mode"], "on")                      # but it is the newest word on the mode
        other = build("memory", rows=pair("map", "FILE-TASK", 100))
        self.assertEqual(other["decisions"], 0)               # a line for another item is not this worker's

    def test_today_counts_dry_run_twins_apart_and_never_as_acted(self):
        rows = (pair("map", "FILE-TASK", 400, mode="dry-run") + pair("map", "FILE-TASK", 300, mode="on", executed=True, result_detail={"taskId": "t"}) + pair("map", "SKIP-DUPLICATE", 200, mode="on", executed=True)
                + pair("map", "FILE-TASK", 100, mode="on", executed=False))
        t = build(rows=rows)
        self.assertEqual(t["today"], {"decisions": 2, "byOutcome": {"FILE-TASK": 1, "SKIP-DUPLICATE": 1}, "dryRun": {"decisions": 2, "byOutcome": {"FILE-TASK": 2}}})
        self.assertEqual(t["actedToday"], 2)

    def test_a_decision_from_yesterday_is_not_today(self):
        t = build(rows=pair("map", "FILE-TASK", 90_000, mode="on", executed=True))
        self.assertEqual((t["today"]["decisions"], t["actedToday"], t["decisions"]), (0, 0, 1))

    def test_an_error_result_is_counted_as_an_error_and_not_as_acted(self):
        rows = pair("map", "FILE-TASK", 120, mode="on", executed=True, result_outcome="error", result_detail={"error": "queue down"})
        p = build(rows=rows)
        self.assertEqual(p["actedToday"], 0)
        self.assertEqual(p["errors"], {"count": 1, "last": {"at": ISO(120), "error": "queue down"}})
        self.assertEqual(p["today"]["byOutcome"], {"error": 1})
        self.assertEqual(p["lastDecision"]["summary"], "queue down")
        self.assertEqual(build(rows=pair("map", "OK", 5))["errors"], {"count": 0, "last": None})

    def test_a_hold_carries_its_question_and_recommendation_and_only_the_current_one_shows(self):
        old = pair("map", "HOLD-FOR-OWNER", 500, detail={"question": "old q?", "recommendation": "old r"})
        now_hold = pair("map", "HOLD-FOR-OWNER", 200, detail={"question": "Which checkout?", "recommendation": "Use the core."})
        p = build(rows=old + now_hold)
        self.assertEqual(p["holdCount"], 1)
        self.assertEqual(p["holds"], [{"question": "Which checkout?", "recommendation": "Use the core.", "at": ISO(200), "ageS": 200}])
        resolved = build(rows=old + now_hold + pair("map", "FILE-TASK", 50))
        self.assertEqual((resolved["holdCount"], resolved["holds"]), (0, []))
        missing = build(rows=pair("map", "HOLD-FOR-OWNER", 10, detail={"question": "q?"}))
        self.assertEqual((missing["holds"][0]["question"], missing["holds"][0]["recommendation"]), ("q?", None))

    def test_a_hold_question_may_come_from_the_result_detail(self):
        rows = pair("memory", "HOLD-FOR-OWNER", 10, mode="on", executed=True, result_detail={"question": "from result", "recommendation": "r"})
        hold = build("memory", rows=rows)["holds"][0]
        self.assertEqual((hold["question"], hold["recommendation"]), ("from result", "r"))

    def test_the_map_findings_come_from_the_newest_intent_that_has_a_hash(self):
        older = pair("map", "FILE-TASK", 900, detail={"hash": "h1", "findings": 3, "fixRanges": 1, "rewriteRows": 2, "suggestions": {"anchors": 0, "rows": 0}})
        newer = pair("map", "FILE-TASK", 300, detail={"hash": "h2", "findings": 14, "fixRanges": 0, "rewriteRows": 14, "suggestions": {"anchors": 5, "rows": 3}})
        hold = pair("map", "HOLD-FOR-OWNER", 100, detail={"question": "q", "recommendation": "r"})
        f = build(rows=older + newer + hold)["findings"]
        self.assertEqual((f["hash"], f["findings"], f["fixRanges"], f["rewriteRows"], f["suggestions"], f["at"]), ("h2", 14, 0, 14, {"anchors": 5, "rows": 3}, ISO(301)))
        self.assertIsNone(build(rows=hold)["findings"])

    def test_recent_is_the_last_eight_newest_first_with_a_summary(self):
        rows = []
        for i in range(10):
            rows += pair("map", "FILE-TASK", 1000 - i * 10, detail={"findings": i, "fixRanges": 0, "rewriteRows": i})
        recent = build(rows=rows)["recent"]
        self.assertEqual(len(recent), 8)
        self.assertEqual(recent[0]["summary"], "9 findings (0 fix, 9 rewrite)")
        self.assertEqual(recent[-1]["at"], ISO(1000 - 2 * 10))
        mem = build("memory", rows=pair("memory", "OVER-BUDGET", 5, detail={"outcomes": ["OVER-BUDGET", "DANGLING"]}))["recent"][0]
        self.assertEqual((mem["summary"], mem["executed"], mem["mode"]), ("OVER-BUDGET, DANGLING", False, "dry-run"))
        self.assertEqual(build(rows=pair("map", "NOTHING-TO-FIX", 5))["recent"][0]["summary"], "NOTHING-TO-FIX")

    def test_last_decision_and_the_switch_are_reported(self):
        p = build(rows=pair("map", "FILE-TASK", 40, mode="on", executed=True), switch={"disabled": True, "disabledAt": "2027-01-15T07:00:00.000Z"})
        self.assertEqual(p["lastDecision"], {"at": ISO(40), "outcome": "FILE-TASK", "mode": "on", "executed": True, "summary": "FILE-TASK"})
        self.assertEqual((p["enabled"], p["switch"]), (False, {"disabled": True, "disabledAt": "2027-01-15T07:00:00.000Z"}))
        self.assertIsNone(build()["lastDecision"])

    def test_torn_or_odd_lines_and_an_unreadable_collaborator_never_raise(self):
        rows = pair("map", "FILE-TASK", 40) + [{"kind": "result"}, {"item": "codebase-map"}, {"kind": "intent", "item": "codebase-map", "detail": "not a dict"}, {"kind": "result", "item": "codebase-map", "detail": 5}]
        self.assertEqual(build(rows=rows)["decisions"], 2)

        def boom(*a):
            raise RuntimeError("nope")
        p = cw.build_context_worker("map", env={}, now=NOW, read_rows=boom, trigger=boom, read_sw=boom)
        self.assertEqual(p, {"configured": False})


class Pairing(unittest.TestCase):
    def test_a_newer_intent_replaces_an_older_one_that_never_got_its_result(self):
        old = {"kind": "intent", "at": ISO(500), "loop": "map", "item": "codebase-map", "outcome": "FILE-TASK", "detail": {"mode": "dry-run"}}
        new = {"kind": "intent", "at": ISO(100), "loop": "map", "item": "codebase-map", "outcome": "FILE-TASK", "detail": {"mode": "on"}}
        result = {"kind": "result", "at": ISO(99), "loop": "map", "item": "codebase-map", "outcome": "FILE-TASK", "detail": {"taskId": "t"}}
        ds = cw.decisions([old, new, result], "codebase-map")
        self.assertEqual([(d["mode"], d["executed"]) for d in ds], [("on", True)])

    def test_an_intent_pairs_with_one_result_only(self):
        intent = {"kind": "intent", "at": ISO(500), "loop": "map", "item": "codebase-map", "outcome": "FILE-TASK", "detail": {"mode": "on"}}
        r1 = {"kind": "result", "at": ISO(499), "loop": "map", "item": "codebase-map", "outcome": "FILE-TASK", "detail": {"ok": True}}
        r2 = {"kind": "result", "at": ISO(10), "loop": "map", "item": "codebase-map", "outcome": "FILE-TASK", "detail": {"ok": True}}
        ds = cw.decisions([intent, r1, r2], "codebase-map")
        self.assertEqual([d["mode"] for d in ds], ["on", None])

    def test_dry_run_is_a_dry_run_mode_or_an_unexecuted_result_whichever_is_seen(self):
        rows = pair("map", "FILE-TASK", 60, mode="dry-run", executed=True, result_detail={"ok": True})
        t = build(rows=rows)["today"]
        self.assertEqual((t["decisions"], t["dryRun"]["decisions"]), (0, 1))

    def test_a_summary_with_missing_counts_defaults_them_to_zero(self):
        self.assertEqual(build(rows=pair("map", "FILE-TASK", 5, detail={"findings": 3}))["recent"][0]["summary"], "3 findings (0 fix, 0 rewrite)")

    def test_a_hold_stamped_in_the_future_has_an_age_of_zero_not_a_negative_one(self):
        rows = pair("map", "HOLD-FOR-OWNER", -300, detail={"question": "q?", "recommendation": "r"})
        self.assertEqual(build(rows=rows)["holds"][0]["ageS"], 0)


class Switch(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ctx-switch-")
        self.env = {"HOME": self.dir}

    def test_marker_present_means_off_with_its_time_and_a_bad_marker_still_means_off(self):
        self.assertEqual(cw.read_switch("map", self.env), {"disabled": False, "disabledAt": None})
        path = cw.switch_path("map", self.env)
        os.makedirs(os.path.dirname(path))
        Path(path).write_text('{"disabledAt":"2027-01-15T07:00:00.000Z"}\n')
        self.assertEqual(cw.read_switch("map", self.env), {"disabled": True, "disabledAt": "2027-01-15T07:00:00.000Z"})
        Path(path).write_text("not json")
        self.assertEqual(cw.read_switch("map", self.env), {"disabled": True, "disabledAt": None})
        Path(path).write_text('{"disabledAt": 5}')
        self.assertEqual(cw.read_switch("map", self.env), {"disabled": True, "disabledAt": None})

    def test_set_enabled_round_trip_is_atomic_and_idempotent(self):
        off = cw.set_enabled("memory", False, self.env, now=NOW)
        self.assertEqual(off, {"disabled": True, "disabledAt": "2027-01-15T08:00:00.000Z"})
        self.assertEqual(cw.read_switch("memory", self.env), off)
        self.assertEqual(cw.set_enabled("memory", False, self.env, now=NOW), off)
        self.assertEqual(os.listdir(os.path.dirname(cw.switch_path("memory", self.env))), ["context-memory-disabled"])
        self.assertEqual(cw.set_enabled("memory", True, self.env), {"disabled": False, "disabledAt": None})
        self.assertEqual(cw.set_enabled("memory", True, self.env), {"disabled": False, "disabledAt": None})
        self.assertEqual(cw.read_switch("memory", self.env), {"disabled": False, "disabledAt": None})

    def test_the_two_workers_switch_independently(self):
        cw.set_enabled("map", False, self.env, now=NOW)
        self.assertTrue(cw.read_switch("map", self.env)["disabled"])
        self.assertFalse(cw.read_switch("memory", self.env)["disabled"])

    def test_a_filesystem_error_is_raised_to_the_caller(self):
        blocker = os.path.join(self.dir, "file")
        Path(blocker).write_text("x")
        with self.assertRaises(OSError):
            cw.set_enabled("map", False, {"HOME": self.dir, "CONTEXT_MAP_DISABLED_PATH": os.path.join(blocker, "sub", "marker")}, now=NOW)


class Routes(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_an_unknown_worker_is_a_404_for_get_and_post(self):
        self.assertEqual(self.client.get("/api/context-worker/other").status_code, 404)
        r = self.client.post("/api/context-worker/other/enabled", json={"enabled": False})
        self.assertEqual(r.status_code, 404)

    def test_get_with_no_files_is_not_configured_and_writes_nothing(self):
        before = sorted(os.listdir(_ISO_DIR))
        r = self.client.get("/api/context-worker/map")
        self.assertEqual((r.status_code, r.get_json()), (200, {"configured": False}))
        self.assertEqual(sorted(os.listdir(_ISO_DIR)), before)

    def test_post_writes_and_removes_the_marker_only_inside_the_temp_dir(self):
        marker = cw.switch_path("memory")
        self.assertTrue(marker.startswith(_ISO_DIR), marker)           # never the real state directory
        r = self.client.post("/api/context-worker/memory/enabled", json={"enabled": False})
        self.assertEqual((r.status_code, r.get_json()["enabled"], r.get_json()["switch"]["disabled"]), (200, False, True))
        self.assertTrue(os.path.isfile(marker))
        self.assertTrue(self.client.get("/api/context-worker/memory").get_json()["switch"]["disabled"])
        r = self.client.post("/api/context-worker/memory/enabled", json={"enabled": True})
        self.assertEqual((r.status_code, r.get_json()["switch"]["disabled"]), (200, False))
        self.assertFalse(os.path.exists(marker))

    def test_a_bad_body_is_a_400_and_writes_nothing(self):
        marker = cw.switch_path("map")
        for body in (None, [], {"enabled": "yes"}, {"enabled": 1}, {}):
            r = self.client.post("/api/context-worker/map/enabled", json=body) if body is not None else self.client.post("/api/context-worker/map/enabled", data="x", content_type="text/plain")
            self.assertEqual(r.status_code, 400, body)
        self.assertFalse(os.path.exists(marker))

    def test_a_filesystem_error_on_post_is_a_500_with_the_reason(self):
        blocker = os.path.join(_ISO_DIR, "blocker-file")
        Path(blocker).write_text("x")
        with mock.patch.dict(os.environ, {"CONTEXT_MAP_DISABLED_PATH": os.path.join(blocker, "sub", "marker")}):
            r = self.client.post("/api/context-worker/map/enabled", json={"enabled": False})
        self.assertEqual(r.status_code, 500)
        self.assertIn("could not change the switch", r.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
