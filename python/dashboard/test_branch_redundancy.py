"""Tests for branch_redundancy.py (recurring candidates + superseded alternatives) against FIXTURE git repos: real git, no
mocks of the checks. Reuses the bare-origin + clone Fixture from test_branch_verdicts.

Run: python -m unittest python.dashboard.test_branch_redundancy -v   (from the repo root)
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import branch_redundancy as br  # noqa: E402
from test_branch_verdicts import Fixture, git, run_git  # noqa: E402  (fixture repo helpers only)

DOC = "Docs/FUNCTION_LENGTH_CANDIDATES.md"
MASTER_DOC = (
    "### AC-10 · Decompose applyBrainDumpSort guard-and-classify monolith\nFiles: src/apply-group-a.js\n\n"
    "### AC-52 · Decompose renderHardwareTab into per-section renderers\nFiles: static/hw.js\n\n"
    "### AC-60 · Split `run_queue_sweep` into phases\nFiles: python/x.py\n"
)


class Identifiers(unittest.TestCase):
    def test_backticked_camel_and_snake_names_are_identifiers_and_plain_words_are_not(self):
        self.assertEqual(br.candidate_identifier("Decompose `api_queue_state` coordinating-branch graph logic"), "api_queue_state")
        self.assertEqual(br.candidate_identifier("Decompose applyBrainDumpSort into named helpers"), "applyBrainDumpSort")
        self.assertEqual(br.candidate_identifier("Decompose renderHardwareTab into per-section builders"), "renderHardwareTab")
        self.assertEqual(br.candidate_identifier("Split `Foo.bar_baz` out"), "bar_baz")
        self.assertIsNone(br.candidate_identifier("Decompose the monolithic system-report builder into per-section renderers"))
        self.assertIsNone(br.candidate_identifier(""))

    def test_a_backticked_plain_word_is_an_identifier_only_because_of_the_backticks(self):
        # No underscore and no camelCase, so the fallback would ignore it: only the backtick rule can find it.
        self.assertEqual(br.candidate_identifier("Split `register` into phases"), "register")
        self.assertIsNone(br.candidate_identifier("Split register into phases"))

    def test_headings_parse_with_or_without_an_identifier(self):
        got = br.parse_candidate_headings(MASTER_DOC + "### AC-61 · Tidy the config loader\n")
        self.assertEqual([(c["id"], c["ident"]) for c in got],
                         [("AC-10", "applyBrainDumpSort"), ("AC-52", "renderHardwareTab"), ("AC-60", "run_queue_sweep"), ("AC-61", None)])


class DuplicateCandidates(unittest.TestCase):
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
        return br.check_duplicate_candidates(run_git, self.fx.work, "master", "agent/triage-queue")

    def test_every_added_candidate_a_duplicate_by_function_name_across_a_moved_file_is_discard(self):
        # AC-198 / AC-199 name a DIFFERENT file than AC-10 / AC-52 (the function moved) -- the file+identifier dedupe missed exactly this.
        verdict, reasons = self._triage(
            "\n### AC-198 · Decompose applyBrainDumpSort into named, independently-testable helpers\nFiles: src/apply-group-a-brain-dump.js\n"
            "\n### AC-199 · Decompose renderHardwareTab into per-section builders\nFiles: python/dashboard/static/js/hw-tab.js\n")
        self.assertEqual(verdict, "discard")
        self.assertIn("AC-198 applyBrainDumpSort = AC-10", reasons[0])
        self.assertIn("AC-199 renderHardwareTab = AC-52", reasons[0])

    def test_a_mix_of_new_and_duplicate_is_needs_work_that_names_the_new_one(self):
        verdict, reasons = self._triage(
            "\n### AC-197 · Decompose `api_queue_state` coordinating-branch graph logic\nFiles: python/dashboard/routes/shared_misc.py\n"
            "\n### AC-198 · Decompose applyBrainDumpSort into named helpers\nFiles: src/x.js\n")
        self.assertEqual(verdict, "needs-work")
        self.assertIn("AC-197 (api_queue_state)", reasons[0])
        self.assertIn("AC-198 applyBrainDumpSort = AC-10", reasons[1])

    def test_only_new_candidates_and_candidates_without_an_identifier_are_not_flagged(self):
        self.assertIsNone(self._triage("\n### AC-201 · Decompose `brand_new_function` here\nFiles: src/y.js\n\n### AC-202 · Tidy the config loader\nFiles: src/z.js\n"))

    def test_a_branch_that_does_not_touch_a_candidates_doc_is_not_checked(self):
        self.fx.branch_from_master("agent/other")
        self.fx.write("f.txt", "f\n")
        self.fx.commit("f")
        self.fx.push("agent/other")
        git(["fetch", "origin", "--prune"], self.fx.work)
        self.assertIsNone(br.check_duplicate_candidates(run_git, self.fx.work, "master", "agent/other"))


class RewiresCode(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.cleanup)
        self.fx.write("mod.js", "// header comment\nfunction big() {\n  return 1;\n}\nmodule.exports = { big };\n")
        self.fx.commit("mod")
        git(["push", "origin", "master"], self.fx.work)

    def _branch(self, name, text, extra=None):
        self.fx.branch_from_master(name)
        self.fx.write("mod.js", text)
        for k, v in (extra or {}).items():
            self.fx.write(k, v)
        self.fx.commit(name)
        self.fx.push(name)
        git(["fetch", "origin", "--prune"], self.fx.work)
        return br.rewires_code(run_git, self.fx.work, "master", name)

    def test_removing_real_code_rewires(self):
        self.assertTrue(self._branch("agent/w", "// header comment\nfunction big() {\n  return helper();\n}\nfunction helper() { return 1; }\nmodule.exports = { big };\n"))

    def test_add_only_with_an_export_list_edit_and_comment_removal_does_not_rewire(self):
        self.assertFalse(self._branch("agent/a", "function big() {\n  return 1;\n}\nfunction helper() { return 2; }\nmodule.exports = { big, helper };\n"))

    def test_removing_lines_from_a_test_file_does_not_count(self):
        self.fx.write("mod.test.js", "old test\n")
        self.fx.commit("add test")
        git(["push", "origin", "master"], self.fx.work)
        self.assertFalse(self._branch("agent/t", "// header comment\nfunction big() {\n  return 1;\n}\nfunction h() {}\nmodule.exports = { big, h };\n", {"mod.test.js": "new test\n"}))


class Alternatives(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.cleanup)
        self.fx.write("mod.js", "function big() {\n  step1();\n  step2();\n  step3();\n}\n")
        self.fx.write("other.js", "function o() {}\n")
        self.fx.commit("mod")
        git(["push", "origin", "master"], self.fx.work)

    def _branch(self, name, files):
        self.fx.branch_from_master(name)
        for k, v in files.items():
            self.fx.write(k, v)
        self.fx.commit(name)
        self.fx.push(name)

    def _run(self, subjects):
        git(["fetch", "origin", "--prune"], self.fx.work)
        branches = [{"branch": b, "subject": s} for b, s in subjects.items()]
        return br.find_alternatives(branches, self.fx.work, "master", run_git)

    REWIRE = "function big() {\n  stepA();\n  step2();\n  step3();\n}\n"          # replaces step1() -> removes a real line
    ADD_ONLY_SAME_SPOT = "function big() {\n  step1();\n  newHelperCall();\n  step2();\n  step3();\n}\n"  # inserts next to the rewired line

    def test_an_add_only_branch_that_conflicts_with_a_rewiring_rival_from_another_hub_is_superseded(self):
        self._branch("agent/wired", {"mod.js": self.REWIRE})
        self._branch("agent/inert", {"mod.js": "function big() {\n  step1();\n  step2();\n  step3();\n}\nfunction helperOnly() {}\n" .replace("step1();\n", "step1();\nhelperInsert();\n")})
        # Force a real textual conflict with the rewire by touching the same line region.
        res = self._run({"agent/wired": "HUB0001 · 1/2 · rewire", "agent/inert": "HUB0002 · 1/2 · add helpers"})
        self.assertEqual(res["agent/inert"][0], "discard")
        self.assertIn("superseded by agent/wired (HUB0001)", res["agent/inert"][1][0])
        self.assertNotIn("agent/wired", res, "the rewiring winner gets no flag at all, not even a yellow 'alternative' one")

    def test_two_add_only_rivals_are_both_needs_work_alternatives(self):
        self._branch("agent/a", {"mod.js": self.ADD_ONLY_SAME_SPOT})
        self._branch("agent/b", {"mod.js": self.ADD_ONLY_SAME_SPOT.replace("newHelperCall", "otherHelperCall")})
        res = self._run({"agent/a": "HUB0001 · 1/2 · a", "agent/b": "HUB0002 · 1/2 · b"})
        self.assertEqual(res["agent/a"][0], "needs-work")
        self.assertEqual(res["agent/b"][0], "needs-work")
        self.assertIn("alternative to agent/b (HUB0002)", res["agent/a"][1][0])
        self.assertIn("both only add helpers", res["agent/a"][1][0])

    def test_two_rewiring_rivals_are_needs_work_not_discard(self):
        self._branch("agent/a", {"mod.js": self.REWIRE})
        self._branch("agent/b", {"mod.js": self.REWIRE.replace("stepA", "stepB")})
        res = self._run({"agent/a": "HUB0001 · 1/2 · a", "agent/b": "HUB0002 · 1/2 · b"})
        self.assertEqual({v[0] for v in res.values()}, {"needs-work"})
        self.assertIn("both rewire the same code", res["agent/a"][1][0])

    def test_siblings_of_the_same_hub_are_never_alternatives(self):
        self._branch("agent/a", {"mod.js": self.REWIRE})
        self._branch("agent/b", {"mod.js": self.REWIRE.replace("stepA", "stepB")})
        self.assertEqual(self._run({"agent/a": "HUB0001 · 1/3 · a", "agent/b": "HUB0001 · 2/3 · b"}), {})

    def test_branches_on_different_files_or_that_merge_cleanly_are_left_alone(self):
        self._branch("agent/a", {"mod.js": self.REWIRE})
        self._branch("agent/b", {"other.js": "function o() {}\nfunction p() {}\n"})
        self._branch("agent/c", {"mod.js": "function big() {\n  step1();\n  step2();\n  step3();\n}\nfunction farAway() {}\n"})
        self.assertEqual(self._run({"agent/a": "HUB0001 · 1/2 · a", "agent/b": "HUB0002 · 1/2 · b", "agent/c": "HUB0003 · 1/2 · c"}), {})

    def test_a_branch_with_no_hub_label_is_never_compared(self):
        self._branch("agent/a", {"mod.js": self.REWIRE})
        self._branch("agent/b", {"mod.js": self.ADD_ONLY_SAME_SPOT})
        self.assertEqual(self._run({"agent/a": "HUB0001 · 1/2 · a", "agent/b": "Triage batch: 1 candidate-doc update(s)"}), {})


class MergeResults(unittest.TestCase):
    def test_discard_beats_needs_work_beats_nothing_and_reasons_are_combined_without_duplicates(self):
        self.assertEqual(br.merge_results((None, []), ("discard", ["x"])), ("discard", ["x"]))
        self.assertEqual(br.merge_results(("needs-work", ["a"]), ("discard", ["x"])), ("discard", ["a", "x"]))
        self.assertEqual(br.merge_results(("discard", ["a"]), ("needs-work", ["x"])), ("discard", ["a", "x"]))
        self.assertEqual(br.merge_results(("needs-work", ["a"]), ("needs-work", ["a", "b"])), ("needs-work", ["a", "b"]))
        self.assertEqual(br.merge_results(("needs-work", ["a"]), None), ("needs-work", ["a"]))


if __name__ == "__main__":
    unittest.main()
