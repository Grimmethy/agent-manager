"""Tests for POST /api/task-anywhere/<id>/depends-on: add or remove a task id in a record's dependsOn list, wherever the record sits, idempotent, validated.

Run: .venv/bin/python -m unittest python.dashboard.test_task_depends_on -v
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import branch_projects  # noqa: E402


class TaskDependsOnTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.queue = Path(self._tmp.name) / "queue"
        self.other_queue = Path(self._tmp.name) / "other" / "queue"
        for q in (self.queue, self.other_queue):
            for d in ["pending", "blocked", "done", "adhoc"]:
                (q / d).mkdir(parents=True)
        self._patch = mock.patch.object(app, "queue_dir", return_value=self.queue)
        self._patch.start()
        self.client = app.app.test_client()

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def _write(self, state_dir, task_id, extra=None, queue=None):
        task = {"id": task_id, "domain": "adhoc", "source": "manual", "title": "t", "history": []}
        if extra:
            task.update(extra)
        p = (queue or self.queue) / state_dir / f"{task_id}.json"
        p.write_text(json.dumps(task, indent=2), encoding="utf-8")
        return p

    def _read(self, path):
        return json.loads(path.read_text(encoding="utf-8"))

    def _post(self, task_id, body, query=""):
        return self.client.post(f"/api/task-anywhere/{task_id}/depends-on{query}", json=body)


class TestTaskDependsOn(TaskDependsOnTestBase):
    def test_add_appends_the_task_id_to_dependson(self):
        p = self._write("adhoc", "t1")
        self._write("pending", "dep-1")
        res = self._post("t1", {"taskId": "dep-1"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self._read(p)["dependsOn"], ["dep-1"])

    def test_add_keeps_existing_dependencies(self):
        p = self._write("pending", "t1", {"dependsOn": ["a"]})
        self._write("pending", "b")
        self.assertEqual(self._post("t1", {"taskId": "b"}).status_code, 200)
        self.assertEqual(self._read(p)["dependsOn"], ["a", "b"])

    def test_re_adding_the_same_id_is_idempotent(self):
        p = self._write("pending", "t1")
        self._write("pending", "dep-1")
        first = self._post("t1", {"taskId": "dep-1"})
        again = self._post("t1", {"taskId": "dep-1"})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(self._read(p)["dependsOn"].count("dep-1"), 1)

    def test_remove_deletes_the_id_and_leaves_the_others(self):
        p = self._write("pending", "t1", {"dependsOn": ["a", "b"]})
        self._write("pending", "a")
        self._write("pending", "b")
        res = self._post("t1", {"taskId": "a", "remove": True})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self._read(p)["dependsOn"], ["b"])

    def test_removing_an_absent_id_is_a_harmless_no_op(self):
        p = self._write("pending", "t1", {"dependsOn": ["b"]})
        res = self._post("t1", {"taskId": "zzz", "remove": True})
        self.assertLess(res.status_code, 500)
        self.assertEqual(self._read(p).get("dependsOn"), ["b"])

    def test_self_dependency_is_refused_and_nothing_is_written(self):
        p = self._write("pending", "t1")
        res = self._post("t1", {"taskId": "t1"})
        self.assertIn(res.status_code, (400, 404, 409, 422))
        self.assertFalse(self._read(p).get("dependsOn"))

    def test_unknown_dependency_id_is_refused_and_nothing_is_written(self):
        p = self._write("pending", "t1")
        res = self._post("t1", {"taskId": "ghost"})
        self.assertIn(res.status_code, (400, 404, 409, 422))
        self.assertFalse(self._read(p).get("dependsOn"))

    def test_an_unknown_record_is_404(self):
        res = self._post("nope", {"taskId": "x"})
        self.assertEqual(res.status_code, 404)
        self.assertEqual(list(self.queue.rglob("nope.json")), [])

    def test_project_query_targets_that_projects_queue(self):
        active = self._write("adhoc", "t1")
        other = self._write("adhoc", "t1", queue=self.other_queue)
        self._write("pending", "dep-1", queue=self.other_queue)
        with mock.patch.object(branch_projects, "resolve_scope", return_value={"qdir": self.other_queue}):
            res = self._post("t1", {"taskId": "dep-1"}, query="?project=/some/other/repo")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self._read(other)["dependsOn"], ["dep-1"])
        self.assertFalse(self._read(active).get("dependsOn"))


if __name__ == "__main__":
    unittest.main()
