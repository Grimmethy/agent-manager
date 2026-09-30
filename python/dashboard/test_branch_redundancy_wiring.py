"""Tests that branch_redundancy.py is actually wired into the verdict engine (branch_verdicts.py): the deterministic check
returns red for an all-duplicate triage branch and yellow for a mixed one, and enrich_branches_with_verdicts turns a superseded
branch's card red while a manual verdict for the same head SHA still wins. The rules themselves are in test_branch_redundancy.py.

Run: python -m unittest python.dashboard.test_branch_redundancy_wiring -v   (from the repo root)
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import branch_verdicts as bv  # noqa: E402
from test_branch_verdicts import Fixture, git, run_git  # noqa: E402  (fixture repo helpers only)

DOC = "Docs/FUNCTION_LENGTH_CANDIDATES.md"
MASTER_DOC = "### AC-10 · Decompose applyBrainDumpSort guard-and-classify monolith\nFiles: src/apply-group-a.js\n"


class TriageWiring(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.cleanup)
        (self.fx.work / "Docs").mkdir()
        self.fx.write(DOC, MASTER_DOC)
        self.fx.commit("master candidates")
        git(["push", "origin", "master"], self.fx.work)

    def _triage(self, appended):
        self.fx.branch_from_master("agent/triage-queue")
        self.fx.write(DOC, MASTER_DOC + appended)
        self.fx.commit("triage batch")
        self.fx.push("agent/triage-queue")
        git(["fetch", "origin", "--prune"], self.fx.work)
        return bv.run_deterministic_checks(self.fx.work, "master", "agent/triage-queue", run_git)

    def test_an_all_duplicate_triage_branch_is_discard(self):
        verdict, reasons = self._triage("\n### AC-198 · Decompose applyBrainDumpSort into helpers\nFiles: src/x.js\n")
        self.assertEqual(verdict, "discard")
        self.assertTrue(reasons[0].startswith("recurring:"))

    def test_a_mixed_triage_branch_is_needs_work_that_keeps_the_new_candidate_visible(self):
        verdict, reasons = self._triage(
            "\n### AC-197 · Decompose `api_queue_state` graph logic\nFiles: python/x.py\n"
            "\n### AC-198 · Decompose applyBrainDumpSort into helpers\nFiles: src/x.js\n")
        self.assertEqual(verdict, "needs-work")
        self.assertIn("AC-197 (api_queue_state)", reasons[0])

    def test_a_branch_of_only_new_candidates_is_not_flagged(self):
        self.assertEqual(self._triage("\n### AC-201 · Decompose `brand_new_function` here\nFiles: src/y.js\n"), (None, []))


class EnrichIntegration(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.cleanup)
        self.fx.write("mod.js", "function big() {\n  step1();\n  step2();\n  step3();\n}\n")
        self.fx.commit("mod")
        git(["push", "origin", "master"], self.fx.work)

    def _mk(self, name, text):
        self.fx.branch_from_master(name)
        self.fx.write("mod.js", text)
        self.fx.commit(name)
        self.fx.push(name)

    def _list(self):
        return [{"branch": "agent/wired", "subject": "HUB0001 · 1/2 · rewire", "mainBranch": "master", "taskId": "wired", "behind": 0},
                {"branch": "agent/inert", "subject": "HUB0002 · 1/2 · helpers", "mainBranch": "master", "taskId": "inert", "behind": 0}]

    def test_the_card_of_a_superseded_branch_reads_discard_and_a_manual_verdict_still_wins(self):
        self._mk("agent/wired", "function big() {\n  stepA();\n  step2();\n  step3();\n}\n")
        self._mk("agent/inert", "function big() {\n  step1();\n  addedHelper();\n  step2();\n  step3();\n}\n")
        git(["fetch", "origin", "--prune"], self.fx.work)
        branches = self._list()
        bv.enrich_branches_with_verdicts(self.fx.queue, self.fx.work, branches, run_git)
        by = {b["branch"]: b for b in branches}
        self.assertEqual((by["agent/inert"]["verdict"], by["agent/inert"]["source"]), ("discard", "deterministic"))
        self.assertIn("superseded by agent/wired", by["agent/inert"]["reasons"][0])
        self.assertIsNone(by["agent/wired"]["verdict"], "the rewiring winner is not flagged")
        bv.record_verdict(self.fx.queue, "agent/inert", by["agent/inert"]["headSha"], "merge", ["I read it, keep it"], "manual")
        branches = self._list()
        bv.enrich_branches_with_verdicts(self.fx.queue, self.fx.work, branches, run_git)
        self.assertEqual({b["branch"]: b["verdict"] for b in branches}["agent/inert"], "merge")

    def test_a_failure_in_the_cross_branch_pass_never_breaks_the_branch_list(self):
        import branch_redundancy
        self._mk("agent/wired", "function big() {\n  stepA();\n  step2();\n  step3();\n}\n")
        git(["fetch", "origin", "--prune"], self.fx.work)
        original = branch_redundancy.find_alternatives
        branch_redundancy.find_alternatives = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            branches = self._list()[:1]
            bv.enrich_branches_with_verdicts(self.fx.queue, self.fx.work, branches, run_git)
        finally:
            branch_redundancy.find_alternatives = original
        self.assertIn("headSha", branches[0])


if __name__ == "__main__":
    unittest.main()
