"""Tests for POST /api/task-anywhere/<id>/hub-priority (2026-09-09, Grimmethy: "I'd like
the hubs to be sortable ... by priority. Priority tagging for hubs doesn't exist yet ...
The highest priority hub should always be worked on next until it is either ready to merge
or gets blocked").

Covers the dashboard route only: stamping/clearing `hubPriority` on a coordinating hub's
JSON, the integer/null contract, the history event, and rejecting a non-hub target. The
sort + claim-order side of the feature lives in python/dashboard/test_hub_tasks_hierarchy.py
(TestHubSort) and src/hub-priority.test.js.

Run: .venv/bin/python -m unittest python.dashboard.test_hub_priority -v
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class HubPriorityTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.queue = root / "queue"
        for d in ["coordinating", "pending"]:
            (self.queue / d).mkdir(parents=True)
        self._patches = [mock.patch.object(app, "queue_dir", return_value=self.queue)]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _write_hub(self, hub_id, extra=None):
        hub = {"id": hub_id, "domain": "adhoc", "source": "manual", "status": "coordinating",
               "title": hub_id, "subTasks": [], "history": []}
        if extra:
            hub.update(extra)
        p = self.queue / "coordinating" / f"{hub_id}.json"
        p.write_text(json.dumps(hub, indent=2), encoding="utf-8")
        return p

    def _read(self, path):
        return json.loads(path.read_text(encoding="utf-8"))


class TestSetHubPriority(HubPriorityTestBase):
    def test_sets_an_integer_priority(self):
        p = self._write_hub("hub-1")
        res = self.client.post("/api/task-anywhere/hub-1/hub-priority", json={"priority": 5})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json(), {"id": "hub-1", "hubPriority": 5})
        self.assertEqual(self._read(p)["hubPriority"], 5)

    def test_accepts_a_negative_priority(self):
        p = self._write_hub("hub-1")
        self.client.post("/api/task-anywhere/hub-1/hub-priority", json={"priority": -3})
        self.assertEqual(self._read(p)["hubPriority"], -3)

    def test_coerces_a_numeric_string(self):
        p = self._write_hub("hub-1")
        res = self.client.post("/api/task-anywhere/hub-1/hub-priority", json={"priority": "12"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self._read(p)["hubPriority"], 12)

    def test_null_priority_clears_the_field(self):
        p = self._write_hub("hub-1", {"hubPriority": 7})
        res = self.client.post("/api/task-anywhere/hub-1/hub-priority", json={"priority": None})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json(), {"id": "hub-1", "hubPriority": None})
        self.assertNotIn("hubPriority", self._read(p))

    def test_missing_priority_key_clears_the_field(self):
        p = self._write_hub("hub-1", {"hubPriority": 7})
        self.client.post("/api/task-anywhere/hub-1/hub-priority", json={})
        self.assertNotIn("hubPriority", self._read(p))

    def test_non_numeric_priority_400s(self):
        self._write_hub("hub-1")
        res = self.client.post("/api/task-anywhere/hub-1/hub-priority", json={"priority": "soon"})
        self.assertEqual(res.status_code, 400)

    def test_appends_a_history_event(self):
        p = self._write_hub("hub-1")
        self.client.post("/api/task-anywhere/hub-1/hub-priority", json={"priority": 2})
        history = self._read(p)["history"]
        self.assertEqual(len(history), 1)
        self.assertIn("hub priority set to 2", history[0]["detail"])

    def test_clearing_logs_a_distinct_history_event(self):
        p = self._write_hub("hub-1", {"hubPriority": 4})
        self.client.post("/api/task-anywhere/hub-1/hub-priority", json={"priority": None})
        self.assertIn("hub priority cleared", self._read(p)["history"][-1]["detail"])

    def test_a_non_hub_task_404s(self):
        # Only a coordinating record is a valid target -- a pending task is not.
        (self.queue / "pending" / "t1.json").write_text(
            json.dumps({"id": "t1", "history": []}), encoding="utf-8")
        res = self.client.post("/api/task-anywhere/t1/hub-priority", json={"priority": 1})
        self.assertEqual(res.status_code, 404)

    def test_unknown_id_404s(self):
        res = self.client.post("/api/task-anywhere/nope/hub-priority", json={"priority": 1})
        self.assertEqual(res.status_code, 404)


if __name__ == "__main__":
    unittest.main()
