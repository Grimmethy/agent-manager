"""Tests that a branch/commit whose queue/ task record is genuinely gone (host never had
it, or it was removed outside this dashboard's own archive sweep -- distinct from the
already-covered "archived to a dated bucket" case) still resolves a real title/description
via the git-tracked task-logs/<id>.json (src/task-log-store.js), instead of silently
falling back to a bare commit subject or nothing at all. This is the "available at a
click, ever" half of the durable-task-log mechanism (2026-09-12, Grimmethy).

Run: .venv/bin/python -m unittest python.dashboard.test_task_log_fallback -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TestTaskLogFallback(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / "queue" / "done").mkdir(parents=True, exist_ok=True)
        (self.dir / "task-logs").mkdir(parents=True, exist_ok=True)

    def _write_task_log(self, task_id, **fields):
        obj = {"id": task_id, "title": "T", "domain": "default", "source": "observability_fix", "history": []}
        obj.update(fields)
        (self.dir / "task-logs" / f"{task_id}.json").write_text(json.dumps(obj))
        return obj

    def test_find_task_log_anywhere_reads_the_tracked_file(self):
        self._write_task_log("gone-1", title="A shipped fix")
        data = app._find_task_log_anywhere(self.dir, "gone-1")
        self.assertIsNotNone(data)
        self.assertEqual(data["title"], "A shipped fix")

    def test_find_task_log_anywhere_returns_none_when_nothing_exists(self):
        self.assertIsNone(app._find_task_log_anywhere(self.dir, "never-existed"))
        self.assertIsNone(app._find_task_log_anywhere(None, "gone-1"))

    def test_label_for_branch_falls_back_to_task_log_when_queue_record_is_gone(self):
        self._write_task_log("gone-2", title="A real fix nobody can find in queue/ anymore",
                              implementResponse="RESOLUTION: implemented\nfixed the real bug")
        label = app._label_for_branch("gone-2", self.dir, "fallback commit subject", repo_root=self.dir)
        self.assertEqual(label["title"], "A real fix nobody can find in queue/ anymore")
        self.assertEqual(label["matchedTaskState"], "task-log")
        self.assertEqual(label["description"], "fixed the real bug")

    def test_label_for_branch_prefers_the_live_queue_record_over_the_task_log(self):
        self._write_task_log("both-1", title="stale task-log title")
        (self.dir / "queue" / "done" / "both-1.json").write_text(json.dumps({
            "id": "both-1", "title": "live title wins", "domain": "adhoc", "source": "manual",
        }))
        label = app._label_for_branch("both-1", self.dir, "subject", repo_root=self.dir)
        self.assertEqual(label["title"], "live title wins")
        self.assertEqual(label["matchedTaskState"], "done")

    def test_label_for_branch_falls_back_to_subject_when_neither_exists(self):
        label = app._label_for_branch("truly-nothing", self.dir, "bare commit subject", repo_root=self.dir)
        self.assertEqual(label["title"], "bare commit subject")
        self.assertIsNone(label["matchedTaskState"])


if __name__ == "__main__":
    unittest.main()
