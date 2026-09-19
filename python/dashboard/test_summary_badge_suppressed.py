"""/api/summary's brain-dump and filed nav badges must not count suppressed entries.

Live 2026-09-19: Filed Findings badge said 13 while the tab listed 5 -- the list view hides
`suppressed` entries but the badge counted them.

Run: .venv/bin/python -m unittest python.dashboard.test_summary_badge_suppressed -v
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class SummaryBadgeSuppressedTest(unittest.TestCase):
    def test_suppressed_entries_not_counted(self):
        entries = [
            {"id": "a", "raisedBy": {"taskId": "t"}, "status": "captured"},
            {"id": "b", "raisedBy": {"taskId": "t"}, "status": "captured", "suppressed": True},
            {"id": "c", "raisedBy": {"taskId": "t"}, "status": "sorted", "suppressed": True},
            {"id": "d", "status": "captured"},
            {"id": "e", "status": "captured", "suppressed": True},
        ]
        with mock.patch.object(app, "_brain_dump_entries_with_task_status", return_value=entries), \
             mock.patch.object(app, "list_unmerged_branches", return_value=[]), \
             mock.patch.object(app, "queue_dir", return_value=None):
            data = app.app.test_client().get("/api/summary").get_json()
        self.assertEqual(data["filed"], 1)
        self.assertEqual(data["brain-dump"], 1)


if __name__ == "__main__":
    unittest.main()
