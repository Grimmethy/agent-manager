"""The Workers tab names the project each worker's task belongs to (2026-09-20: "We're going to need some kind of indication on the workers info
UI showing which project the task is a part of"). With idle-pool borrowing a lane can be running a task of another suite project, so the label
comes from the heartbeat's `project` when the lane is borrowing, else it is the active project; a borrowed task's hub is looked up in ITS project.

Run: .venv/bin/python -m unittest python.dashboard.test_worker_project -v
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


class WorkerProjectTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.a_pipe, self.b_pipe = tmp / "a-pipeline", tmp / "b-pipeline"
        (self.a_pipe / "queue").mkdir(parents=True)
        (self.b_pipe / "queue").mkdir(parents=True)
        self.registry = tmp / "projects.json"
        self.registry.write_text(json.dumps([
            {"repoRoot": str(tmp / "a-repo"), "pipelineDir": str(self.a_pipe), "label": "PF-Client-Portal"},
            {"repoRoot": str(tmp / "b-repo"), "pipelineDir": str(self.b_pipe), "label": "agent-manager-hygiene", "pool": True},
        ]))
        self._saved = (app.PROJECT_REGISTRY_PATH, os.environ.get("AGENT_MANAGER_PIPELINE_DIR"), os.environ.get("AGENT_MANAGER_REPO_ROOT"))
        app.PROJECT_REGISTRY_PATH = self.registry
        os.environ["AGENT_MANAGER_PIPELINE_DIR"] = str(self.a_pipe)
        os.environ["AGENT_MANAGER_REPO_ROOT"] = str(tmp / "a-repo")

    def tearDown(self):
        app.PROJECT_REGISTRY_PATH = self._saved[0]
        for k, v in (("AGENT_MANAGER_PIPELINE_DIR", self._saved[1]), ("AGENT_MANAGER_REPO_ROOT", self._saved[2])):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def test_active_project_label_comes_from_the_registry(self):
        self.assertEqual(app._active_project_label(), "PF-Client-Portal")

    def test_an_unregistered_active_repo_falls_back_to_its_directory_name(self):
        os.environ["AGENT_MANAGER_PIPELINE_DIR"] = "/nowhere/else-pipeline"
        os.environ["AGENT_MANAGER_REPO_ROOT"] = "/nowhere/some-repo"
        self.assertEqual(app._active_project_label(), "some-repo")

    def test_a_home_task_belongs_to_the_active_project_and_is_not_borrowed(self):
        active_q = self.a_pipe / "queue"
        project, borrowed, qdir = app._worker_project_info({"status": "working", "currentTaskId": "t"}, "PF-Client-Portal", active_q)
        self.assertEqual((project, borrowed, qdir), ("PF-Client-Portal", False, active_q))

    def test_a_borrowing_lane_reports_the_borrowed_project_and_its_own_queue(self):
        active_q = self.a_pipe / "queue"
        project, borrowed, qdir = app._worker_project_info({"status": "working", "currentTaskId": "t", "project": "agent-manager-hygiene"}, "PF-Client-Portal", active_q)
        self.assertEqual((project, borrowed), ("agent-manager-hygiene", True))
        self.assertEqual(qdir, self.b_pipe / "queue")

    def test_a_heartbeat_labelled_with_the_active_project_is_not_borrowed(self):
        active_q = self.a_pipe / "queue"
        _, borrowed, qdir = app._worker_project_info({"project": "PF-Client-Portal"}, "PF-Client-Portal", active_q)
        self.assertFalse(borrowed)
        self.assertEqual(qdir, active_q)

    def test_an_unknown_borrowed_label_falls_back_to_the_active_queue_instead_of_failing(self):
        active_q = self.a_pipe / "queue"
        project, borrowed, qdir = app._worker_project_info({"project": "no-such-project"}, "PF-Client-Portal", active_q)
        self.assertEqual((project, borrowed, qdir), ("no-such-project", True, active_q))

    def test_api_instances_stamps_projectLabel_borrowed_and_the_hub_of_the_right_project(self):
        inst = self.a_pipe / "instances"
        inst.mkdir()
        now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
        (inst / "worker-3090.json").write_text(json.dumps({"instanceId": "worker-3090", "status": "working", "currentTaskId": "home-task", "lastHeartbeat": now}))
        (inst / "worker-p40.json").write_text(json.dumps({"instanceId": "worker-p40", "status": "working", "currentTaskId": "HUB0007-01-x", "project": "agent-manager-hygiene", "lastHeartbeat": now}))
        (inst / "reviewer.json").write_text(json.dumps({"instanceId": "reviewer", "status": "idle", "lastHeartbeat": now}))
        with mock.patch.object(app, "instances_dir", return_value=inst), mock.patch.object(app, "_expected_instance_ids", return_value=[]):
            client = app.app.test_client()
            data = {r["instanceId"]: r for r in client.get("/api/instances").get_json()}
        self.assertEqual((data["worker-3090"]["projectLabel"], data["worker-3090"]["borrowed"]), ("PF-Client-Portal", False))
        self.assertEqual((data["worker-p40"]["projectLabel"], data["worker-p40"]["borrowed"]), ("agent-manager-hygiene", True))
        self.assertNotIn("projectLabel", data["reviewer"], "an idle worker has no task to label")


if __name__ == "__main__":
    unittest.main()
