"""Tests for the 'Needs re-verify' additions in branch_verdicts.py (owner 2026-11-18): reasons, limits from the environment, verdict age, duplicate notice, and the
demotion of a newly conflicting 'merge' verdict (restored when the conflict clears). Pure functions over branch dicts, plus enrich_branches_with_verdicts with a fake git.

Run: python -m unittest python.dashboard.test_branch_reverify -v   (from the repo root)
"""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import branch_reverify as br  # noqa: E402
import branch_verdicts as bv  # noqa: E402

NOW = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)


class Fx:
    @staticmethod
    def iso(hours_ago):
        return (NOW - timedelta(hours=hours_ago)).isoformat()

    @staticmethod
    def B(name="agent/a", **extra):
        base = {"branch": name, "taskId": name.removeprefix("agent/"), "verdict": "merge", "stale": False, "source": "chat", "verifiedAt": Fx.iso(2),
                "behind": 0, "ahead": 1, "willConflict": False, "mainBranch": "master", "hub": None, "pushedAt": Fx.iso(5)}
        base.update(extra)
        return base


iso, B = Fx.iso, Fx.B


class Reasons(unittest.TestCase):
    def test_a_fresh_clean_merge_branch_has_no_reason(self):
        self.assertEqual(br.Reasons.of(B(), NOW, {}), [])

    def test_a_conflicting_branch_says_so(self):
        self.assertEqual(br.Reasons.of(B(willConflict=True), NOW, {}), ["conflicts with master now"])

    def test_far_behind_names_the_age_and_the_distance(self):
        r = br.Reasons.of(B(behind=787, verifiedAt=iso(24 * 6)), NOW, {})
        self.assertEqual(r, ["verified 6 days ago, 787 commits behind master"])

    def test_old_but_not_behind_stays_fresh(self):
        self.assertEqual(br.Reasons.of(B(behind=0, verifiedAt=iso(24 * 9)), NOW, {}), [])

    def test_old_and_the_base_moved_at_all_is_stale(self):
        r = br.Reasons.of(B(behind=3, verifiedAt=iso(30)), NOW, {})
        self.assertEqual(r, ["verified 30 h ago, 3 commits behind master"])

    def test_recent_and_a_little_behind_is_fine(self):
        self.assertEqual(br.Reasons.of(B(behind=40, verifiedAt=iso(3)), NOW, {}), [])

    def test_an_unfinished_hub_piece_says_so_and_a_finished_hub_does_not(self):
        self.assertEqual(br.Reasons.of(B(hub={"id": "HUB1", "state": "coordinating"}), NOW, {}), ["hub piece: an earlier piece or the hub is unfinished"])
        self.assertEqual(br.Reasons.of(B(hub={"id": "HUB1", "state": "done"}), NOW, {}), [])

    def test_several_reasons_come_together(self):
        r = br.Reasons.of(B(willConflict=True, behind=500, verifiedAt=iso(100), hub={"state": "coordinating"}), NOW, {})
        self.assertEqual(len(r), 3)

    def test_other_verdicts_and_stale_ones_carry_no_reverify_reasons(self):
        for v in ("needs-work", "hold", "discard", None):
            self.assertEqual(br.Reasons.of(B(verdict=v, willConflict=True), NOW, {}), [], str(v))
        self.assertEqual(br.Reasons.of(B(stale=True, willConflict=True), NOW, {}), [])

    def test_unknown_conflict_state_is_not_a_reason(self):
        self.assertEqual(br.Reasons.of(B(willConflict=None), NOW, {}), [])


