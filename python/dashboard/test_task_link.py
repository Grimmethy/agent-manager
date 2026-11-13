"""Tests for POST /api/task-anywhere/<id>/link: a typed link between two task records, written in place wherever the record sits (done included), idempotent, validated.

Run: .venv/bin/python -m unittest python.dashboard.test_task_link -v
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TaskLinkTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.queue = Path(self._tmp.name) / "queue"
        for d in ["pending", "blocked", "done", "adhoc"]:
            (self.queue / d).mkdir(parents=True)
        self._patch = mock.patch.object(app, "queue_dir", return_value=self.queue)
        self._patch.start()
        self.client = app.app.test_client()

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def _write(self, state_dir, task_id, extra=None):
        task = {"id": task_id, "domain": "adhoc", "source": "manual", "title": "t", "history": []}
        if extra:
            task.update(extra)
        p = self.queue / state_dir / f"{task_id}.json"
        p.write_text(json.dumps(task, indent=2), encoding="utf-8")
        return p

    def _read(self, path):
        return json.loads(path.read_text(encoding="utf-8"))


class TestTaskLink(TaskLinkTestBase):
    def test_adds_a_link_with_branch_by_and_note_to_a_done_record_and_a_history_event(self):
        p = self._write("done", "old-1")
        res = self.client.post("/api/task-anywhere/old-1/link", json={"kind": "replaced-by", "taskId": "new-1", "branch": "agent/new-1", "by": "needswork-worker", "note": "needs-work replacement"})
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertTrue(body["added"])
        saved = self._read(p)
        self.assertEqual(len(saved["links"]), 1)
        link = saved["links"][0]
        self.assertEqual([link["kind"], link["taskId"], link["branch"], link["by"], link["note"]], ["replaced-by", "new-1", "agent/new-1", "needswork-worker", "needs-work replacement"])
        self.assertIn("at", link)
        self.assertEqual(len(saved["history"]), 1)
        self.assertIn("linked: replaced-by new-1", saved["history"][0]["detail"])

    def test_the_same_kind_and_task_is_not_added_twice_but_another_kind_is(self):
        p = self._write("pending", "t1")
        first = self.client.post("/api/task-anywhere/t1/link", json={"kind": "repaired-by", "taskId": "r1"})
        again = self.client.post("/api/task-anywhere/t1/link", json={"kind": "repaired-by", "taskId": "r1"})
        other = self.client.post("/api/task-anywhere/t1/link", json={"kind": "replaced-by", "taskId": "r1"})
        self.assertEqual([first.get_json()["added"], again.get_json()["added"], other.get_json()["added"]], [True, False, True])
        saved = self._read(p)
        self.assertEqual(len(saved["links"]), 2)
        self.assertEqual(len(saved["history"]), 2)

    def test_the_same_kind_with_a_different_task_is_a_new_link(self):
        p = self._write("pending", "t1")
        self.client.post("/api/task-anywhere/t1/link", json={"kind": "replaced-by", "taskId": "a"})
        res = self.client.post("/api/task-anywhere/t1/link", json={"kind": "replaced-by", "taskId": "b"})
        self.assertTrue(res.get_json()["added"])
        self.assertEqual([l["taskId"] for l in self._read(p)["links"]], ["a", "b"])

    def test_keeps_links_that_are_already_on_the_record(self):
        p = self._write("done", "t1", {"links": [{"kind": "replaces", "taskId": "x"}]})
        self.client.post("/api/task-anywhere/t1/link", json={"kind": "repaired-by", "taskId": "r1"})
        self.assertEqual([l["taskId"] for l in self._read(p)["links"]], ["x", "r1"])

    def test_refuses_an_unknown_kind_a_missing_or_own_task_id_and_a_bad_branch(self):
        self._write("pending", "t1")
        self.assertEqual(self.client.post("/api/task-anywhere/t1/link", json={"kind": "friend-of", "taskId": "x"}).status_code, 400)
        self.assertEqual(self.client.post("/api/task-anywhere/t1/link", json={"kind": "replaced-by"}).status_code, 400)
        self.assertEqual(self.client.post("/api/task-anywhere/t1/link", json={"kind": "replaced-by", "taskId": "t1"}).status_code, 400)
        self.assertEqual(self.client.post("/api/task-anywhere/t1/link", json={"kind": "replaced-by", "taskId": "a/b"}).status_code, 400)
        self.assertEqual(self.client.post("/api/task-anywhere/t1/link", json={"kind": "replaced-by", "taskId": "x", "branch": 5}).status_code, 400)

    def test_an_unknown_task_is_404_and_nothing_is_written(self):
        res = self.client.post("/api/task-anywhere/nope/link", json={"kind": "replaced-by", "taskId": "x"})
        self.assertEqual(res.status_code, 404)
        self.assertEqual(list(self.queue.rglob("nope.json")), [])


if __name__ == "__main__":
    unittest.main()
