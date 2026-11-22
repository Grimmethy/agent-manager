"""Cross-pipeline premium priority for POST /api/task-anywhere/<id>/premium-priority.

A task queued in ANOTHER registered pipeline's queue/adhoc must be found and flagged.
Unknown ids 404 with a description that names every directory searched, and a
non-boolean "enabled" (e.g. the string "false") is rejected with 400 before any write.

Run: .venv/bin/python -m unittest python.dashboard.tests.test_task_anywhere_cross_pipeline_premium -v
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

DASHBOARD_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(DASHBOARD_DIR))

import app  # noqa: E402
import branch_projects  # noqa: E402


class CrossPipelinePremiumTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)

        active_root = root / "primary"
        self.primary_queue = active_root / "queue"
        (self.primary_queue / "pending").mkdir(parents=True)
        (self.primary_queue / "adhoc").mkdir(parents=True)

        other_pipeline = root / "other-pipeline"
        self.other_adhoc = other_pipeline / "queue" / "adhoc"
        self.other_adhoc.mkdir(parents=True)

        registry = [
            {"label": "primary", "repoRoot": str(active_root), "pipelineDir": str(active_root), "active": True},
            {"label": "other", "repoRoot": str(other_pipeline), "pipelineDir": str(other_pipeline), "active": False},
        ]
        self._patches = [
            mock.patch.object(app, "queue_dir", return_value=self.primary_queue),
            mock.patch.object(app, "get_active_repo_root", return_value=str(active_root)),
            mock.patch.object(branch_projects, "resolve_scope", return_value=None),
            mock.patch.object(branch_projects, "registered_projects", return_value=registry),
        ]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _queue_in_other(self, task_id):
        task = {"id": task_id, "domain": "adhoc", "source": "manual", "title": "cross", "history": []}
        path = self.other_adhoc / f"{task_id}.json"
        path.write_text(json.dumps(task, indent=2), encoding="utf-8")
        return path

    def _read(self, path):
        return json.loads(path.read_text(encoding="utf-8"))

    def test_enabled_true_flags_task_queued_in_other_pipeline(self):
        path = self._queue_in_other("cross-1")
        res = self.client.post("/api/task-anywhere/cross-1/premium-priority", json={"enabled": True})
        self.assertEqual(res.status_code, 200)
        data = self._read(path)
        self.assertIs(data["premiumPriority"], True)
        self.assertTrue(data.get("premiumSetBy"))
        self.assertTrue(data.get("premiumSetAt"))

    def test_unknown_id_404s_and_names_each_searched_directory(self):
        res = self.client.post("/api/task-anywhere/no-such-task/premium-priority", json={"enabled": True})
        self.assertEqual(res.status_code, 404)
        body = res.get_data(as_text=True)
        self.assertIn("not found in any live queue state", body)
        self.assertIn(str(self.primary_queue), body)
        self.assertIn(str(self.primary_queue / "adhoc"), body)
        self.assertIn(str(self.other_adhoc), body)

    def test_non_boolean_enabled_string_false_is_rejected_without_setting_premium(self):
        path = self._queue_in_other("cross-3")
        res = self.client.post("/api/task-anywhere/cross-3/premium-priority", json={"enabled": "false"})
        self.assertEqual(res.status_code, 400)
        data = self._read(path)
        self.assertFalse(data.get("premiumPriority", False))


if __name__ == "__main__":
    unittest.main()
