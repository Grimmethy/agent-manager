"""Pipeline-start pre-flight: report + snapshot uncommitted tracked changes, never block.

Run: .venv/bin/python -m unittest python.dashboard.test_preflight -v
Every repo here is a throwaway `git init` in a temp dir -- never a real project.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import preflight  # noqa: E402


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=str(repo), capture_output=True, text=True, check=True).stdout


def make_repo(root, name, files=None):
    repo = Path(root) / name
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "t@example.invalid")
    git(repo, "config", "user.name", "t")
    (repo / "a.txt").write_text("one\n")
    (repo / ".gitignore").write_text("ignored.log\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
    return repo


class PreflightTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.state = self.root / "snapshots"
        self._saved = os.environ.pop("AGENT_MANAGER_PREFLIGHT", None)

    def tearDown(self):
        if self._saved is not None:
            os.environ["AGENT_MANAGER_PREFLIGHT"] = self._saved
        else:
            os.environ.pop("AGENT_MANAGER_PREFLIGHT", None)
        self._tmp.cleanup()

    def test_dirty_tracked_file_is_listed_and_snapshotted_without_touching_the_repo(self):
        repo = make_repo(self.root, "dirty")
        (repo / "a.txt").write_text("one\ntwo\n")
        before = (git(repo, "status", "--porcelain"), (repo / "a.txt").read_bytes())
        info = preflight.check_repo(repo)
        self.assertTrue(info["dirty"])
        self.assertEqual(info["files"], ["a.txt"])
        snap = preflight.snapshot_dirty(repo, self.state)
        self.assertTrue(snap and Path(snap).is_file())
        self.assertEqual(Path(snap).read_text(), git(repo, "diff", "HEAD"))
        self.assertIn("+two", Path(snap).read_text())
        after = (git(repo, "status", "--porcelain"), (repo / "a.txt").read_bytes())
        self.assertEqual(before, after)
        self.assertEqual(git(repo, "stash", "list"), "")

    def test_staged_only_change_counts_as_dirty(self):
        repo = make_repo(self.root, "staged")
        (repo / "a.txt").write_text("one\nstaged\n")
        git(repo, "add", "a.txt")
        self.assertTrue(preflight.check_repo(repo)["dirty"])
        self.assertIn("+staged", Path(preflight.snapshot_dirty(repo, self.state)).read_text())

    def test_clean_repo_is_not_dirty_and_writes_nothing(self):
        repo = make_repo(self.root, "clean")
        report = preflight.run([repo], self.state)
        self.assertFalse(report["dirty"])
        self.assertIsNone(report["snapshot"])
        self.assertFalse(self.state.exists() and any(self.state.iterdir()))

    def test_untracked_and_ignored_files_are_not_dirty(self):
        repo = make_repo(self.root, "untracked")
        (repo / "new.txt").write_text("untracked\n")
        (repo / "ignored.log").write_text("ignored\n")
        info = preflight.check_repo(repo)
        self.assertFalse(info["dirty"])
        self.assertEqual(info["files"], [])

    def test_non_git_directory_and_missing_path_are_skipped_without_raising(self):
        plain = self.root / "plain"
        plain.mkdir()
        self.assertTrue(preflight.check_repo(plain)["skipped"])
        self.assertTrue(preflight.check_repo(self.root / "nope")["skipped"])
        report = preflight.run([plain, self.root / "nope", None], self.state)
        self.assertTrue(report["enabled"])
        self.assertFalse(report["dirty"])

    def test_off_switch_never_invokes_git(self):
        repo = make_repo(self.root, "off")
        (repo / "a.txt").write_text("changed\n")
        os.environ["AGENT_MANAGER_PREFLIGHT"] = "off"
        with mock.patch.object(preflight.subprocess, "run", side_effect=AssertionError("git was invoked")):
            self.assertEqual(preflight.run([repo], self.state), {"enabled": False})

    def test_identical_dirty_state_is_snapshotted_once(self):
        repo = make_repo(self.root, "twice")
        (repo / "a.txt").write_text("edited\n")
        first = preflight.snapshot_dirty(repo, self.state)
        second = preflight.snapshot_dirty(repo, self.state)
        self.assertEqual(first, second)
        self.assertEqual(len(list(self.state.glob("*.patch"))), 1)
        (repo / "a.txt").write_text("edited again\n")
        third = preflight.snapshot_dirty(repo, self.state)
        self.assertNotEqual(first, third)

    def test_same_repo_listed_twice_is_checked_once(self):
        repo = make_repo(self.root, "dup")
        (repo / "a.txt").write_text("x\n")
        report = preflight.run([repo, str(repo) + "/"], self.state)
        self.assertEqual(len(report["repos"]), 1)


class StartPipelinePreflightTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.env_path = self.root / "agent-manager.env"
        self.env_path.write_text("OTHER=keep\n")
        self.registry = self.root / "projects.json"
        self.state = self.root / "snapshots"
        self._saved_env = {k: os.environ.get(k) for k in ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PREFLIGHT", "AGENT_MANAGER_PREFLIGHT_DIR")}
        os.environ.pop("AGENT_MANAGER_PREFLIGHT", None)
        os.environ["AGENT_MANAGER_PREFLIGHT_DIR"] = str(self.state)
        self._saved = (app.ENV_FILE_PATH, app.PROJECT_REGISTRY_PATH)
        app.ENV_FILE_PATH, app.PROJECT_REGISTRY_PATH = self.env_path, self.registry
        self.patches = [
            mock.patch.object(app, "record_project_used"),
            mock.patch.object(app, "_ensure_task_domains"),
            mock.patch.object(app, "read_active_job_types", return_value=[]),
            # The launch step spawns real daemons. It is stubbed WHOLE (not subprocess.Popen) because the
            # pre-flight itself shells out to git through the same subprocess module.
            mock.patch.object(app, "_launch_pipeline_subprocess", side_effect=lambda env, raw, ia, sp: {"started": True, "repoRoot": raw}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        app.ENV_FILE_PATH, app.PROJECT_REGISTRY_PATH = self._saved
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def test_start_reports_both_the_entered_and_the_left_repo_and_still_starts(self):
        entered = make_repo(self.root, "entered")
        left = make_repo(self.root, "left")
        (entered / "a.txt").write_text("entered edit\n")
        (left / "a.txt").write_text("left edit\n")
        os.environ["AGENT_MANAGER_REPO_ROOT"] = str(left)
        result = app._start_pipeline(str(entered), True, True)
        self.assertTrue(result["started"])
        pf = result["preflight"]
        self.assertTrue(pf["dirty"])
        self.assertEqual({r["path"] for r in pf["repos"]}, {str(entered), str(left)})
        self.assertEqual(len(list(self.state.glob("*.patch"))), 2)
        self.assertTrue(pf["snapshot"])

    def test_start_still_succeeds_when_the_preflight_step_raises(self):
        entered = make_repo(self.root, "entered2")
        with mock.patch.object(preflight, "run", side_effect=RuntimeError("boom")):
            result = app._start_pipeline(str(entered), True, True)
        self.assertTrue(result["started"])
        self.assertEqual(result["preflight"]["error"], "boom")

    def test_off_switch_start_reports_disabled_and_starts(self):
        entered = make_repo(self.root, "entered3")
        (entered / "a.txt").write_text("edit\n")
        os.environ["AGENT_MANAGER_PREFLIGHT"] = "off"
        result = app._start_pipeline(str(entered), True, True)
        self.assertTrue(result["started"])
        self.assertEqual(result["preflight"], {"enabled": False})
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
