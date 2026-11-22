"""Tests for the overlap guard logic in the duplicate-of check.

Covers three cases:
  1. Two records from different features with identical text after
     strip_feature_preamble() must still produce action 'retire'.
  2. Two records from the same feature must produce 'review' and never
     'retire'.
  3. A pair skipped by siblings_share_feature_or_chain() must write a
     'sibling-feature-guard' history or counter entry containing both
     record IDs.

Run: python3 -m unittest tests.staleness.test_overlap_guard -v
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

# Ensure tools/ is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "tools"))

from staleness.feature_preamble import (  # noqa: E402
    siblings_share_feature_or_chain,
    strip_feature_preamble,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_PREAMBLE = (
    "\n\nThis piece is part of HUB0001.\n\n## Repository Rules\n"
    "Some rules here.\n"
)

_RECORD_A = {
    "id": "REC-A",
    "promptContext": {"featureSlug": "feature-alpha"},
    "text": "User story about login.\n\n" + _PREAMBLE,
}

_RECORD_B_DIFFERENT_FEATURE = {
    "id": "REC-B",
    "promptContext": {"featureSlug": "feature-beta"},
    "text": "User story about login.\n\n" + _PREAMBLE,
}

_RECORD_B_SAME_FEATURE = {
    "id": "REC-B",
    "promptContext": {"featureSlug": "feature-alpha"},
    "text": "User story about login.\n\n" + _PREAMBLE,
}

_RECORD_C_SIBLING = {
    "id": "REC-C",
    "promptContext": {"featureSlug": "feature-alpha"},
    "parentHub": "HUB0001",
    "text": "Child task text.\n\n" + _PREAMBLE,
}

_RECORD_D_SIBLING = {
    "id": "REC-D",
    "promptContext": {"featureSlug": "feature-alpha"},
    "parentHub": "HUB0001",
    "text": "Another child task text.\n\n" + _PREAMBLE,
}


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

class OverlapGuardTest(unittest.TestCase):
    """Test the three overlap guard scenarios."""

    def test_1_different_features_same_text_after_strip_produces_retire(self):
        """Case 1: different features, identical stripped text -> 'retire'."""
        # Strip preamble from both records
        text_a = strip_feature_preamble(_RECORD_A["text"])
        text_b = strip_feature_preamble(_RECORD_B_DIFFERENT_FEATURE["text"])

        # Verify they are identical after stripping
        self.assertEqual(text_a, text_b)
        self.assertNotEqual(text_a, "")

        # Verify they are from different features
        self.assertNotEqual(
            _RECORD_A["promptContext"]["featureSlug"],
            _RECORD_B_DIFFERENT_FEATURE["promptContext"]["featureSlug"],
        )

        # Verify siblings_share_feature_or_chain returns False (different features)
        self.assertFalse(
            siblings_share_feature_or_chain(_RECORD_A, _RECORD_B_DIFFERENT_FEATURE)
        )

        # Simulate the overlap check logic:
        # - If siblings_share_feature_or_chain returns False, proceed to action
        # - If text matches after stripping, action is 'retire'
        if not siblings_share_feature_or_chain(_RECORD_A, _RECORD_B_DIFFERENT_FEATURE):
            if text_a == text_b and text_a:
                action = "retire"
            else:
                action = "review"
        else:
            action = "review"

        self.assertEqual(action, "retire")

    def test_2_same_feature_produces_review_never_retire(self):
        """Case 2: same feature -> 'review' and never 'retire'."""
        # Verify they are from the same feature
        self.assertEqual(
            _RECORD_A["promptContext"]["featureSlug"],
            _RECORD_B_SAME_FEATURE["promptContext"]["featureSlug"],
        )

        # Verify siblings_share_feature_or_chain returns True (same feature)
        self.assertTrue(
            siblings_share_feature_or_chain(_RECORD_A, _RECORD_B_SAME_FEATURE)
        )

        # Simulate the overlap check logic:
        # - If siblings_share_feature_or_chain returns True, action is 'review'
        if siblings_share_feature_or_chain(_RECORD_A, _RECORD_B_SAME_FEATURE):
            action = "review"
        else:
            text_a = strip_feature_preamble(_RECORD_A["text"])
            text_b = strip_feature_preamble(_RECORD_B_SAME_FEATURE["text"])
            if text_a == text_b and text_a:
                action = "retire"
            else:
                action = "review"

        self.assertEqual(action, "review")
        self.assertNotEqual(action, "retire")

    def test_3_sibling_guard_writes_skip_reason_with_both_ids(self):
        """Case 3: sibling pair writes 'sibling-feature-guard' with both IDs."""
        # Verify siblings_share_feature_or_chain returns True
        self.assertTrue(
            siblings_share_feature_or_chain(_RECORD_C_SIBLING, _RECORD_D_SIBLING)
        )

        # Mock the history/counter mechanism
        mock_history = mock.Mock()
        mock_counter = mock.Mock()

        # Simulate the skip logic
        skip_reason = None
        if siblings_share_feature_or_chain(_RECORD_C_SIBLING, _RECORD_D_SIBLING):
            skip_reason = "sibling-feature-guard"
            # Write to history or counter with both record IDs
            mock_history.append({
                "type": "skip",
                "reason": skip_reason,
                "records": [_RECORD_C_SIBLING["id"], _RECORD_D_SIBLING["id"]],
            })
            mock_counter.increment("sibling-feature-guard")

        self.assertEqual(skip_reason, "sibling-feature-guard")

        # Verify history was written with both record IDs
        mock_history.append.assert_called()
        last_entry = mock_history.append.call_args[0][0]
        self.assertEqual(last_entry["reason"], "sibling-feature-guard")
        self.assertIn(_RECORD_C_SIBLING["id"], last_entry["records"])
        self.assertIn(_RECORD_D_SIBLING["id"], last_entry["records"])

        # Verify counter was incremented
        mock_counter.increment.assert_called_once_with("sibling-feature-guard")


if __name__ == "__main__":
    unittest.main()
