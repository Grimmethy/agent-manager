"""behind_checkout must look at the PLUGIN's checkout: the working directory in the entry's process block, which is where every manifest entry keeps it.

It used to read only a top-level `cwd`, so for every real entry it ran git in the dashboard's own directory and flagged a plugin as behind whenever the agent-manager core had a
newer commit than the plugin's pidfile (2026-11-10: every core merge reported `restartNeeded: agent-manager-chat-plugin) although that plugin's own checkout had not changed.

Run: .venv/bin/python -m unittest test_plugin_behind_cwd -v
"""
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import plugin_process_manager as ppm  # noqa: E402


def make_repo(root: Path, name: str, commit_time: int) -> Path:
    """A one-commit git repo whose HEAD commit has the given committer timestamp."""
    repo = root / name
    repo.mkdir()
    env = {**os.environ, "GIT_AUTHOR_DATE": f"{commit_time} +0000", "GIT_COMMITTER_DATE": f"{commit_time} +0000"}
    for args in (["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]):
        subprocess.run(["git", *args], cwd=str(repo), capture_output=True, check=True)
    (repo / "f.txt").write_text(name)
    subprocess.run(["git", "add", "f.txt"], cwd=str(repo), capture_output=True, check=True)
    subprocess.run(["git", "commit", "-q", "-m", name], cwd=str(repo), capture_output=True, check=True, env=env)
    return repo


class BehindCheckoutWorkingDirectoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        for p in (mock.patch.object(ppm, "PID_DIR", self.tmp / "pids"), mock.patch.object(ppm, "LOG_DIR", self.tmp / "logs"), mock.patch.object(ppm, "is_running", return_value=True)):
            p.start()
            self.addCleanup(p.stop)
        now = int(time.time())
        self.plugin_repo = make_repo(self.tmp, "plugin", now - 7200)     # the plugin's checkout: last commit 2 hours ago
        self.core_repo = make_repo(self.tmp, "core", now - 60)           # the dashboard's directory: a commit one minute ago
        pidfile = ppm._pidfile("p")
        pidfile.parent.mkdir(parents=True, exist_ok=True)
        pidfile.write_text("99999")
        os.utime(pidfile, (now - 3600, now - 3600))                      # the plugin process started one hour ago, after its own last commit

    def behind(self, entry):
        with mock.patch.object(os, "getcwd", return_value=str(self.core_repo)):
            return ppm.PluginProcessManager().behind_checkout(entry)

    def test_the_process_blocks_cwd_is_the_checkout_that_is_looked_at(self):
        result = self.behind({"name": "p", "process": {"cwd": str(self.plugin_repo)}})
        self.assertFalse(result["behind"], "the plugin's own checkout has no commit newer than its process")
        self.assertEqual(result["files"], [])

    def test_a_newer_commit_in_the_plugins_own_checkout_is_still_behind(self):
        newer = make_repo(self.tmp, "plugin-newer", int(time.time()) - 60)
        self.assertTrue(self.behind({"name": "p", "process": {"cwd": str(newer)}})["behind"])

    def test_a_top_level_cwd_wins_over_the_process_block(self):
        newer = make_repo(self.tmp, "plugin-newer", int(time.time()) - 60)
        result = self.behind({"name": "p", "cwd": str(newer), "process": {"cwd": str(self.plugin_repo)}})
        self.assertTrue(result["behind"])

    def test_an_entry_with_no_cwd_at_all_still_falls_back_to_the_dashboards_directory(self):
        self.assertTrue(self.behind({"name": "p"})["behind"])
        self.assertTrue(self.behind({"name": "p", "process": {"command": "x"}})["behind"])
        self.assertTrue(self.behind({"name": "p", "process": None})["behind"])


if __name__ == "__main__":
    unittest.main()
