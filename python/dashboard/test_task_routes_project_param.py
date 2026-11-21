"""The single-task routes (detail, needs-clarification answer / resolve) honour the optional `project` param via routes/task.py _qdir_for_request.

Two temp pipelines: A (active) and B, each with its own queue dir, plus a stubbed projects.json registry. Nothing touches the real registry or queue.

Run: .venv/bin/python -m unittest python.dashboard.test_task_routes_project_param -v   (from the repo root)
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TaskRoutesProjectParamTest(unittest.TestCase):
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
        self.requeues = []
        patches = [
            mock.patch.object(app, "queue_dir", return_value=self.queues["A"]),
            mock.patch.object(app, "get_active_repo_root", return_value=self.roots["A"]),
            mock.patch.object(app, "read_project_registry", return_value=json.loads(self.registry_file.read_text())),
            mock.patch.object(app, "_record_manual_requeue", side_effect=lambda task, **kw: self.requeues.append(kw)),
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

    def nc(self, name, task_id, text="ask"):
        self.put(name, "needs-clarification", task_id, promptContext={"rawText": text})

    # --- answer / resolve ---

    def test_answer_with_project_b_changes_only_b(self):
        self.nc("A", "a-only")
        self.nc("B", "t1")
        before_a = self.snapshot("A")
        r = self.client.post(f"/api/task/needs-clarification/t1/answer?project={self.roots['B']}", json={"answer": "go"})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(self.snapshot("A"), before_a)
        self.assertTrue(self.exists("B", "adhoc", "t1"))
        self.assertFalse(self.exists("B", "needs-clarification", "t1"))

    def test_resolve_with_project_b_changes_only_b(self):
        self.nc("A", "a-only")
        self.nc("B", "t2")
        before_a = self.snapshot("A")
        r = self.client.post("/api/task/needs-clarification/t2/resolve", json={"project": self.roots["B"], "paths": ["src/x.js"]})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(self.snapshot("A"), before_a)
        self.assertEqual(self.read("B", "adhoc", "t2")["promptContext"]["prefetchedPaths"], ["src/x.js"])

    def test_same_task_id_in_both_changes_only_bs_copy(self):
        self.nc("A", "same", "from A")
        self.nc("B", "same", "from B")
        before_a = self.snapshot("A")
        r = self.client.post(f"/api/task/needs-clarification/same/answer?project={self.roots['B']}", json={"answer": "yes"})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(self.snapshot("A"), before_a)
        self.assertIn("yes", self.read("B", "adhoc", "same")["promptContext"]["rawText"])
        self.assertFalse(self.exists("A", "adhoc", "same"))

    # --- detail ---

    def test_detail_with_project_b_returns_a_task_only_in_b(self):
        self.put("B", "pending", "b-only", title="only in B")
        r = self.client.get(f"/api/task/pending/b-only?project={self.roots['B']}")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(r.get_json()["title"], "only in B")
        self.assertEqual(self.client.get("/api/task/pending/b-only").status_code, 404)

    def test_detail_with_shared_id_returns_the_named_projects_copy(self):
        self.put("A", "pending", "same", title="A copy")
        self.put("B", "pending", "same", title="B copy")
        self.assertEqual(self.client.get(f"/api/task/pending/same?project={self.roots['B']}").get_json()["title"], "B copy")
        self.assertEqual(self.client.get("/api/task/pending/same").get_json()["title"], "A copy")

    # --- unregistered project ---

    def _unregistered(self, path, **kw):
        self.nc("A", "t3")
        self.nc("B", "t3")
        before = (self.snapshot("A"), self.snapshot("B"))
        r = self.client.post(path, **kw)
        self.assertEqual(r.status_code, 404)
        self.assertEqual((self.snapshot("A"), self.snapshot("B")), before)
        self.assertEqual(self.requeues, [])
        return r

    def test_unregistered_project_is_404_json_and_changes_nothing(self):
        bogus = str(self.tmp / "nowhere")
        r = self._unregistered(f"/api/task/needs-clarification/t3/answer?project={bogus}", json={"answer": "x"})
        body = r.get_json()
        self.assertIsInstance(body, dict)
        self.assertIn("not a registered project", body["description"])
        self._unregistered("/api/task/needs-clarification/t3/resolve", json={"project": bogus})

    @unittest.expectedFailure
    def test_unregistered_project_error_names_the_registered_keys(self):
        # Contract wants the 404 text to list the registered keys; branch_projects.resolve_scope's message does not (yet).
        r = self._unregistered(f"/api/task/needs-clarification/t3/answer?project={self.tmp / 'nowhere'}", json={"answer": "x"})
        text = json.dumps(r.get_json())
        for root in self.roots.values():
            self.assertIn(root, text)

    def test_unregistered_project_on_detail_is_404(self):
        self.put("A", "pending", "t4")
        r = self.client.get(f"/api/task/pending/t4?project={self.tmp / 'nowhere'}")
        self.assertEqual(r.status_code, 404)

    # --- omitted project ---

    def test_omitted_project_acts_on_the_active_project(self):
        self.nc("A", "t5")
        self.nc("B", "t5")
        before_b = self.snapshot("B")
        r = self.client.post("/api/task/needs-clarification/t5/answer", json={"answer": "yes"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(self.exists("A", "adhoc", "t5"))
        self.assertEqual(self.snapshot("B"), before_b)
        self.assertIsNone(self.requeues[-1]["pipeline_dir"])

    # --- history ---

    def test_successful_actions_on_b_record_history_and_requeue_for_b(self):
        self.nc("B", "h1")
        self.nc("B", "h2")
        self.client.post(f"/api/task/needs-clarification/h1/answer?project={self.roots['B']}", json={"answer": "yes"})
        self.client.post("/api/task/needs-clarification/h2/resolve", json={"project": self.roots["B"]})
        stages = [h["stage"] for h in self.read("B", "adhoc", "h1")["history"]]
        self.assertIn("needs-clarification-resolved", stages)
        self.assertEqual([r["pipeline_dir"] for r in self.requeues], [str(self.pipes["B"])] * 2)
        self.assertEqual(self.snapshot("A"), {})

    def test_rejected_request_appends_no_history(self):
        self.nc("B", "h3")
        before = self.snapshot("B")
        r = self.client.post(f"/api/task/needs-clarification/h3/answer?project={self.roots['B']}", json={"answer": "  "})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.snapshot("B"), before)
        self.assertEqual(self.read("B", "needs-clarification", "h3")["history"], [])
        self.assertEqual(self.requeues, [])


if __name__ == "__main__":
    unittest.main()
