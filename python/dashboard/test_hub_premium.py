"""Unit tests for hub_premium.set_hub_premium with in-memory fakes.

Run: python3 -I -m unittest python/dashboard/test_hub_premium.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import hub_premium  # noqa: E402

NOW = "2026-11-21T00:00:00Z"


class Store:
    def __init__(self, pieces):
        self.pieces = pieces
        self.writes = []

    def find(self, pid):
        return self.pieces.get(pid)

    def write(self, piece):
        self.writes.append(piece["id"])


def hub(*ids):
    return {"id": "hub-1", "subTasks": [{"id": i} for i in ids]}


class TestSetHubPremium(unittest.TestCase):
    def test_unfinished_piece_in_progress_gets_premium_and_is_changed(self):
        store = Store({"A": {"id": "A", "status": "in_progress", "premiumPriority": None}})
        changed, missing = hub_premium.set_hub_premium(hub("A"), True, store.find, store.write, NOW)
        self.assertEqual(changed, ["A"])
        self.assertEqual(missing, [])
        self.assertEqual(store.pieces["A"]["premiumPriority"], NOW)
        self.assertEqual(store.writes, ["A"])

    def test_mixed_hub_changed_skipped_and_missing(self):
        store = Store({
            "A": {"id": "A", "status": "pending", "premiumPriority": None},
            "B": {"id": "B", "status": "done", "premiumPriority": None},
        })
        skipped = []
        changed, missing = hub_premium.set_hub_premium(
            hub("A", "B", "C"), True, store.find, store.write, NOW,
            on_skip=lambda pid, st: skipped.append((pid, st)))
        self.assertEqual(changed, ["A"])
        self.assertEqual(missing, ["C"])
        self.assertEqual(skipped, [("B", "done")])
        self.assertIsNone(store.pieces["B"]["premiumPriority"])
        self.assertEqual(store.writes, ["A"])

    def test_piece_already_holding_value_is_not_written(self):
        store = Store({"A": {"id": "A", "status": "pending", "premiumPriority": NOW}})
        changed, _ = hub_premium.set_hub_premium(hub("A"), True, store.find, store.write, "2026-12-01T00:00:00Z")
        self.assertEqual(changed, [])
        self.assertEqual(store.writes, [])
        self.assertEqual(store.pieces["A"]["premiumPriority"], NOW)

    def test_disable_clears_unfinished_pieces_only(self):
        store = Store({
            "A": {"id": "A", "status": "blocked", "premiumPriority": NOW},
            "B": {"id": "B", "status": "archived", "premiumPriority": NOW},
        })
        changed, missing = hub_premium.set_hub_premium(hub("A", "B"), False, store.find, store.write, NOW)
        self.assertEqual(changed, ["A"])
        self.assertEqual(missing, [])
        self.assertIsNone(store.pieces["A"]["premiumPriority"])
        self.assertEqual(store.pieces["B"]["premiumPriority"], NOW)
        self.assertEqual(store.writes, ["A"])

    def test_casing_variant_of_finished_status_is_treated_as_unfinished(self):
        store = Store({"A": {"id": "A", "status": "Done", "premiumPriority": None}})
        changed, _ = hub_premium.set_hub_premium(hub("A"), True, store.find, store.write, NOW)
        self.assertEqual(changed, ["A"])

    def test_empty_hub_changes_nothing(self):
        store = Store({})
        self.assertEqual(hub_premium.set_hub_premium({"subTasks": []}, True, store.find, store.write, NOW), ([], []))


if __name__ == "__main__":
    unittest.main()
