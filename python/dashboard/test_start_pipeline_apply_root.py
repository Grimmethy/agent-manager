"""_start_pipeline must resolve AGENT_MANAGER_APPLY_REPO_ROOT per project.

Live incident 2026-09-19: the env value stayed pinned to agent-manager's own apply clone
after switching to a second repo, so agent-manager's candidate docs became tasks for the new
repo and its diffs would have been applied/pushed to agent-manager's origin.

Run: .venv/bin/python -m unittest python.dashboard.test_start_pipeline_apply_root -v
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


class StartPipelineApplyRootTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.repo = tmp / "repo"
        self.repo.mkdir()
        self.env_path = tmp / "agent-manager.env"
        self.env_path.write_text("AGENT_MANAGER_APPLY_REPO_ROOT=/stale/agent-manager-apply\nOTHER=keep\n")
        self.registry = tmp / "projects.json"
        self._saved = (app.ENV_FILE_PATH, app.PROJECT_REGISTRY_PATH, os.environ.get("AGENT_MANAGER_APPLY_REPO_ROOT"))
        app.ENV_FILE_PATH, app.PROJECT_REGISTRY_PATH = self.env_path, self.registry
        os.environ["AGENT_MANAGER_APPLY_REPO_ROOT"] = "/stale/agent-manager-apply"
        self.patches = [
            mock.patch.object(app, "record_project_used"),
            mock.patch.object(app, "_ensure_task_domains"),
            mock.patch.object(app, "read_active_job_types", return_value=[]),
            mock.patch.object(app.subprocess, "Popen"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        app.ENV_FILE_PATH, app.PROJECT_REGISTRY_PATH = self._saved[0], self._saved[1]
        if self._saved[2] is None:
            os.environ.pop("AGENT_MANAGER_APPLY_REPO_ROOT", None)
        else:
            os.environ["AGENT_MANAGER_APPLY_REPO_ROOT"] = self._saved[2]
        self._tmp.cleanup()

    def _register(self, **extra):
        self.registry.write_text(json.dumps([{
            "repoRoot": str(self.repo), "pipelineDir": str(self.repo) + "-pipeline",
            "domainsPath": str(self.repo) + "-pipeline/task-domains.json", **extra}]))

    def test_project_without_apply_root_clears_stale_value(self):
        self._register()
        app._start_pipeline(str(self.repo), True, True)
        self.assertNotIn("AGENT_MANAGER_APPLY_REPO_ROOT", os.environ)
        text = self.env_path.read_text()
        self.assertNotIn("AGENT_MANAGER_APPLY_REPO_ROOT", text)
        self.assertIn("OTHER=keep", text)

    def test_project_with_apply_root_sets_it(self):
        self._register(applyRepoRoot="/some/apply-clone")
        app._start_pipeline(str(self.repo), True, True)
        self.assertEqual(os.environ["AGENT_MANAGER_APPLY_REPO_ROOT"], "/some/apply-clone")
        self.assertIn("AGENT_MANAGER_APPLY_REPO_ROOT=/some/apply-clone", self.env_path.read_text())

    def test_project_without_grep_dirs_clears_stale_value_and_with_them_sets_it(self):
        self.env_path.write_text("AGENT_MANAGER_GREP_DIRS=src,python,scripts,docs\nOTHER=keep\n")
        os.environ["AGENT_MANAGER_GREP_DIRS"] = "src,python,scripts,docs"
        try:
            self._register()
            app._start_pipeline(str(self.repo), True, True)
            self.assertNotIn("AGENT_MANAGER_GREP_DIRS", os.environ)
            self.assertNotIn("AGENT_MANAGER_GREP_DIRS", self.env_path.read_text())
            self._register(grepDirs="src,lib")
            app._start_pipeline(str(self.repo), True, True)
            self.assertEqual(os.environ["AGENT_MANAGER_GREP_DIRS"], "src,lib")
            self.assertIn("AGENT_MANAGER_GREP_DIRS=src,lib", self.env_path.read_text())
            self.assertEqual(json.loads(self.registry.read_text())[0].get("grepDirs"), "src,lib")
        finally:
            os.environ.pop("AGENT_MANAGER_GREP_DIRS", None)

    def test_registry_upsert_preserves_apply_root(self):
        self._register(applyRepoRoot="/some/apply-clone")
        app._start_pipeline(str(self.repo), True, True)
        entry = json.loads(self.registry.read_text())[0]
        self.assertEqual(entry.get("applyRepoRoot"), "/some/apply-clone")


if __name__ == "__main__":
    unittest.main()