class Limits(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(br.Limits.reverify({}), (100, 24.0))

    def test_environment_overrides_both_limits(self):
        env = {br.MAX_BEHIND_ENV: "10", br.MAX_AGE_HOURS_ENV: "2"}
        self.assertEqual(br.Limits.reverify(env), (10, 2.0))
        self.assertEqual(br.Reasons.of(B(behind=11, verifiedAt=iso(1)), NOW, env), ["verified 1 h ago, 11 commits behind master"])
        self.assertEqual(br.Reasons.of(B(behind=5, verifiedAt=iso(3)), NOW, env), ["verified 3 h ago, 5 commits behind master"])

    def test_a_bad_value_falls_back_to_the_default(self):
        for bad in ("abc", "", "0", "-5", "inf", "nan"):
            self.assertEqual(br.Limits.reverify({br.MAX_BEHIND_ENV: bad, br.MAX_AGE_HOURS_ENV: bad}), (100, 24.0), bad)

    def test_the_demotion_switch(self):
        self.assertTrue(br.Limits.demote_enabled({}))
        for off in ("0", "false", "off", "No"):
            self.assertFalse(br.Limits.demote_enabled({br.DEMOTE_ENV: off}), off)


class AgeAndDuplicates(unittest.TestCase):
    def test_verdict_age_hours(self):
        self.assertAlmostEqual(br.Age.hours(iso(5), NOW), 5.0, places=3)
        self.assertIsNone(br.Age.hours(None, NOW))
        self.assertIsNone(br.Age.hours("not a date", NOW))
        self.assertEqual(br.Age.hours(iso(-3), NOW), 0.0)

    def test_annotate_sets_age_reverify_and_duplicates(self):
        fresh, old, twin_a, twin_b = B("agent/fresh"), B("agent/old", behind=300, verifiedAt=iso(200)), B("agent/fix-1", taskId="fix", pushedAt=iso(9)), B("agent/fix-2", taskId="fix", pushedAt=iso(1))
        branches = br.annotate_reverify([fresh, old, twin_a, twin_b], NOW, {})
        self.assertNotIn("reverify", fresh)
        self.assertEqual(fresh["verdictAgeHours"], 2.0)
        self.assertEqual(old["reverify"]["reasons"], ["verified 8 days ago, 300 commits behind master"])
        self.assertEqual(twin_a["duplicateOf"], ["agent/fix-2"])
        self.assertEqual(twin_b["duplicateOf"], ["agent/fix-1"])
        self.assertNotIn("duplicateOf", fresh)
        self.assertEqual(len(branches), 4)

    def test_a_discarded_twin_is_not_a_duplicate_and_an_empty_task_id_never_matches(self):
        a, b = B("agent/x1", taskId="t"), B("agent/x2", taskId="t", verdict="discard")
        br.annotate_reverify([a, b], NOW, {})
        self.assertNotIn("duplicateOf", a)
        c, d = B("agent/y1", taskId=""), B("agent/y2", taskId=None)
        br.annotate_reverify([c, d], NOW, {})
        self.assertNotIn("duplicateOf", c)

    def test_annotate_clears_a_stale_annotation(self):
        b = B(willConflict=False)
        b["reverify"] = {"reasons": ["old"]}
        b["duplicateOf"] = ["agent/gone"]
        br.annotate_reverify([b], NOW, {})
        self.assertNotIn("reverify", b)
        self.assertNotIn("duplicateOf", b)


class Demotion(unittest.TestCase):
    """enrich_branches_with_verdicts with a fake git: only rev-parse answers, every other git call fails (the checks are best-effort)."""

    SHA = "a" * 40

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.queue = Path(self.tmp.name) / "queue"
        self.queue.mkdir()
        self.run_git = lambda args, cwd: self.SHA + "\n" if args[:1] == ["rev-parse"] else (_ for _ in ()).throw(RuntimeError("no git here"))

    def enrich(self, **extra):
        branch = {"branch": "agent/conf", "taskId": "conf", "mainBranch": "master", "willConflict": True, "conflictFiles": ["src/a.js", "src/b.js"], "behind": 3, "hub": None}
        branch.update(extra)
        bv.enrich_branches_with_verdicts(self.queue, self.tmp.name, [branch], self.run_git)
        return branch

    def store(self):
        return json.loads((self.queue / bv.STORE_NAME).read_text())

    def test_a_conflicting_chat_merge_verdict_becomes_a_deterministic_needs_work_and_keeps_the_old_record(self):
        bv.record_verdict(self.queue, "agent/conf", self.SHA, "merge", ["owner says go"], "chat")
        b = self.enrich()
        self.assertEqual(b["verdict"], "needs-work")
        self.assertEqual(b["source"], "deterministic")
        self.assertEqual(b["reasons"][0], "conflicts with master on: src/a.js, src/b.js")
        self.assertIn("the earlier chat merge verdict", b["reasons"][1])
        rec = self.store()["agent/conf"][self.SHA]
        self.assertEqual(rec["supersedes"]["verdict"], "merge")
        self.assertEqual(rec["supersedes"]["source"], "chat")
        self.assertEqual(rec["supersedes"]["reasons"], ["owner says go"])

    def test_a_worker_merge_verdict_is_demoted_too(self):
        bv.record_verdict(self.queue, "agent/conf", self.SHA, "merge", ["trial merge clean"], "worker")
        self.assertEqual(self.enrich()["verdict"], "needs-work")

    def test_the_demotion_is_journaled_once_and_not_repeated_on_the_next_build(self):
        bv.record_verdict(self.queue, "agent/conf", self.SHA, "merge", ["ok"], "chat")
        self.enrich()
        first = self.store()["agent/conf"][self.SHA]["verifiedAt"]
        again = self.enrich()
        self.assertEqual(again["verdict"], "needs-work")
        self.assertEqual(self.store()["agent/conf"][self.SHA]["verifiedAt"], first)
        self.assertEqual(self.store()["agent/conf"][self.SHA]["supersedes"]["reasons"], ["ok"])

    def test_the_conflict_clearing_restores_the_superseded_merge_verdict(self):
        bv.record_verdict(self.queue, "agent/conf", self.SHA, "merge", ["owner says go"], "chat")
        self.enrich()
        b = self.enrich(willConflict=False, conflictFiles=[])
        self.assertEqual((b["verdict"], b["source"], b["reasons"]), ("merge", "chat", ["owner says go"]))
        self.assertNotIn("supersedes", self.store()["agent/conf"][self.SHA])

    def test_an_unchecked_conflict_state_changes_nothing(self):
        bv.record_verdict(self.queue, "agent/conf", self.SHA, "merge", ["ok"], "chat")
        b = self.enrich(willConflict=None)
        self.assertEqual((b["verdict"], b["source"]), ("merge", "chat"))
        self.enrich()
        b = self.enrich(willConflict=None)
        self.assertEqual(b["verdict"], "needs-work")

    def test_a_branch_that_does_not_conflict_keeps_its_merge_verdict(self):
        bv.record_verdict(self.queue, "agent/conf", self.SHA, "merge", ["ok"], "chat")
        b = self.enrich(willConflict=False, conflictFiles=[])
        self.assertEqual((b["verdict"], b["source"]), ("merge", "chat"))

    def test_the_switch_turns_the_demotion_off(self):
        import os
        bv.record_verdict(self.queue, "agent/conf", self.SHA, "merge", ["ok"], "chat")
        os.environ[br.DEMOTE_ENV] = "0"
        self.addCleanup(os.environ.pop, br.DEMOTE_ENV, None)
        b = self.enrich()
        self.assertEqual((b["verdict"], b["source"]), ("merge", "chat"))
        self.assertEqual(b["reverify"]["reasons"], ["conflicts with master now"])

    def test_the_enrich_pass_annotates_the_reverify_reason_for_a_far_behind_branch(self):
        bv.record_verdict(self.queue, "agent/conf", self.SHA, "merge", ["ok"], "chat")
        b = self.enrich(willConflict=False, conflictFiles=[], behind=900)
        self.assertEqual(b["verdict"], "merge")
        self.assertEqual(b["reverify"]["reasons"][0].split(", ")[-1], "900 commits behind master")


if __name__ == "__main__":
    unittest.main()
