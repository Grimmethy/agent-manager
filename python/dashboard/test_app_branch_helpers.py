"""Tests for groupBranchesByHub() in app_branch_helpers.py.

Run: python3 -m unittest python.dashboard.test_app_branch_helpers -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app_branch_helpers import groupBranchesByHub  # noqa: E402


def make_branch(name, hub_id=None):
    """Helper to create a branch record with optional hub."""
    branch = {"branch": name}
    if hub_id:
        branch["hub"] = {"id": hub_id}
    return branch


class TestGroupBranchesByHub(unittest.TestCase):
    def test_empty_list_returns_empty(self):
        result = groupBranchesByHub([])
        self.assertEqual(result, [])

    def test_single_hub_groups_correctly(self):
        branches = [
            make_branch("agent/h1", "HUB0001"),
            make_branch("agent/h2", "HUB0001"),
        ]
        result = groupBranchesByHub(branches)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["hub_id"], "HUB0001")
        self.assertEqual(result[0]["position"], "1/1")
        self.assertEqual(len(result[0]["branches"]), 2)

    def test_multiple_hubs_get_positions(self):
        branches = [
            make_branch("agent/h1", "HUB0001"),
            make_branch("agent/h2", "HUB0002"),
            make_branch("agent/h3", "HUB0003"),
        ]
        result = groupBranchesByHub(branches)
        self.assertEqual(len(result), 3)
        # Sorted by hub_id
        self.assertEqual(result[0]["hub_id"], "HUB0001")
        self.assertEqual(result[0]["position"], "1/3")
        self.assertEqual(result[1]["hub_id"], "HUB0002")
        self.assertEqual(result[1]["position"], "2/3")
        self.assertEqual(result[2]["hub_id"], "HUB0003")
        self.assertEqual(result[2]["position"], "3/3")

    def test_aggregate_status_in_progress(self):
        branches = [
            make_branch("agent/h1", "HUB0001"),
            {"branch": "agent/h2", "hub": {"id": "HUB0001"}, "status": "in-progress"},
        ]
        result = groupBranchesByHub(branches)
        self.assertEqual(result[0]["status"], "in-progress")

    def test_aggregate_status_done_when_all_done(self):
        branches = [
            {"branch": "agent/h1", "hub": {"id": "HUB0001"}, "status": "done"},
            {"branch": "agent/h2", "hub": {"id": "HUB0001"}, "status": "done"},
        ]
        result = groupBranchesByHub(branches)
        self.assertEqual(result[0]["status"], "done")

    def test_unassigned_branches_get_their_own_group(self):
        branches = [
            make_branch("agent/h1", "HUB0001"),
            make_branch("agent/no-hub"),  # No hub
        ]
        result = groupBranchesByHub(branches)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["hub_id"], "HUB0001")
        self.assertEqual(result[1]["hub_id"], "unassigned")
        self.assertEqual(len(result[1]["branches"]), 1)

    def test_branches_without_hub_field_are_unassigned(self):
        branches = [
            {"branch": "agent/h1"},  # No 'hub' key at all
        ]
        result = groupBranchesByHub(branches)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["hub_id"], "unassigned")

    def test_hub_with_no_branches_not_included(self):
        # If a hub ID exists in the data but has no branches, it shouldn't appear
        branches = [
            make_branch("agent/h1", "HUB0001"),
        ]
        result = groupBranchesByHub(branches)
        hub_ids = [g["hub_id"] for g in result]
        self.assertNotIn("HUB0002", hub_ids)


if __name__ == "__main__":
    unittest.main()
