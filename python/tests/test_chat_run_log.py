"""Tests for chat rows in the run log (HUB0254).

Covers that chat sessions appear under instance_id='chat' in the run-log endpoint,
do not leak into worker lanes, and are sorted newest-first. Follows the pattern in
python/dashboard/test_completed_tasks_log.py for fixture setup and API calls.

Run: .venv/bin/python -m unittest python.tests.test_chat_run_log -v
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
import chat_sessions  # noqa: E402


INSTANCE_ID = "chat"
STAGE = "chat"
OUTCOME = "chat turn"


class ChatRunLogTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.queue = root / "queue"
        (self.queue / "done").mkdir(parents=True)
        self.instances_dir = self.queue.parent / "instances"
        self.instances_dir.mkdir(parents=True, exist_ok=True)
        self.chat_storage_dir = root / "chat-storage"
        self.chat_storage_dir.mkdir(parents=True, exist_ok=True)
        self._patches = [
            mock.patch.object(app, "queue_dir", return_value=self.queue),
            mock.patch.object(app, "instances_dir", return_value=self.instances_dir),
            mock.patch.object(app, "CHAT_STORAGE_DIR", new=self.chat_storage_dir),
        ]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _write_chat_sessions(self, sessions):
        """sessions: dict of session_id -> session dict."""
        sessions_file = self.chat_storage_dir / ".agent-manager-chat-sessions.json"
        sessions_file.write_text(json.dumps(sessions), encoding="utf-8")
        return sessions_file


class TestChatRowsAppearUnderChatInstance(ChatRunLogTestBase):
    def test_chat_rows_appear_when_instance_is_chat(self):
        self._write_chat_sessions({
            "session-1": {
                "status": "ended",
                "startedAt": "2026-09-08T05:00:00Z",
                "endedAt": "2026-09-08T05:05:00Z",
                "model": "qwen2.5:3b",
                "transcript": [
                    {"role": "user", "text": "Hello"},
                    {"role": "assistant", "text": "Hi there"},
                ],
            }
        })
        resp = self.client.get(f"/api/instances/{INSTANCE_ID}/run-log")
        data = resp.get_json()
        chat_rows = [r for r in data["runs"] if r.get("stage") == STAGE]
        self.assertEqual(len(chat_rows), 1)
        row = chat_rows[0]
        for key in ("session_id", "model", "duration", "turns_used", "outcome"):
            self.assertIn(key, row, f"Missing key '{key}' in chat row")
        self.assertEqual(row["session_id"], "session-1")
        self.assertEqual(row["model"], "qwen2.5:3b")
        self.assertEqual(row["turns_used"], 2)
        self.assertEqual(row["outcome"], OUTCOME)

    def test_chat_rows_include_duration_in_milliseconds(self):
        self._write_chat_sessions({
            "session-duration": {
                "status": "ended",
                "startedAt": "2026-09-08T05:00:00Z",
                "endedAt": "2026-09-08T05:05:00Z",
                "model": "qwen3.8:27b-q4_K_M",
                "transcript": [
                    {"role": "user", "text": "Test"},
                    {"role": "assistant", "text": "Response"},
                ],
            }
        })
        resp = self.client.get(f"/api/instances/{INSTANCE_ID}/run-log")
        data = resp.get_json()
        chat_rows = [r for r in data["runs"] if r.get("stage") == STAGE]
        self.assertEqual(len(chat_rows), 1)
        row = chat_rows[0]
        self.assertIn("duration", row)
        self.assertEqual(row["duration"], 300000)  # 5 minutes in ms

    def test_active_chat_session_included(self):
        self._write_chat_sessions({
            "session-active": {
                "status": "active",
                "startedAt": "2026-09-08T05:10:00Z",
                "model": "qwen2.5:3b",
                "transcript": [
                    {"role": "user", "text": "Active session"},
                ],
            }
        })
        resp = self.client.get(f"/api/instances/{INSTANCE_ID}/run-log")
        data = resp.get_json()
        chat_rows = [r for r in data["runs"] if r.get("stage") == STAGE]
        self.assertEqual(len(chat_rows), 1)
        self.assertEqual(chat_rows[0]["session_id"], "session-active")


class TestChatRowsDoNotAppearUnderWorkerLanes(ChatRunLogTestBase):
    def test_worker_lane_sees_no_chat_rows(self):
        self._write_chat_sessions({
            "session-worker": {
                "status": "ended",
                "startedAt": "2026-09-08T05:00:00Z",
                "endedAt": "2026-09-08T05:05:00Z",
                "model": "qwen2.5:3b",
                "transcript": [
                    {"role": "user", "text": "Worker session"},
                    {"role": "assistant", "text": "Response"},
                ],
            }
        })
        resp = self.client.get("/api/instances/worker-1/run-log")
        data = resp.get_json()
        chat_rows = [r for r in data["runs"] if r.get("stage") == STAGE]
        self.assertEqual(len(chat_rows), 0)

    def test_reviewer_lane_sees_no_chat_rows(self):
        self._write_chat_sessions({
            "session-reviewer": {
                "status": "ended",
                "startedAt": "2026-09-08T05:00:00Z",
                "endedAt": "2026-09-08T05:05:00Z",
                "model": "qwen2.5:3b",
                "transcript": [
                    {"role": "user", "text": "Reviewer session"},
                    {"role": "assistant", "text": "Response"},
                ],
            }
        })
        resp = self.client.get("/api/instances/reviewer/run-log")
        data = resp.get_json()
        chat_rows = [r for r in data["runs"] if r.get("stage") == STAGE]
        self.assertEqual(len(chat_rows), 0)

    def test_non_chat_instance_filter_works(self):
        """Sanity: other instances don't see chat rows even when chat sessions exist."""
        self._write_chat_sessions({
            "session-any": {
                "status": "ended",
                "startedAt": "2026-09-08T05:00:00Z",
                "endedAt": "2026-09-08T05:05:00Z",
                "model": "qwen2.5:3b",
                "transcript": [
                    {"role": "user", "text": "Any instance"},
                    {"role": "assistant", "text": "Response"},
                ],
            }
        })
        for instance in ["worker-reasoning", "agent-1", "system"]:
            resp = self.client.get(f"/api/instances/{instance}/run-log")
            data = resp.get_json()
            chat_rows = [r for r in data["runs"] if r.get("stage") == STAGE]
            self.assertEqual(len(chat_rows), 0, f"Instance '{instance}' should not see chat rows")


