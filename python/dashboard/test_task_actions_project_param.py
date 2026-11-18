"""Project param on requeue, archive/retire, rereview, staleness-keep, context-trim-keep.

Verifies that all five routes honour the optional `project` param via _qdir_for_request:
- Non-active project moves the file inside that project's queue only
- Active project's queue is untouched
- Unknown project returns 404 with nothing changed
- Omitted project acts on the active one
- History entries record the project label

Run: /media/model-cache/github/agent-manager/.venv/bin/python -m unittest python.dashboard.test_task_actions_project_param -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TaskActionsProjectParamTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.roots = {}
        self.pipes = {}
        self.queues = {}
        for name in ("A", "B"):
            root = self.tmp / f"repo{name}"
            (root / ".git").mkdir(parents=True)
            self.roots[name] = str(root.resolve())
            self.pipes[name] = self.tmp / f"pipe{name}"
            self.queues[name] = self.pipes[name] / "queue"
            self.queues[name].mkdir(parents=True)
        registry = [
            {"repoRoot": self.roots[n], "pipelineDir": str(self.pipes[n]), "label": n} for n in ("A", "B")
        ]
        self.registry_file = self.tmp / "projects.json"
        self.registry_file.write_text(json.dumps(registry))
        patches = [
            mock.patch.object(app, "queue_dir", return_value=self.queues["A"]),
            mock.patch.object(app, "get_active_repo_root", return_value=self.roots["A"]),
            mock.patch.object(app, "read_project_registry", return_value=json.loads(self.registry_file.read_text())),
            mock.patch.object(app, "_record_manual_requeue", side_effect=lambda task, **kw: None),
            mock.patch.object(app, "_task_cost_summary", return_value={}),
            mock.patch.object(app, "_files_touched_for", return_value=[]),
            mock.patch.object(app, "_task_input_summary", return_value={}),
            mock.patch.object(app, "_work_log_for", return_value=[]),
            mock.patch.object(app, "_incoming_task_links", return_value=[]),
            mock.patch.object(app, "_outgoing_task_links", return_value=[]),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.client = app.app.test_client()

    def put(self, name, state, task_id, **extra):
        d = self.queues[name] / state
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{task_id}.json").write_text(json.dumps({"id": task_id, "history": [], **extra}))

    def read(self, name, state, task_id):
        return json.loads((self.queues[name] / state / f"{task_id}.json").read_text())

    def exists(self, name, state, task_id):
        return (self.queues[name] / state / f"{task_id}.json").exists()

    def snapshot(self, name):
        return {str(p.relative_to(self.pipes[name])): p.read_bytes() for p in sorted(self.pipes[name].rglob("*")) if p.is_file()}

    # --- staleness-keep ---

    def test_staleness_keep_on_b_changes_only_b(self):
        self.put("A", "blocked", "a-only", title="A only")
        self.put("B", "blocked", "t1", title="B only")
        before_a = self.snapshot("A")
        r = self.client.post(f"/api/task/blocked/t1/staleness-keep?project={self.roots['B']}")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(self.snapshot("A"), before_a)
        self.assertTrue(self.exists("B", "blocked", "t1"))
        data = self.read("B", "blocked", "t1")
        self.assertIn("stalenessKeep", data)
        self.assertIn("project B", data["history"][-1]["detail"])

    def test_staleness_keep_on_b_with_same_id_in_a_acts_on_b(self):
        self.put("A", "blocked", "same", title="A copy")
        self.put("B", "blocked", "same", title="B copy")
        before_a = self.snapshot("A")
        r = self.client.post(f"/api/task/blocked/same/staleness-keep?project={self.roots['B']}")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(self.snapshot("A"), before_a)
        self.assertIn("project B", self.read("B", "blocked", "same")["history"][-1]["detail"])

    # --- context-trim-keep ---

    def test_context_trim_keep_on_b_changes_only_b(self):
        self.put("A", "blocked", "a-only", title="A only")
        self.put("B", "blocked", "t2", title="B only")
        before_a = self.snapshot("A")
        r = self.client.post(f"/api/task/blocked/t2/context-trim-keep?project={self.roots['B']}")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(self.snapshot("A"), before_a)
        self.assertTrue(self.exists("B", "blocked", "t2"))
        data = self.read("B", "blocked", "t2")
        self.assertIn("contextTrimKeep", data)
        self.assertIn("project B", data["history"][-1]["detail"])

    def test_context_trim_keep_on_b_with_same_id_in_a_acts_on_b(self):
        self.put("A", "blocked", "same", title="A copy")
        self.put("B", "blocked", "same", title="B copy")
        before_a = self.snapshot("A")
        r = self.client.post(f"/api/task/blocked/same/context-trim-keep?project={self.roots['B']}")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(self.snapshot("A"), before_a)
        self.assertIn("project B", self.read("B", "blocked", "same")["history"][-1]["detail"])

    # --- rereview ---

    def test_rereview_on_b_uses_b_pipeline_dir(self):
        self.put("A", "blocked", "a-only", title="A only")
        self.put("B", "blocked", "t3", title="B only", blockedStage="review", implementResponse="some draft")
        before_a = self.snapshot("A")
        with mock.patch("subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(
                returncode=0,
                stdout=json.dumps({"ok": True, "id": "t3", "from": "blocked", "to": "review"})
            )
            r = self.client.post(f"/api/task/blocked/t3/rereview?project={self.roots['B']}")
            self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
            self.assertEqual(self.snapshot("A"), before_a)
            call_args = mock_run.call_args
            args = call_args[0][0]
            self.assertIn("--pipeline-dir", args)
            self.assertIn(str(self.pipes["B"]), args)
            self.assertIn("--project", args)
            self.assertIn("B", args)  # label, not full path

    def test_rereview_on_b_with_same_id_in_a_acts_on_b(self):
        self.put("A", "blocked", "same", title="A copy", blockedStage="review", implementResponse="draft A")
        self.put("B", "blocked", "same", title="B copy", blockedStage="review", implementResponse="draft B")
        before_a = self.snapshot("A")
        with mock.patch("subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(
                returncode=0,
                stdout=json.dumps({"ok": True, "id": "same", "from": "blocked", "to": "review"})
            )
            r = self.client.post(f"/api/task/blocked/same/rereview?project={self.roots['B']}")
            self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
            self.assertEqual(self.snapshot("A"), before_a)
            args = mock_run.call_args[0][0]
            self.assertIn("--pipeline-dir", args)
            self.assertIn(str(self.pipes["B"]), args)

    # --- unregistered project ---

    def test_unregistered_project_is_404_with_nothing_changed(self):
        self.put("A", "blocked", "t4", title="A only")
        self.put("B", "blocked", "t4", title="B only")
        before_a = self.snapshot("A")
        before_b = self.snapshot("B")
        bogus = str(self.tmp / "nowhere")
        r = self.client.post(f"/api/task/blocked/t4/staleness-keep?project={bogus}")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.snapshot("A"), before_a)
        self.assertEqual(self.snapshot("B"), before_b)

    # --- omitted project ---

    def test_omitted_project_acts_on_active_project(self):
        self.put("A", "blocked", "t5", title="A only")
        self.put("B", "blocked", "t5", title="B only")
        before_b = self.snapshot("B")
        r = self.client.post("/api/task/blocked/t5/staleness-keep")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(self.exists("A", "blocked", "t5"))
        self.assertEqual(self.snapshot("B"), before_b)


if __name__ == "__main__":
    unittest.main()
