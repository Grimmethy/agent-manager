"""A hub-routed candidate split shows up in the Unmerged Branches / task views as what it is: a decomposition, not a finished change.

Run: .venv/bin/python -m unittest python.dashboard.test_describe_hub_split -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

PROPOSALS = [{"title": "Extract the tile grid"}, {"title": "Extract the boundary projection"}]


class TestDescribeHubSplit(unittest.TestCase):
    def test_hub_routed_split_says_it_becomes_a_coordinator_hub(self):
        out = app._describe_change({"candidateSplitProposals": PROPOSALS, "candidateSplitRoute": "hub"})
        self.assertIn("Too large for one pass", out)
        self.assertIn("coordinator hub", out)
        self.assertIn("Extract the tile grid; Extract the boundary projection", out)

    def test_doc_split_description_is_unchanged(self):
        out = app._describe_change({"candidateSplitProposals": PROPOSALS})
        self.assertEqual(out, "Split into 2 sub-candidate(s), not yet implemented: Extract the tile grid; Extract the boundary projection")


if __name__ == "__main__":
    unittest.main()
