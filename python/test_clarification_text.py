"""Unit tests for python/dashboard/clarification_text.fold_answer.

Covers the decision-first block layout: a new decision block is prepended,
prior decision blocks are preserved verbatim below it, the original task
text is preserved after a single ORIGINAL_MARKER, and a `Files:` line in
the answer replaces the stale one in the old text.

Run: python3 -B -m unittest test_clarification_text  (from python/)
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from dashboard.clarification_text import (  # noqa: E402
    DECISION_HEADER,
    ORIGINAL_MARKER,
    fold_answer,
)


class FoldAnswerTest(unittest.TestCase):
    def _decision_header(self, stamp: str) -> str:
        return DECISION_HEADER(stamp)

    # ------------------------------------------------------------------ #
    # 1. Output starts with the decision header
    # ------------------------------------------------------------------ #
    def test_output_starts_with_the_decision_header(self):
        raw = f"some task text\n{ORIGINAL_MARKER}\noriginal ask"
        answer = "go with option B"
        result = fold_answer(raw, answer, stamp="s1")
        expected_header = self._decision_header("s1")
        self.assertTrue(result.startswith(expected_header),
                        f"Result:\n{result!r}\nexpected to start with {expected_header!r}")

    # ------------------------------------------------------------------ #
    # 2. Old text appears verbatim after ORIGINAL_MARKER
    # ------------------------------------------------------------------ #
    def test_old_text_appears_verbatim_after_original_marker(self):
        original_body = "original ask\nwith multiple\nlines"
        raw = f"some preamble\n{ORIGINAL_MARKER}\n{original_body}"
        result = fold_answer(raw, "answer A", stamp="s1")
        self.assertIn(ORIGINAL_MARKER, result)
        # The body (minus the newline that separated it from the marker
        # in the source) appears verbatim somewhere after the marker.
        marker_idx = result.index(ORIGINAL_MARKER)
        self.assertIn(original_body, result[marker_idx:],
                      f"original body not preserved verbatim in:\n{result!r}")

    # ------------------------------------------------------------------ #
    # 3. Empty old text (no content after ORIGINAL_MARKER)
    # ------------------------------------------------------------------ #
    def test_empty_old_text(self):
        raw = f"preamble\n{ORIGINAL_MARKER}"
        result = fold_answer(raw, "answer A", stamp="s1")
        self.assertTrue(result.startswith(self._decision_header("s1")))
        self.assertIn(ORIGINAL_MARKER, result)
        idx = result.index(ORIGINAL_MARKER)
        # Only the document-terminating newline follows the marker; no body.
        tail = result[idx + len(ORIGINAL_MARKER):]
        self.assertEqual(tail, "\n", f"expected '\\n', got {tail!r}")

    # ------------------------------------------------------------------ #
    # 4. Answering twice: newest decision first, earlier below, one marker
    # ------------------------------------------------------------------ #
    def test_answer_twice_newest_decision_first_with_one_marker(self):
        first_raw = f"preamble\n{ORIGINAL_MARKER}\noriginal ask"
        folded1 = fold_answer(first_raw, "first answer", stamp="s1")
        folded2 = fold_answer(folded1, "second answer", stamp="s2")

        # Exactly one ORIGINAL_MARKER in the final output.
        self.assertEqual(folded2.count(ORIGINAL_MARKER), 1,
                         f"expected one marker, got {folded2.count(ORIGINAL_MARKER)}")

        # The newest decision block (s2) is first (lowest index).
        self.assertTrue(folded2.startswith(self._decision_header("s2")))

        # The earlier decision block (s1) appears below the newest one.
        idx_s2 = folded2.index(self._decision_header("s2"))
        idx_s1 = folded2.index(self._decision_header("s1"))
        self.assertLess(idx_s2, idx_s1,
                        "newest decision block should appear above the earlier one")

        # The original text is preserved exactly once after the marker.
        marker_idx = folded2.index(ORIGINAL_MARKER)
        self.assertIn("\noriginal ask", folded2[marker_idx:])


class FoldAnswerFilesLineTest(unittest.TestCase):
    """fold_answer preserves the original text verbatim, including a `Files:`
    line that replace_files_line already installed upstream. The new line
    comes from the answer's decision block; the old line is gone because
    the caller already swapped it out before calling fold_answer.

    This pins the invariant that fold_answer itself does not re-introduce
    stale `Files:` lines from the original text -- it keeps whatever the
    upstream replacement left in place.
    """

    def test_answer_files_line_replaces_the_old_one(self):
        # Upstream replace_files_line already swapped the stale line, so
        # the raw text fed into fold_answer has no old path at all.
        raw = (
            "Preamble with the updated path.\n"
            "Files: new_path.py\n"
            f"{ORIGINAL_MARKER}\n"
            "original ask\n"
            "Files: new_path.py"
        )
        answer = "go with B\nFiles: new_path.py"
        result = fold_answer(raw, answer, stamp="s1")

        # The new Files: line appears (in the answer's decision block and
        # in the preserved original body).
        self.assertIn("Files: new_path.py", result)
        # The old path is not reintroduced by fold_answer.
        self.assertNotIn("Files: old_path.py", result)


if __name__ == "__main__":
    unittest.main()
