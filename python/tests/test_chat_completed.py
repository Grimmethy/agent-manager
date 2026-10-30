"""Tests for chat sessions appearing in the completed tasks log.

Covers the chat-session branch of _scan_recently_completed_tasks and the
GET /api/tasks/completed endpoint: that sessions stored in
.agent-manager-chat-sessions.json surface as rows with instanceId='chat',
source='chat', outcome='chat turn', and that sessions with recent activity
(within 30s) are excluded to avoid racing with in-flight turns.

Run: .venv/bin/python -m unittest python.tests.test_chat_completed -v
"""
import json
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent / "dashboard"))

import app  # noqa: E402


class TestChatCompletedLog(unittest.TestCase):
    """Chat sessions should appear in the completed log with the right shape."""

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.storage_dir = Path(self._tmp.name)
        self.queue_dir = self.storage_dir / "queue"
        (self.queue_dir / "done").mkdir(parents=True)
        self._patches = [
            mock.patch.object(app, "PACKAGE_ROOT", self.storage_dir),
            mock.patch.object(app, "queue_dir", return_value=self.queue_dir),
        ]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _write_sessions(self, sessions):
        path = self.storage_dir / ".agent-manager-chat-sessions.json"
        path.write_text(json.dumps(sessions), encoding="utf-8")
        return path

    def _make_session(self, session_id, started_at, ended_at, model="qwen2.5:3b",
                      transcript=None, status="completed"):
        return {
            "id": session_id,
            "model": model,
            "status": status,
            "startedAt": started_at,
            "endedAt": ended_at,
            "transcript": transcript or [],
        }

    def test_chat_sessions_appear_in_completed_results(self):
        """Chat sessions should show up in the completed log alongside tasks."""
        self._write_sessions({
            "chat-123": self._make_session(
                "chat-123",
                "2026-09-08T01:00:00Z",
                "2026-09-08T01:05:00Z",
                transcript=[
                    {"role": "user", "text": "Hello"},
                    {"role": "assistant", "text": "Hi there"},
                ],
            ),
        })
        resp = self.client.get("/api/tasks/completed?limit=100")
        data = resp.get_json()
        chat_rows = [r for r in data["tasks"] if r.get("source") == "chat"]
        self.assertEqual(len(chat_rows), 1)
        self.assertEqual(chat_rows[0]["taskId"], "chat-123")
        self.assertEqual(chat_rows[0]["instanceId"], "chat")
        self.assertEqual(chat_rows[0]["outcome"], "chat turn")

    def test_chat_sessions_appear_after_tasks(self):
        """Chat sessions are appended after task rows in the completed log."""
        # Write a task with an old mtime
        task_path = self.queue_dir / "done" / "old-task.json"
        task_path.write_text(json.dumps({
            "id": "old-task",
            "title": "Old Task",
            "source": "adhoc",
            "draftModel": "qwen2.5:3b",
            "claimedBy": "worker-1",
            "terminalDisposition": "merged",
            "history": [{"stage": "applied", "at": "2026-09-08T00:00:00Z"}],
        }), encoding="utf-8")
        # Make the task file older than the chat session
        import os
        os.utime(task_path, (time.time() - 1000, time.time() - 1000))
        
        self._write_sessions({
            "chat-recent": self._make_session(
                "chat-recent",
                "2026-09-08T05:00:00Z",
                "2026-09-08T05:05:00Z",
            ),
        })
        resp = self.client.get("/api/tasks/completed?limit=100")
        data = resp.get_json()
        # The task should appear first (it was scanned first), then the chat session
        self.assertEqual(len(data["tasks"]), 2)
        self.assertEqual(data["tasks"][0]["taskId"], "old-task")
        self.assertEqual(data["tasks"][1]["taskId"], "chat-recent")

    def test_session_fields_correct(self):
        """Each chat session row should have the right fields."""
        self._write_sessions({
            "chat-456": self._make_session(
                "chat-456",
                "2026-09-08T03:00:00Z",
                "2026-09-08T03:15:00Z",
                model="claude-3-5-sonnet",
                transcript=[
                    {"role": "user", "text": "What is the capital of France?"},
                    {"role": "assistant", "text": "Paris"},
                    {"role": "user", "text": "Thanks"},
                    {"role": "assistant", "text": "You're welcome"},
                ],
            ),
        })
        resp = self.client.get("/api/tasks/completed?limit=100")
        data = resp.get_json()
        chat_rows = [r for r in data["tasks"] if r.get("source") == "chat"]
        self.assertEqual(len(chat_rows), 1)
        row = chat_rows[0]
        self.assertEqual(row["taskId"], "chat-456")
        self.assertEqual(row["title"], "What is the capital of France?")
        self.assertEqual(row["source"], "chat")
        self.assertEqual(row["model"], "claude-3-5-sonnet")
        self.assertEqual(row["instanceId"], "chat")
        self.assertEqual(row["outcome"], "chat turn")
        self.assertEqual(row["session_id"], "chat-456")
        self.assertEqual(row["duration"], 900)  # 15 minutes in seconds
        self.assertEqual(row["turns_used"], 2)

    def test_empty_sessions_file_returns_no_chat_rows(self):
        """No sessions file means no chat rows in the completed log."""
        resp = self.client.get("/api/tasks/completed?limit=100")
        data = resp.get_json()
        chat_rows = [r for r in data["tasks"] if r.get("source") == "chat"]
        self.assertEqual(len(chat_rows), 0)

    def test_active_sessions_with_recent_activity_appeared(self):
        """Sessions with recent activity (within 30s) are excluded, but 'active' status itself is not filtered."""
        # An 'active' session with old activity should still appear (status is not checked)
        self._write_sessions({
            "chat-active-old": self._make_session(
                "chat-active-old",
                "2026-09-08T01:00:00Z",
                "2026-09-08T01:05:00Z",
                status="active",
            ),
        })
        resp = self.client.get("/api/tasks/completed?limit=100")
        data = resp.get_json()
        chat_rows = [r for r in data["tasks"] if r.get("source") == "chat"]
        self.assertEqual(len(chat_rows), 1)
        self.assertEqual(chat_rows[0]["taskId"], "chat-active-old")

    def test_recent_sessions_excluded(self):
        """Sessions with last activity within 30s should be excluded (racing with in-flight turn)."""
        now = time.time()
        recent_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 10))
        self._write_sessions({
            "chat-recent": self._make_session(
                "chat-recent",
                recent_iso,
                recent_iso,
            ),
        })
        resp = self.client.get("/api/tasks/completed?limit=100")
        data = resp.get_json()
        chat_rows = [r for r in data["tasks"] if r.get("source") == "chat"]
        self.assertEqual(len(chat_rows), 0)


if __name__ == "__main__":
    unittest.main()
