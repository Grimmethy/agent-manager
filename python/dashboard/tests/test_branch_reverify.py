"""Unittest coverage for the hub reason in branch_reverify.Reasons.of (HUB0070).

Exercises the only branch of the hub check: a fully built hub (readyToMerge
true) must NOT get the "hub piece: an earlier piece or the hub is unfinished"
reason, while a hub with unbuilt pieces still must.

Run: python3 -I -m unittest python/dashboard/tests/test_branch_reverify.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from python.dashboard.branch_reverify import Reasons  # noqa: E402


class TestReasonsHubReason(unittest.TestCase):
    """Reasons.of should not attach the unfinished-hub reason when the hub
    itself reports readyToMerge (every piece built)."""

    def _merge_branch(self, hub=None):
        return {
            "verdict": "merge",
            "stale": False,
            "mainBranch": "master",
            "behind": 0,
            "verifiedAt": "2026-11-19T00:00:00Z",
            "hub": hub,
        }

    def test_coordinating_with_ready_to_merge_no_reason(self):
        """(1) hub state coordinating + readyToMerge true -> no hub reason."""
        hub = {
            "state": "coordinating",
            "readyToMerge": True,
            "progress": "built 3/3",
        }
        reasons = Reasons.of(self._merge_branch(hub=hub))
        hub_reasons = [r for r in reasons if "hub piece" in r]
        self.assertEqual(hub_reasons, [],
                         f"expected no hub reason, got: {reasons}")

    def test_coordinating_not_all_built_gives_reason(self):
        """(2) coordinating + built 2 of 3 still gives the reason."""
        hub = {
            "state": "coordinating",
            "readyToMerge": False,
            "progress": "built 2/3",
        }
        reasons = Reasons.of(self._merge_branch(hub=hub))
        hub_reasons = [r for r in reasons if "hub piece" in r]
        self.assertEqual(hub_reasons,
                         ["hub piece: an earlier piece or the hub is unfinished"],
                         f"expected hub reason, got: {reasons}")

    def test_abandoned_piece_gives_reason(self):
        """(3) an abandoned piece still gives the reason."""
        hub = {
            "state": "coordinating",
            "readyToMerge": False,
            "progress": "built 2/3",
            "pieces": [
                {"id": "HUB0070-01", "status": "done"},
                {"id": "HUB0070-02", "status": "done"},
                {"id": "HUB0070-03", "status": "abandoned"},
            ],
        }
        reasons = Reasons.of(self._merge_branch(hub=hub))
        hub_reasons = [r for r in reasons if "hub piece" in r]
        self.assertEqual(hub_reasons,
                         ["hub piece: an earlier piece or the hub is unfinished"],
                         f"expected hub reason for abandoned piece, got: {reasons}")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
