"""Integration gate: only an explicit passed/skipped (or no gate object at all) counts as clear.

A gate whose status is null, missing, or unresolved (pending/running/failed) must NOT make a
hub readyToMerge, otherwise a hub whose gate never evaluated could be merged as if it passed.

Run: python3 python/dashboard/tests/test_summarize_hub_gate.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app_branch_helpers as helpers  # noqa: E402


BUILT_SUBS = [
    {"id": "a", "status": "pending-merge", "phase": "built"},
    {"id": "b", "status": "pending-merge", "phase": "built"},
]


def hub(state="coordinating", **extra):
    return helpers._summarize_hub({"id": "hub-1", "title": "T", "subTasks": BUILT_SUBS, **extra}, state)


class TestIntegrationGateClear(unittest.TestCase):
    def test_null_status_is_not_clear(self):
        self.assertFalse(hub(integrationGate={"status": None})["readyToMerge"])

    def test_gate_object_without_status_key_is_not_clear(self):
        self.assertFalse(hub(integrationGate={"checks": []})["readyToMerge"])

    def test_missing_gate_object_stays_clear(self):
        # Non-stacked hubs never get an integrationGate object; they keep their old result.
        self.assertTrue(hub()["readyToMerge"])

    def test_passed_and_skipped_are_clear(self):
        self.assertTrue(hub(integrationGate={"status": "passed"})["readyToMerge"])
        self.assertTrue(hub(integrationGate={"status": "skipped"})["readyToMerge"])

    def test_unresolved_statuses_are_not_clear(self):
        for status in ("pending", "running", "failed", "errored"):
            with self.subTest(status=status):
                self.assertFalse(hub(integrationGate={"status": status})["readyToMerge"])

    def test_done_hub_is_ready_regardless_of_gate(self):
        self.assertTrue(hub(state="done", integrationGate={"status": "failed"})["readyToMerge"])


if __name__ == "__main__":
    unittest.main()