class TestChatRowsSortedNewestFirst(ChatRunLogTestBase):
    def test_newest_chat_session_appears_first(self):
        self._write_chat_sessions({
            "session-old": {
                "status": "ended",
                "startedAt": "2026-09-08T04:00:00Z",
                "endedAt": "2026-09-08T04:05:00Z",
                "model": "qwen2.5:3b",
                "transcript": [
                    {"role": "user", "text": "Old session"},
                    {"role": "assistant", "text": "Response"},
                ],
            },
            "session-new": {
                "status": "ended",
                "startedAt": "2026-09-08T05:00:00Z",
                "endedAt": "2026-09-08T05:05:00Z",
                "model": "qwen2.5:3b",
                "transcript": [
                    {"role": "user", "text": "New session"},
                    {"role": "assistant", "text": "Response"},
                ],
            },
        })
        resp = self.client.get(f"/api/instances/{INSTANCE_ID}/run-log")
        data = resp.get_json()
        chat_rows = [r for r in data["runs"] if r.get("stage") == STAGE]
        self.assertEqual(len(chat_rows), 2)
        self.assertEqual(chat_rows[0]["session_id"], "session-new")
        self.assertEqual(chat_rows[1]["session_id"], "session-old")

    def test_chat_rows_sorted_before_model_calls_rows(self):
        """Mixed ordering: chat sessions and model_calls rows should all be newest-first."""
        self._write_chat_sessions({
            "session-mid": {
                "status": "ended",
                "startedAt": "2026-09-08T04:30:00Z",
                "endedAt": "2026-09-08T04:35:00Z",
                "model": "qwen2.5:3b",
                "transcript": [
                    {"role": "user", "text": "Mid session"},
                    {"role": "assistant", "text": "Response"},
                ],
            }
        })
        # Also add a model_calls row via the DB
        import sqlite3
        db_tmp = TemporaryDirectory()
        db_path = Path(db_tmp.name) / "model-stats.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("""
            CREATE TABLE model_calls (
                call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT, model TEXT,
                started_at TEXT NOT NULL, outcome TEXT, outcome_stage TEXT, outcome_at TEXT,
                instance_id TEXT, latency_ms INTEGER
            )
        """)
        conn.execute(
            "INSERT INTO model_calls (call_id, task_id, stage, model, started_at, outcome, instance_id, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("c-old", "task-old", "applied", "qwen3.8:27b-q4_K_M", "2026-09-08T04:00:00Z", "merged", INSTANCE_ID, 5000),
        )
        conn.execute(
            "INSERT INTO model_calls (call_id, task_id, stage, model, started_at, outcome, instance_id, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("c-new", "task-new", "applied", "qwen2.5:3b", "2026-09-08T05:00:00Z", "merged", INSTANCE_ID, 3000),
        )
        conn.commit()
        conn.close()
        db_tmp.cleanup()
        with mock.patch.object(app, "model_stats_db_path", return_value=db_path):
            resp = self.client.get(f"/api/instances/{INSTANCE_ID}/run-log")
            data = resp.get_json()
        # All rows (chat + model_calls) should be sorted newest first
        all_rows = data["runs"]
        self.assertGreater(len(all_rows), 0)
        # Verify ordering by 'at' field
        for i in range(len(all_rows) - 1):
            self.assertGreaterEqual(all_rows[i]["at"], all_rows[i + 1]["at"])


def _make_model_calls_db(db_path, rows):
    """rows: list of (call_id, task_id, instance_id, started_at, outcome)"""
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE model_calls (
            call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT, model TEXT,
            started_at TEXT NOT NULL, outcome TEXT, outcome_stage TEXT, outcome_at TEXT,
            instance_id TEXT, latency_ms INTEGER
        )
    """)
    for call_id, task_id, instance_id, started_at, outcome in rows:
        conn.execute(
            "INSERT INTO model_calls (call_id, task_id, instance_id, started_at, model, outcome) VALUES (?, ?, ?, ?, 'qwen2.5:3b', ?)",
            (call_id, task_id, instance_id, started_at, outcome),
        )
    conn.commit()
    conn.close()
