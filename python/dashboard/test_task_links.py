"""Tests for Task Linking's Python-side reverse lookup (2026-09-08) -- the one
relationship in the task detail modal that can't be read from the task's own JSON, since
it lives in a DIFFERENT task's links[], written via task-links-client.js's recordLink()
into a real SQLite db (task-links.db). Covers `_incoming_task_links()` directly against a
real fixture db, and confirms `/api/task/<state>/<id>` carries `_incomingLinks` in its
response.

Run: .venv/bin/python -m unittest python.dashboard.test_task_links -v
"""
import json
import sqlite3
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


def make_task_links_db(db_path, rows):
    """rows: list of (source_id, target_id, type, label, created_at) tuples -- mirrors
    task-links-db.js's real schema exactly (task_links table, same column names)."""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE task_links (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_id TEXT NOT NULL,
              target_id TEXT NOT NULL,
              type TEXT NOT NULL,
              label TEXT,
              created_at TEXT NOT NULL
            )
            """
        )
        conn.executemany(
            "INSERT INTO task_links (source_id, target_id, type, label, created_at) VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    finally:
        conn.close()


class TestIncomingTaskLinks(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "task-links.db"

    def tearDown(self):
        self._tmp.cleanup()

    def test_returns_every_link_pointing_at_the_target_task(self):
        make_task_links_db(self.db_path, [
            ("task-a", "task-b", "relates-to", "same root cause", "2026-09-08T00:00:00Z"),
            ("task-c", "task-b", "contributes-to-signature", None, "2026-09-08T01:00:00Z"),
            ("task-a", "task-x", "relates-to", None, "2026-09-08T02:00:00Z"),  # different target, must not show up
        ])
        with mock.patch.object(app, "task_links_db_path", return_value=self.db_path):
            links = app._incoming_task_links("task-b")
        self.assertEqual(len(links), 2)
        source_ids = {l["sourceId"] for l in links}
        self.assertEqual(source_ids, {"task-a", "task-c"})
        with_label = next(l for l in links if l["sourceId"] == "task-a")
        self.assertEqual(with_label["label"], "same root cause")
        self.assertEqual(with_label["type"], "relates-to")
        no_label = next(l for l in links if l["sourceId"] == "task-c")
        self.assertIsNone(no_label["label"])

    def test_returns_empty_list_not_none_when_db_does_not_exist_yet(self):
        never_created = Path(self._tmp.name) / "never-created.db"
        with mock.patch.object(app, "task_links_db_path", return_value=never_created):
            links = app._incoming_task_links("task-b")
        self.assertEqual(links, [])

    def test_returns_empty_list_when_nothing_points_at_this_task(self):
        make_task_links_db(self.db_path, [
            ("task-a", "task-x", "relates-to", None, "2026-09-08T00:00:00Z"),
        ])
        with mock.patch.object(app, "task_links_db_path", return_value=self.db_path):
            links = app._incoming_task_links("task-b")
        self.assertEqual(links, [])


class TestOutgoingTaskLinks(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "task-links.db"

    def tearDown(self):
        self._tmp.cleanup()

    def test_returns_every_link_originating_from_the_source_task(self):
        make_task_links_db(self.db_path, [
            ("task-b", "task-a", "relates-to", "same root cause", "2026-09-08T00:00:00Z"),
            ("task-b", "task-c", "contributes-to-signature", None, "2026-09-08T01:00:00Z"),
            ("task-x", "task-a", "relates-to", None, "2026-09-08T02:00:00Z"),  # different source, must not show up
        ])
        with mock.patch.object(app, "task_links_db_path", return_value=self.db_path):
            links = app._outgoing_task_links("task-b")
        self.assertEqual(len(links), 2)
        target_ids = {l["targetId"] for l in links}
        self.assertEqual(target_ids, {"task-a", "task-c"})

    def test_returns_empty_list_not_none_when_db_does_not_exist_yet(self):
        never_created = Path(self._tmp.name) / "never-created.db"
        with mock.patch.object(app, "task_links_db_path", return_value=never_created):
            links = app._outgoing_task_links("task-b")
        self.assertEqual(links, [])


class TestTaskDetailEndpointCarriesIncomingLinks(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.queue = root / "queue"
        (self.queue / "blocked").mkdir(parents=True)
        self.db_path = root / "task-links.db"
        self._patches = [
            mock.patch.object(app, "queue_dir", return_value=self.queue),
            mock.patch.object(app, "task_links_db_path", return_value=self.db_path),
        ]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _write(self, task_id):
        task = {"id": task_id, "domain": "adhoc", "source": "manual", "title": "t", "history": []}
        (self.queue / "blocked" / f"{task_id}.json").write_text(json.dumps(task), encoding="utf-8")

    def test_incomingLinks_present_and_populated_when_a_real_link_exists(self):
        self._write("task-b")
        make_task_links_db(self.db_path, [
            ("task-a", "task-b", "relates-to", "same root cause", "2026-09-08T00:00:00Z"),
        ])
        res = self.client.get("/api/task/blocked/task-b")
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertIn("_incomingLinks", body)
        self.assertEqual(len(body["_incomingLinks"]), 1)
        self.assertEqual(body["_incomingLinks"][0]["sourceId"], "task-a")

    def test_incomingLinks_is_an_empty_list_when_the_db_does_not_exist(self):
        self._write("task-b")
        res = self.client.get("/api/task/blocked/task-b")
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertEqual(body["_incomingLinks"], [])

    def test_outgoingLinks_present_and_populated_when_a_real_link_exists(self):
        self._write("task-b")
        make_task_links_db(self.db_path, [
            ("task-b", "task-c", "contributes-to-signature", None, "2026-09-08T00:00:00Z"),
        ])
        res = self.client.get("/api/task/blocked/task-b")
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertIn("_outgoingLinks", body)
        self.assertEqual(len(body["_outgoingLinks"]), 1)
        self.assertEqual(body["_outgoingLinks"][0]["targetId"], "task-c")


if __name__ == "__main__":
    unittest.main()
