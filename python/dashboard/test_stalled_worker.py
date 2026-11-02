"""The Workers tab's Stalled-task worker panel payload (routes/stalled_worker.py), 2026-11-02.

Everything the route reads is faked or lives in a temp dir: no real ledger, no real systemd, no gateway, no network.
Run: .venv/bin/python -m unittest python.dashboard.test_stalled_worker -v   (from the repo root)
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes import stalled_worker as sw  # noqa: E402

NOW = 1_800_000_000.0                       # 2027-01-15T08:00:00Z
ISO = lambda secs_ago: __import__("datetime").datetime.fromtimestamp(NOW - secs_ago, __import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731


def row(phase, task, outcome, ago, mode="dry-run", **extra):
    return {"at": ISO(ago), "mode": mode, "project": "alpha", "taskId": task, "outcome": outcome, "phase": phase, **extra}


METER = {"tokenBudget": {"perHour": 5400000, "used": 1000, "remaining": 5399000, "resetsInSec": 0}, "provider": "claude-subscription", "model": "claude-sonnet-5-5"}
INDEX = {"total": 5, "projects": 2, "builtAt": ISO(30), "topBuckets": [{"state": "blocked", "signature": "s", "count": 3}]}


def build(rows=(), index=INDEX, meter=METER, timer=True, env=None):
    def fetch(url, timeout):
        if isinstance(meter, Exception):
            raise meter
        return meter
    return sw.build_stalled_worker(env=env or {}, now=NOW, read_rows=lambda p: list(rows), read_index=lambda p: index, fetch=fetch, timer=lambda: timer)


class Decisions(unittest.TestCase):
    def test_a_result_line_replaces_its_open_intent_and_a_dry_run_intent_stands_alone(self):
        rows = [row("intent", "t1", "ARCHIVE-DUPLICATE", 50), row("result", "t1", "ARCHIVE-DUPLICATE", 49, mode="on", result="done"),
                row("intent", "t2", "ESCALATE-MECHANISM", 40), row(None, "t3", "ARCHIVE-DUPLICATE", 30, result="refused: x"),
                {"taskId": "no-outcome", "at": ISO(1)}, {"outcome": "X", "at": ISO(1)}]
        ds = sw.decisions(rows)
        self.assertEqual([(d["taskId"], d.get("phase"), d.get("result")) for d in ds], [("t1", "result", "done"), ("t2", "intent", None), ("t3", None, "refused: x")])

    def test_a_second_result_with_no_intent_between_is_a_new_decision(self):
        rows = [row("intent", "t1", "A", 9), row("result", "t1", "A", 8), row("result", "t1", "B", 7)]
        self.assertEqual([d["outcome"] for d in sw.decisions(rows)], ["A", "B"])

    def test_a_refusal_line_is_not_an_open_intent(self):
        rows = [row(None, "t1", "A", 9), row("result", "t1", "B", 8)]
        self.assertEqual([d["outcome"] for d in sw.decisions(rows)], ["A", "B"])


class LedgerTail(unittest.TestCase):
    def test_torn_lines_non_objects_and_missing_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "l.jsonl")
            Path(p).write_text(json.dumps({"a": 1}) + "\n{torn\n123\n\"s\"\n\n" + json.dumps({"b": 2}) + "\n")
            self.assertEqual(sw.read_ledger_tail(p), [{"a": 1}, {"b": 2}])
            self.assertEqual(sw.read_ledger_tail(os.path.join(d, "missing")), [])

    def test_only_the_tail_is_read_and_the_partial_first_line_is_dropped(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "l.jsonl")
            lines = [json.dumps({"n": i, "pad": "x" * 100}) for i in range(100)]
            Path(p).write_text("\n".join(lines) + "\n")
            rows = sw.read_ledger_tail(p, max_bytes=1000)
            self.assertTrue(0 < len(rows) < 100)
            self.assertEqual(rows[-1]["n"], 99)
            self.assertTrue(all(isinstance(r["n"], int) for r in rows))           # the cut first line was not parsed as a row
            self.assertEqual(len(sw.read_ledger_tail(p, max_bytes=10**6)), 100)


class IndexSummary(unittest.TestCase):
    def setUp(self):
        sw._index_cache.update({"key": None, "value": None})

    def write(self, d, entries, built="2027-01-15T07:00:00Z"):
        p = os.path.join(d, "i.json")
        Path(p).write_text(json.dumps({"builtAt": built, "entries": entries}))
        return p

    def test_counts_projects_and_the_top_five_buckets_biggest_first(self):
        es = []
        for n, (state, sig) in enumerate([("blocked", "a")] * 4 + [("blocked", "b")] * 3 + [("needs-clarification", "a")] * 2 + [("blocked", "c")] + [("blocked", "d")] + [("blocked", "e")] + [("blocked", "f")]):
            es.append({"project": "p%d" % (n % 3), "state": state, "failureSignature": sig})
        with tempfile.TemporaryDirectory() as d:
            s = sw.read_index_summary(self.write(d, es))
        self.assertEqual((s["total"], s["projects"], s["builtAt"]), (13, 3, "2027-01-15T07:00:00Z"))
        self.assertEqual([(b["state"], b["signature"], b["count"]) for b in s["topBuckets"]], [("blocked", "a", 4), ("blocked", "b", 3), ("needs-clarification", "a", 2), ("blocked", "c", 1), ("blocked", "d", 1)])

    def test_it_is_cached_by_mtime_and_size_and_reread_when_the_file_changes(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.write(d, [{"project": "a", "state": "blocked", "failureSignature": "x"}])
            first = sw.read_index_summary(p)
            with mock.patch("builtins.open", side_effect=AssertionError("must not reread an unchanged file")):
                self.assertIs(sw.read_index_summary(p), first)
            self.write(d, [{"project": "a", "state": "blocked", "failureSignature": "x"}, {"project": "b", "state": "blocked", "failureSignature": "y"}])
            self.assertEqual(sw.read_index_summary(p)["total"], 2)

    def test_a_rewrite_with_the_same_mtime_but_another_size_is_still_noticed(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.write(d, [{"project": "a", "state": "blocked", "failureSignature": "x"}])
            os.utime(p, ns=(10**18, 10**18))
            self.assertEqual(sw.read_index_summary(p)["total"], 1)
            self.write(d, [{"project": "a", "state": "blocked", "failureSignature": "x"}] * 3)
            os.utime(p, ns=(10**18, 10**18))
            self.assertEqual(sw.read_index_summary(p)["total"], 3)

    def test_missing_corrupt_or_wrong_shape_is_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(sw.read_index_summary(os.path.join(d, "none.json")))
            for content in ("{bad", "[]", '{"entries": 5}'):
                p = os.path.join(d, "x.json")
                Path(p).write_text(content)
                sw._index_cache.update({"key": None, "value": None})
                self.assertIsNone(sw.read_index_summary(p), content)

    def test_non_dict_entries_are_ignored_in_the_buckets_but_counted_in_the_total(self):
        with tempfile.TemporaryDirectory() as d:
            s = sw.read_index_summary(self.write(d, [{"project": "a", "state": "blocked", "failureSignature": "x"}, 7, None]))
        self.assertEqual((s["total"], s["topBuckets"][0]["count"]), (3, 1))


class TimerState(unittest.TestCase):
    def run_with(self, out=None, raises=None):
        def fake(cmd, **kw):
            self.assertEqual(cmd, ["systemctl", "--user", "is-active", "stalled-tick.timer"])
            self.assertEqual(kw["timeout"], 2)
            if raises:
                raise raises
            return mock.Mock(stdout=out)
        return sw.timer_state(run=fake)

    def test_active_inactive_and_unknown(self):
        self.assertIs(self.run_with("active\n"), True)
        for out in ("inactive\n", "failed\n", "activating\n", "dead\n"):
            self.assertIs(self.run_with(out), False, out)
        self.assertIsNone(self.run_with("weird\n"))
        self.assertIsNone(self.run_with("", raises=FileNotFoundError()))
        import subprocess
        self.assertIsNone(self.run_with("", raises=subprocess.TimeoutExpired("x", 2)))


class Build(unittest.TestCase):
    def test_nothing_at_all_is_not_configured(self):
        self.assertEqual(build(rows=[], index=None, meter=OSError("refused"), timer=False), {"configured": False})
        self.assertEqual(build(rows=[], index=None, meter=OSError("refused"), timer=None), {"configured": False})

    def test_any_single_trace_makes_it_configured(self):
        self.assertTrue(build(rows=[row("intent", "t1", "X", 5)], index=None, meter=OSError("x"), timer=False)["configured"])
        self.assertTrue(build(rows=[], index=INDEX, meter=OSError("x"), timer=False)["configured"])
        self.assertTrue(build(rows=[], index=None, meter=OSError("x"), timer=True)["configured"])
        self.assertTrue(build(rows=[], index=None, meter=METER, timer=False)["configured"])

    def test_the_full_payload(self):
        rows = [row("intent", "t1", "ARCHIVE-DUPLICATE", 3000), row("result", "t1", "ARCHIVE-DUPLICATE", 2999, mode="on", result="done"), row("intent", "t2", "ESCALATE-MECHANISM", 60)]
        p = build(rows=rows)
        self.assertEqual((p["configured"], p["mode"], p["timerActive"], p["lastTickAgeS"], p["decisions"]), (True, "dry-run", True, 60, 2))
        self.assertEqual(p["lastTickAt"], ISO(60))
        self.assertEqual(p["today"], {"ARCHIVE-DUPLICATE": 1, "ESCALATE-MECHANISM": 1})
        self.assertEqual(p["stalled"], INDEX)
        self.assertEqual(p["budget"], METER["tokenBudget"])
        self.assertEqual((p["provider"], p["model"], p["gateway"]), ("claude-subscription", "claude-sonnet-5-5", {"available": True}))
        self.assertEqual([r["taskId"] for r in p["recent"]], ["t2", "t1"])                      # newest first
        self.assertEqual(set(p["recent"][0]), {"at", "project", "taskId", "outcome", "mode", "result"})

    def test_mode_is_the_latest_ledger_mode(self):
        rows = [row("intent", "t1", "X", 100, mode="dry-run"), row("result", "t2", "X", 10, mode="on")]
        self.assertEqual(build(rows=rows)["mode"], "on")
        self.assertIsNone(build(rows=[], index=INDEX)["mode"])
        self.assertEqual(build(rows=[{"taskId": "t", "outcome": "X", "at": ISO(5)}])["mode"], None)

    def test_last_tick_falls_back_to_the_index_build_time_and_is_none_with_neither(self):
        p = build(rows=[], index=INDEX)
        self.assertEqual((p["lastTickAt"], p["lastTickAgeS"]), (ISO(30), 30))
        p2 = build(rows=[], index={**INDEX, "builtAt": None})
        self.assertEqual((p2["lastTickAt"], p2["lastTickAgeS"]), (None, None))
        self.assertEqual(build(rows=[{"taskId": "t", "outcome": "X", "at": "garbage"}], index=None)["lastTickAt"], None)

    def test_today_counts_only_decisions_dated_today_in_utc(self):
        rows = [row("intent", "t1", "A", 10), row("intent", "t2", "A", 3600 * 9), row("intent", "t3", "B", 3600 * 30)]          # NOW is 08:00 UTC: 9 h ago is yesterday
        self.assertEqual(build(rows=rows)["today"], {"A": 1})

    def test_holds_are_the_hold_decisions_oldest_first_flagged_dry_run_and_capped(self):
        rows = [row("intent", "h%d" % i, "HOLD-FOR-OWNER", 3600 * (i + 1), question="Q%d?" % i, mode="on" if i == 0 else "dry-run") for i in range(12)] + [row("intent", "x", "ARCHIVE-DUPLICATE", 5)]
        holds = build(rows=rows)["holds"]
        self.assertEqual(len(holds), 10)
        self.assertEqual(holds[0], {"taskId": "h11", "project": "alpha", "question": "Q11?", "dryRun": True, "ageHours": 12.0, "ageS": 43200})
        self.assertEqual([h["ageHours"] for h in holds], sorted([h["ageHours"] for h in holds], reverse=True))
        live = build(rows=[row("result", "h", "HOLD-FOR-OWNER", 7200, mode="on", question="Live?")])["holds"][0]
        self.assertEqual((live["dryRun"], live["ageHours"], live["ageS"]), (False, 2.0, 7200))
        self.assertIsNone(build(rows=[{"taskId": "h", "outcome": "HOLD-FOR-OWNER", "at": "garbage", "mode": "on"}])["holds"][0]["ageHours"])

    def test_only_hold_decisions_are_holds(self):
        rows = [row("intent", "a", "ARCHIVE-DUPLICATE", 100), row("intent", "b", "HOLD-FOR-OWNER", 90, question="Q?"), row("intent", "c", "ESCALATE-MECHANISM", 80)]
        self.assertEqual([h["taskId"] for h in build(rows=rows)["holds"]], ["b"])

    def test_a_fresh_hold_has_exact_seconds_even_though_hours_round_to_zero(self):
        h = build(rows=[row("intent", "h", "HOLD-FOR-OWNER", 100, question="Q")])["holds"][0]
        self.assertEqual((h["ageHours"], h["ageS"]), (0.0, 100))
        self.assertIsNone(build(rows=[{"taskId": "h", "outcome": "HOLD-FOR-OWNER", "at": "garbage", "mode": "on"}])["holds"][0]["ageS"])

    def test_a_future_dated_hold_has_age_zero_seconds_not_negative(self):
        h = build(rows=[row("intent", "h", "HOLD-FOR-OWNER", -300, question="Q")])["holds"][0]
        self.assertEqual(h["ageS"], 0)

    def test_holds_are_ordered_by_exact_age_not_by_rounded_hours(self):
        rows = [row("intent", "newer", "HOLD-FOR-OWNER", 60, question="a"), row("intent", "older", "HOLD-FOR-OWNER", 120, question="b")]
        self.assertEqual([h["taskId"] for h in build(rows=rows)["holds"]], ["older", "newer"])

    def test_hold_ages_keep_a_decimal_hour(self):
        self.assertEqual(build(rows=[row("intent", "h", "HOLD-FOR-OWNER", 5400, question="Q")])["holds"][0]["ageHours"], 1.5)

    def test_a_ledger_dated_in_the_future_reads_as_just_now_not_a_negative_age(self):
        p = build(rows=[row("intent", "t", "X", -500)])
        self.assertEqual(p["lastTickAgeS"], 0)

    def test_recent_is_the_last_eight_decisions(self):
        rows = [row("intent", "t%d" % i, "X", 1000 - i) for i in range(12)]
        self.assertEqual([r["taskId"] for r in build(rows=rows)["recent"]], ["t%d" % i for i in range(11, 3, -1)])

    def test_a_down_or_odd_gateway_only_loses_the_budget_part(self):
        p = build(rows=[row("intent", "t1", "X", 5)], meter=OSError("connection refused"))
        self.assertEqual((p["gateway"]["available"], "connection refused" in p["gateway"]["error"], p["budget"], p["model"]), (False, True, None, None))
        odd = build(rows=[row("intent", "t1", "X", 5)], meter=["not", "a", "meter"])
        self.assertEqual((odd["gateway"]["available"], odd["budget"]), (False, None))
        self.assertIn("not a meter", odd["gateway"]["error"])
        self.assertIsNone(build(rows=[row("intent", "t1", "X", 5)], meter={"provider": "p"})["budget"])
        self.assertIsNone(build(rows=[row("intent", "t1", "X", 5)], meter={"tokenBudget": "x"})["budget"])

    def test_an_unknowable_timer_is_none_not_false(self):
        self.assertIsNone(build(rows=[row("intent", "t1", "X", 5)], timer=None)["timerActive"])
        self.assertIs(build(rows=[row("intent", "t1", "X", 5)], timer=False)["timerActive"], False)

    def test_it_never_raises_whatever_a_reader_does(self):
        def boom(*a, **k):
            raise RuntimeError("x")
        self.assertEqual(sw.build_stalled_worker(env={}, now=NOW, read_rows=boom, read_index=boom, fetch=boom, timer=boom), {"configured": False})
        p = sw.build_stalled_worker(env={}, now=NOW, read_rows=lambda p: [row("intent", "t", "X", 5)], read_index=boom, fetch=boom, timer=boom)
        self.assertTrue(p["configured"])
        self.assertIsNone(p["stalled"])

    def test_paths_and_the_gateway_url_come_from_the_environment(self):
        seen = {}

        def rows(path):
            seen["ledger"] = path
            return []

        def idx(path):
            seen["index"] = path
            return None

        def fetch(url, timeout):
            seen["url"], seen["timeout"] = url, timeout
            raise OSError("x")
        sw.build_stalled_worker(env={"STALLED_LEDGER_PATH": "/l", "STALLED_INDEX_PATH": "/i", "STALLED_MODEL_URL": "http://gw:9/"}, now=NOW, read_rows=rows, read_index=idx, fetch=fetch, timer=lambda: None)
        self.assertEqual(seen, {"ledger": "/l", "index": "/i", "url": "http://gw:9/meter", "timeout": 3})
        self.assertEqual(sw.ledger_path({}), os.path.join(os.path.expanduser("~"), ".local", "state", "pipeline-ops", "stalled-ledger.jsonl"))
        self.assertEqual(sw.index_path({}), os.path.join(os.path.expanduser("~"), ".local", "state", "pipeline-ops", "stalled-index.json"))
        self.assertEqual(sw.model_url({}), "http://127.0.0.1:7475")


class Route(unittest.TestCase):
    def test_the_route_returns_the_payload(self):
        with mock.patch.object(sw, "build_stalled_worker", return_value={"configured": False}):
            r = app.app.test_client().get("/api/stalled-worker")
        self.assertEqual((r.status_code, r.get_json()), (200, {"configured": False}))

    def test_the_route_is_get_only(self):
        self.assertEqual(app.app.test_client().post("/api/stalled-worker").status_code, 405)


if __name__ == "__main__":
    unittest.main()
