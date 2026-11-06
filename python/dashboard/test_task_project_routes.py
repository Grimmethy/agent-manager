"""Hub retire and the needs-clarification answer/resolve/done routes accept ?project=<repoRoot> (2026-10-30).

They used to resolve the queue with queue_dir(), the ACTIVE project's queue only, so retiring agent-manager's own hub while another project was active
answered 404 'no coordinating hub'. The branch and premium routes already select another registered project through branch_projects.resolve_scope;
these routes now do the same through routes/task.py _qdir_for_request. Sandbox projects only: temp directories, a stubbed registry, no live queue.

Run: .venv/bin/python -m unittest python.dashboard.test_task_project_routes -v   (from the repo root)
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TaskProjectRoutesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.roots = {}
        for name in ("alpha", "beta"):
            root = self.tmp / name
            (root / ".git").mkdir(parents=True)
            self.roots[name] = str(root.resolve())
        self.alpha_q = self.tmp / "alpha-pipe" / "queue"
        self.beta_pipe = self.tmp / "beta-pipe"
        self.beta_q = self.beta_pipe / "queue"
        registry = [
            {"repoRoot": self.roots["alpha"], "pipelineDir": str(self.tmp / "alpha-pipe"), "label": "alpha"},
            {"repoRoot": self.roots["beta"], "pipelineDir": str(self.beta_pipe), "label": "beta"},
        ]
        self.requeues = []
        for p in (
            mock.patch.object(app, "queue_dir", return_value=self.alpha_q),
            mock.patch.object(app, "get_active_repo_root", return_value=self.roots["alpha"]),
            mock.patch.object(app, "read_project_registry", return_value=registry),
            mock.patch.object(app, "_record_manual_requeue", side_effect=lambda task, **kw: self.requeues.append(kw)),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.client = app.app.test_client()

    def put(self, queue, state, task_id, **extra):
        d = queue / state
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{task_id}.json").write_text(json.dumps({"id": task_id, "history": [], **extra}))

    def exists(self, queue, state, task_id):
        return (queue / state / f"{task_id}.json").exists()

    def read(self, queue, state, task_id):
        return json.loads((queue / state / f"{task_id}.json").read_text())

    # --- hub retire -------------------------------------------------------------------------------------------------------------------------

    def test_retire_reaches_a_hub_in_another_registered_project_and_leaves_the_active_queue_alone(self):
        self.put(self.beta_q, "adhoc", "c1")
        self.put(self.beta_q, "coordinating", "hub-b", subTasks=[{"id": "c1"}])
        self.put(self.alpha_q, "adhoc", "keep-me")
        r = self.client.post(f"/api/hub/hub-b/retire?project={self.roots['beta']}", json={"reason": "superseded"})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(r.get_json()["archived"], ["c1"])
        archived = self.beta_q / "done" / "_archived_no_action"
        self.assertEqual(json.loads((archived / "c1.json").read_text())["terminalDisposition"], "abandoned")
        self.assertTrue((archived / "hub-b.json").exists())
        self.assertFalse(self.exists(self.beta_q, "adhoc", "c1"))
        self.assertTrue(self.exists(self.alpha_q, "adhoc", "keep-me"))

    def test_the_same_hub_without_the_parameter_is_still_a_404_on_the_active_project(self):
        self.put(self.beta_q, "coordinating", "hub-b", subTasks=[])
        r = self.client.post("/api/hub/hub-b/retire", json={})
        self.assertEqual(r.status_code, 404)
        self.assertTrue(self.exists(self.beta_q, "coordinating", "hub-b"))

    def test_naming_the_active_project_explicitly_uses_the_active_queue(self):
        self.put(self.alpha_q, "coordinating", "hub-a", subTasks=[])
        r = self.client.post(f"/api/hub/hub-a/retire?project={self.roots['alpha']}", json={})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertTrue((self.alpha_q / "done" / "_archived_no_action" / "hub-a.json").exists())

    def test_an_unregistered_project_is_a_404_with_a_message_and_changes_nothing(self):
        self.put(self.alpha_q, "coordinating", "hub-a", subTasks=[])
        r = self.client.post(f"/api/hub/hub-a/retire?project={self.tmp / 'nowhere'}", json={})
        self.assertEqual(r.status_code, 404)
        self.assertIn("not a registered project", r.get_data(as_text=True))
        self.assertTrue(self.exists(self.alpha_q, "coordinating", "hub-a"))

    # --- needs-clarification answer / resolve / done ----------------------------------------------------------------------------------------

    def test_answer_in_another_project_moves_the_task_in_that_project_and_attributes_the_requeue_to_it(self):
        self.put(self.beta_q, "needs-clarification", "t1", promptContext={"rawText": "ask"}, needsClarification={"reason": "design-decision"})
        r = self.client.post(f"/api/task/needs-clarification/t1/answer?project={self.roots['beta']}", json={"answer": "go with B"})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        moved = self.read(self.beta_q, "adhoc", "t1")
        self.assertIn("go with B", moved["promptContext"]["rawText"])
        self.assertFalse(self.exists(self.beta_q, "needs-clarification", "t1"))
        self.assertEqual(self.requeues[-1]["pipeline_dir"], str(self.beta_pipe))

    def test_answer_without_the_parameter_acts_on_the_active_project_and_passes_no_pipeline_dir(self):
        self.put(self.alpha_q, "needs-clarification", "t2", promptContext={"rawText": "ask"})
        r = self.client.post("/api/task/needs-clarification/t2/answer", json={"answer": "yes"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(self.exists(self.alpha_q, "adhoc", "t2"))
        self.assertIsNone(self.requeues[-1]["pipeline_dir"])

    def test_answer_for_a_task_that_only_exists_in_another_project_is_a_404_without_the_parameter(self):
        self.put(self.beta_q, "needs-clarification", "t3", promptContext={"rawText": "ask"})
        r = self.client.post("/api/task/needs-clarification/t3/answer", json={"answer": "yes"})
        self.assertEqual(r.status_code, 404)
        self.assertTrue(self.exists(self.beta_q, "needs-clarification", "t3"))

    def test_resolve_accepts_the_project_in_the_json_body(self):
        self.put(self.beta_q, "needs-clarification", "t4", promptContext={"rawText": "ask"})
        r = self.client.post("/api/task/needs-clarification/t4/resolve", json={"project": self.roots["beta"], "paths": ["src/a.js"]})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(self.read(self.beta_q, "adhoc", "t4")["promptContext"]["prefetchedPaths"], ["src/a.js"])
        self.assertEqual(self.requeues[-1]["pipeline_dir"], str(self.beta_pipe))

    def test_done_in_another_project_writes_that_projects_done_folder(self):
        self.put(self.beta_q, "needs-clarification", "t5", promptContext={"rawText": "ask"})
        r = self.client.post(f"/api/task/needs-clarification/t5/done?project={self.roots['beta']}", json={})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        done = self.read(self.beta_q, "done", "t5")
        self.assertEqual(done["status"], "done")
        self.assertFalse(self.exists(self.beta_q, "needs-clarification", "t5"))
        self.assertFalse(self.exists(self.alpha_q, "done", "t5"))


if __name__ == "__main__":
    unittest.main()
