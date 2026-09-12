"""Tests that /api/git/branches/<branch>/merge closes out the GIT-TRACKED task log
(task-logs/<id>.json, see src/task-log-store.js) with a `merged` history event and
terminalDisposition, not just the queue/ working-copy JSON it already updated -- see
api_git_merge_branch's own comment. This is the other half of the durable-task-log
mechanism (2026-09-12, Grimmethy: "the final unmerged branches version should just be the
whole task log, completed... it should arguably have more information than an in-process
task"): task-logs/<id>.json is committed by apply-task.js when the task ships, so it
survives archival of queue/done/*.json, and this endpoint is the one place it can record
that the branch actually landed.

Uses the same real bare-origin + clone fixture as test_git_discard_branch.py, since
list_unmerged_branches/merge both do real subprocess git calls, not mocked output.

Run: .venv/bin/python -m unittest python.dashboard.test_git_merge_closes_task_log -v
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def make_repo_with_task_log_branch(branch_name, task_id):
    """Real bare 'origin' + a clone with a pushed agent/<id> branch ahead of main, whose
    single commit carries BOTH a real code change and a task-logs/<id>.json file -- the
    exact shape apply-task.js's writeTaskLogFile()+commit produces."""
    root = Path(tempfile.mkdtemp())
    bare = root / "origin.git"
    repo = root / "repo"
    _git(["init", "--bare", "-b", "main", str(bare)], cwd=root)
    _git(["clone", str(bare), str(repo)], cwd=root)
    _git(["config", "user.email", "test@example.com"], cwd=repo)
    _git(["config", "user.name", "Test"], cwd=repo)
    (repo / "README.md").write_text("test")
    _git(["add", "README.md"], cwd=repo)
    _git(["commit", "-q", "-m", "initial"], cwd=repo)
    _git(["push", "origin", "main"], cwd=repo)

    _git(["checkout", "-b", branch_name], cwd=repo)
    (repo / "feature.txt").write_text("a real change")
    task_log_dir = repo / "task-logs"
    task_log_dir.mkdir(parents=True, exist_ok=True)
    (task_log_dir / f"{task_id}.json").write_text(json.dumps({
        "id": task_id, "title": "A real fix", "domain": "default", "source": "observability_fix",
        "history": [
            {"stage": "created", "at": "2026-09-12T10:00:00Z"},
            {"stage": "applied", "at": "2026-09-12T10:10:00Z", "detail": f"agent/{task_id}"},
        ],
    }, indent=2) + "\n")
    _git(["add", "feature.txt", "task-logs"], cwd=repo)
    _git(["commit", "-q", "-m", f"A real fix\n\nTask: {task_id} (default/observability_fix)\nTask-Log: task-logs/{task_id}.json"], cwd=repo)
    _git(["push", "origin", branch_name], cwd=repo)
    _git(["checkout", "main"], cwd=repo)

    (repo / "queue" / "done").mkdir(parents=True, exist_ok=True)
    return repo, bare


class TestMergeClosesTaskLog(unittest.TestCase):
    def setUp(self):
        app._invalidate_branch_cache()
        self._apply_lock_patch = mock.patch.object(app, "_sync_live_checkout", return_value={"synced": False})
        self._apply_lock_patch.start()
        self.client = app.app.test_client()

    def tearDown(self):
        app._invalidate_branch_cache()
        self._apply_lock_patch.stop()

    def _patches(self, repo_root):
        return [
            mock.patch.object(app, "get_active_repo_root", return_value=str(repo_root)),
            mock.patch.object(app, "get_pipeline_dir", return_value=repo_root),
            mock.patch.object(app, "queue_dir", return_value=repo_root / "queue"),
        ]

    def test_merge_appends_a_merged_event_to_the_tracked_task_log_and_pushes_it(self):
        task_id = "observability-fix-ac-merge-test-1"
        repo, bare = make_repo_with_task_log_branch(f"agent/{task_id}", task_id)
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post(f"/api/git/branches/agent%2F{task_id}/merge")
            self.assertEqual(res.status_code, 200, res.get_json())
            self.assertTrue(res.get_json()["succeeded"])

            log_path = repo / "task-logs" / f"{task_id}.json"
            self.assertTrue(log_path.is_file())
            log_data = json.loads(log_path.read_text())
            self.assertEqual(log_data["terminalDisposition"], "merged")
            self.assertEqual(log_data["history"][-1]["stage"], "merged")
            # Every earlier event survives untouched -- append-only, not replaced.
            self.assertEqual(log_data["history"][0]["stage"], "created")
            self.assertEqual(log_data["history"][1]["stage"], "applied")

            # The finalized log must actually be pushed to origin -- "available at a
            # click, ever" means reachable from a fresh clone, not just this checkout.
            clone2 = repo.parent / "clone2"
            _git(["clone", str(bare), str(clone2)], cwd=repo.parent)
            remote_log = json.loads((clone2 / "task-logs" / f"{task_id}.json").read_text())
            self.assertEqual(remote_log["terminalDisposition"], "merged")
        finally:
            for p in patches:
                p.stop()

    def test_merge_is_a_no_op_on_the_task_log_when_none_exists(self):
        # A branch applied before this mechanism existed, or by some other path, simply
        # has no task-logs/<id>.json -- the merge must still succeed normally.
        task_id = "no-task-log-branch-1"
        root = Path(tempfile.mkdtemp())
        bare = root / "origin.git"
        repo = root / "repo"
        _git(["init", "--bare", "-b", "main", str(bare)], cwd=root)
        _git(["clone", str(bare), str(repo)], cwd=root)
        _git(["config", "user.email", "test@example.com"], cwd=repo)
        _git(["config", "user.name", "Test"], cwd=repo)
        (repo / "README.md").write_text("test")
        _git(["add", "README.md"], cwd=repo)
        _git(["commit", "-q", "-m", "initial"], cwd=repo)
        _git(["push", "origin", "main"], cwd=repo)
        _git(["checkout", "-b", f"agent/{task_id}"], cwd=repo)
        (repo / "feature.txt").write_text("a real change")
        _git(["add", "feature.txt"], cwd=repo)
        _git(["commit", "-q", "-m", "a real feature commit"], cwd=repo)
        _git(["push", "origin", f"agent/{task_id}"], cwd=repo)
        _git(["checkout", "main"], cwd=repo)
        (repo / "queue" / "done").mkdir(parents=True, exist_ok=True)

        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post(f"/api/git/branches/agent%2F{task_id}/merge")
            self.assertEqual(res.status_code, 200, res.get_json())
            self.assertTrue(res.get_json()["succeeded"])
            self.assertFalse((repo / "task-logs").exists())
        finally:
            for p in patches:
                p.stop()


if __name__ == "__main__":
    unittest.main()
