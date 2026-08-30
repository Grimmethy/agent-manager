"""Tests for app.py's active-project resolution (_active_project_setting /
get_active_repo_root / get_pipeline_dir), file-first as of 2026-08-30.

Live incident: after a Werkzeug hot-reload (which re-execs the dashboard from the reloader
supervisor's launch-time environment), os.environ["AGENT_MANAGER_REPO_ROOT"] held the
project the dashboard was FIRST launched against, while agent-manager.env -- which
_start_pipeline always writes -- held the project actually running. The old env-first
precedence made the dashboard serve the wrong project's queue (every task 404'd).

Run: .venv/bin/python -m unittest python.dashboard.test_active_project_resolution -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class ActiveProjectResolutionTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_env_path = app.ENV_FILE_PATH
        app.ENV_FILE_PATH = Path(self._tmp.name) / "agent-manager.env"
        self._saved = {k: os.environ.get(k) for k in
                       ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PIPELINE_DIR", "AGENT_MANAGER_GREP_DIRS")}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _write_env(self, text):
        app.ENV_FILE_PATH.write_text(text, encoding="utf-8")

    def test_the_env_FILE_wins_over_a_stale_os_environ_value(self):
        # The incident shape: stale process env points one place, the file another.
        os.environ["AGENT_MANAGER_REPO_ROOT"] = "/stale/agent-manager"
        os.environ["AGENT_MANAGER_PIPELINE_DIR"] = "/stale/agent-manager"
        self._write_env(
            "AGENT_MANAGER_REPO_ROOT=/real/promptforge\n"
            "AGENT_MANAGER_PIPELINE_DIR=/real/promptforge-pipeline\n"
        )
        self.assertEqual(app.get_active_repo_root(), "/real/promptforge")
        self.assertEqual(app.get_pipeline_dir(), Path("/real/promptforge-pipeline"))
        self.assertEqual(app.queue_dir(), Path("/real/promptforge-pipeline/queue"))

    def test_falls_back_to_os_environ_when_the_file_lacks_the_key(self):
        self._write_env("SOMETHING_ELSE=1\n")
        os.environ["AGENT_MANAGER_REPO_ROOT"] = "/only/in/env"
        self.assertEqual(app.get_active_repo_root(), "/only/in/env")

    def test_pipeline_dir_falls_back_to_repo_root_when_no_pipeline_dir_is_set_anywhere(self):
        self._write_env("AGENT_MANAGER_REPO_ROOT=/proj\n")
        self.assertEqual(app.get_pipeline_dir(), Path("/proj"))

    def test_all_unset_yields_none(self):
        self._write_env("")
        self.assertIsNone(app.get_active_repo_root())
        self.assertIsNone(app.get_pipeline_dir())
        self.assertIsNone(app.queue_dir())


if __name__ == "__main__":
    unittest.main()
