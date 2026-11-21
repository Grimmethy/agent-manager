"""Whole-file 'Remove unused file <path>' candidates key on their full Files path, never on a path segment.

Run: python3 -m unittest python.dashboard.test_branch_redundancy_whole_file -v   (from the repo root)
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import branch_redundancy as br  # noqa: E402

DOC = "Docs/FUNCTION_LENGTH_CANDIDATES.md"
P = "TaxHarvest/frontend/src/"


def heading(ac, path):
    return f"### {ac} · Remove unused file {path}\nFiles: {path}\n"


def fake_git(master_text, added_text):
    def run_git(args, cwd):
        if args[:2] == ["diff", "--name-only"]:
            return DOC + "\n"
        if args[:2] == ["diff", "-U0"]:
            return "".join("+" + line + "\n" for line in added_text.splitlines())
        if args[:1] == ["show"]:
            return master_text
        raise RuntimeError("unexpected git call: " + repr(args))
    return run_git


def check(master_text, added_text):
    return br.check_duplicate_candidates(fake_git(master_text, added_text), ".", "master", "agent/triage-queue")


class WholeFileCandidates(unittest.TestCase):
    def test_parse_gives_the_full_path_and_no_identifier(self):
        (c,) = br.parse_candidate_headings(heading("AC-104", P + "a.jsx"))
        self.assertEqual(c["path"], P + "a.jsx")
        self.assertIsNone(c["ident"])

    def test_distinct_whole_file_candidates_under_one_folder_are_not_duplicates(self):
        master = heading("AC-94", P + "old.jsx")
        added = heading("AC-104", P + "a.jsx") + heading("AC-105", P + "b.jsx") + heading("AC-106", P + "c.jsx")
        self.assertIsNone(check(master, added))

    def test_same_whole_file_path_is_a_duplicate(self):
        master = heading("AC-94", P + "a.jsx")
        added = heading("AC-104", P + "a.jsx")
        verdict, reasons = check(master, added)
        self.assertEqual(verdict, "discard")
        self.assertIn("AC-104 " + P + "a.jsx = AC-94", reasons[0])

    def test_mixed_same_path_and_distinct_is_needs_work_naming_the_new_one(self):
        master = heading("AC-94", P + "a.jsx")
        added = heading("AC-104", P + "a.jsx") + heading("AC-105", P + "b.jsx")
        verdict, reasons = check(master, added)
        self.assertEqual(verdict, "needs-work")
        self.assertIn("AC-105", reasons[0])
        self.assertIn("AC-104 " + P + "a.jsx = AC-94", reasons[1])


if __name__ == "__main__":
    unittest.main()
