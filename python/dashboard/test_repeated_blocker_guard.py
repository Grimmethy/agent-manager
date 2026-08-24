"""Tests for app.py's _repeated_blocker_match/_jaccard/_significant_words (2026-08-24,
pipeline hardening) -- the "requeue a blocked task" guard that refuses a blind requeue
when the current blockedReason looks like the same underlying problem as an earlier
rejection already recorded in priorRejectionFeedback. Root-caused live: two real tasks
each survived a full bulk-requeue pass ("get to 0 blocked", 2026-08-23) and immediately
failed the exact same way again.

Run: .venv/bin/python -m unittest python.dashboard.test_repeated_blocker_guard -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app as dashboard_app  # noqa: E402


class RepeatedBlockerMatchTest(unittest.TestCase):
    def test_flags_a_recurring_quoted_symbol_even_when_the_surrounding_prose_differs(self):
        # Real data, 2026-08-24: these two sentences share almost no vocabulary besides
        # the quoted symbol itself -- exactly why the quoted-symbol check exists as the
        # PRIMARY signal, not generic word-overlap alone.
        task = {
            "blockedReason": "The diff references `CLAUDE_MODEL_CHOICES` and `_fetch_ollama_models()` in `python/dashboard/app.py`",
            "priorRejectionFeedback": [
                "The draft contains a fabricated verification claim -- it asserts the full JS test suite passed",
                "The fact-check flags `CLAUDE_MODEL_CHOICES` as an ungrounded-field, indicating fabrication",
            ],
        }
        match = dashboard_app._repeated_blocker_match(task)
        self.assertIsNotNone(match)
        self.assertIn("CLAUDE_MODEL_CHOICES", match)

    def test_falls_back_to_word_overlap_when_neither_reason_quotes_a_symbol(self):
        task = {
            "blockedReason": "The draft fails to provide the required concrete deliverables and consists of meta-commentary",
            "priorRejectionFeedback": [
                "The draft fails to provide the required concrete deliverables and general advice instead",
            ],
        }
        self.assertIsNotNone(dashboard_app._repeated_blocker_match(task))

    def test_does_not_flag_genuinely_different_rejection_reasons(self):
        task = {
            "blockedReason": "The draft fails the task's explicit requirement to search ClinicalTrials.gov for a registration number",
            "priorRejectionFeedback": [
                "The draft cites a specific URL with a future date and claims specific funding figures",
            ],
        }
        self.assertIsNone(dashboard_app._repeated_blocker_match(task))

    def test_returns_none_when_there_is_no_prior_rejection_feedback(self):
        task = {"blockedReason": "Something went wrong", "priorRejectionFeedback": []}
        self.assertIsNone(dashboard_app._repeated_blocker_match(task))

    def test_returns_none_when_blockedReason_itself_is_empty(self):
        task = {"blockedReason": "", "priorRejectionFeedback": ["some prior reason"]}
        self.assertIsNone(dashboard_app._repeated_blocker_match(task))

    def test_returns_none_when_priorRejectionFeedback_is_absent_entirely(self):
        task = {"blockedReason": "Something went wrong"}
        self.assertIsNone(dashboard_app._repeated_blocker_match(task))


class JaccardTest(unittest.TestCase):
    def test_identical_sets_score_one(self):
        s = {"a", "b", "c"}
        self.assertEqual(dashboard_app._jaccard(s, s), 1.0)

    def test_disjoint_sets_score_zero(self):
        self.assertEqual(dashboard_app._jaccard({"a"}, {"b"}), 0.0)

    def test_empty_set_scores_zero_not_a_division_error(self):
        self.assertEqual(dashboard_app._jaccard(set(), {"a"}), 0.0)
        self.assertEqual(dashboard_app._jaccard({"a"}, set()), 0.0)


class SignificantWordsTest(unittest.TestCase):
    def test_strips_stopwords_and_short_tokens(self):
        words = dashboard_app._significant_words("This is a real problem with the file")
        self.assertNotIn("this", words)
        self.assertNotIn("is", words)
        self.assertIn("real", words)
        self.assertIn("problem", words)


if __name__ == "__main__":
    unittest.main()
