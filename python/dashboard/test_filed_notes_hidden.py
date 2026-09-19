"""Machine findings the sorter already filed as SecondBrain notes are not "unprocessed".

2026-09-19: 315 of agent-manager's 396 unprocessed Filed Findings were `sorted` entries whose
note already existed -- nothing left to act on, but the tab and badge counted them.

Run: .venv/bin/python -m unittest python.dashboard.test_filed_notes_hidden -v
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes.brain_dump import is_filed_note  # noqa: E402

NOTE = {"secondBrainPath": "Research/x.md"}
ENTRIES = [
    {"id": "cap", "raisedBy": {"taskId": "t"}, "status": "captured", "capturedAt": "1"},
    {"id": "note", "raisedBy": {"taskId": "t"}, "status": "sorted", "sort": NOTE, "capturedAt": "2"},
    {"id": "note-actionable-noproject", "raisedBy": {"taskId": "t"}, "status": "sorted",
     "sort": {**NOTE, "actionable": True, "belongsToProject": None}, "capturedAt": "3"},
    {"id": "sorted-no-note", "raisedBy": {"taskId": "t"}, "status": "sorted", "sort": {}, "capturedAt": "4"},
    {"id": "sorted-queued", "raisedBy": {"taskId": "t"}, "status": "sorted", "sort": NOTE, "queuedTaskId": "q", "capturedAt": "5"},
    {"id": "human-sorted", "status": "sorted", "sort": NOTE, "capturedAt": "6"},
]


class FiledNotesHiddenTest(unittest.TestCase):
    def _ids(self, query, path="/api/filed-findings"):
        with mock.patch.object(app, "_brain_dump_entries_with_task_status", return_value=[dict(e) for e in ENTRIES]):
            return {e["id"] for e in app.app.test_client().get(path + query).get_json()}

    def test_is_filed_note(self):
        self.assertEqual({e["id"] for e in ENTRIES if is_filed_note(e)},
                         {"note", "note-actionable-noproject", "human-sorted"})

    def test_default_view_hides_filed_notes_for_machine_findings(self):
        self.assertEqual(self._ids(""), {"cap", "sorted-no-note", "sorted-queued"})

    def test_filed_filter_and_all(self):
        self.assertEqual(self._ids("?status=filed"), {"note", "note-actionable-noproject"})
        self.assertEqual(self._ids("?status=all"), {"cap", "note", "note-actionable-noproject", "sorted-no-note", "sorted-queued"})

    def test_human_brain_dump_tab_unchanged(self):
        self.assertEqual(self._ids("", "/api/brain-dump"), {"human-sorted"})

    def test_badge_excludes_filed_notes(self):
        with mock.patch.object(app, "_brain_dump_entries_with_task_status", return_value=[dict(e) for e in ENTRIES]), \
             mock.patch.object(app, "list_unmerged_branches", return_value=[]), \
             mock.patch.object(app, "queue_dir", return_value=None):
            data = app.app.test_client().get("/api/summary").get_json()
        self.assertEqual(data["filed"], 3)


if __name__ == "__main__":
    unittest.main()
