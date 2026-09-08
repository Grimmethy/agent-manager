"""Tests for the Unmerged Branches tab's Discard action (2026-09-08) -- see
api_git_discard_branch's own docstring in app.py for the full incident this closes:
change-review-fix-ac-1's branch stayed visible as "unmerged" even after its task was
archived by hand, because list_unmerged_branches is a pure git scan with zero awareness
of task disposition. Discard actually deletes the remote branch AND archives its task.

Run: .venv/bin/python -m unittest python.dashboard.test_git_discard_branch -v
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


def make_repo_with_pushed_branch(branch_name="agent/discard-test-1", extra_main_commit=False):
    """Real bare 'origin' + a clone with a pushed agent/<id> branch ahead of main --
    mirrors this session's own established fixture shape for git-remote-touching tests
    (real repo, not mocked git output, since list_unmerged_branches/discard both do real
    subprocess git calls)."""
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
    _git(["add", "feature.txt"], cwd=repo)
    _git(["commit", "-q", "-m", "a real feature commit"], cwd=repo)
    _git(["push", "origin", branch_name], cwd=repo)
    _git(["checkout", "main"], cwd=repo)

    (repo / "queue" / "done").mkdir(parents=True, exist_ok=True)
    (repo / "queue" / "done" / "_archived_no_action").mkdir(parents=True, exist_ok=True)
    return repo


class TestDiscardBranch(unittest.TestCase):
    def setUp(self):
        app._invalidate_branch_cache()
        self.client = app.app.test_client()

    def tearDown(self):
        app._invalidate_branch_cache()

    def _patches(self, repo_root):
        return [
            mock.patch.object(app, "get_active_repo_root", return_value=str(repo_root)),
            mock.patch.object(app, "get_pipeline_dir", return_value=repo_root),
            mock.patch.object(app, "queue_dir", return_value=repo_root / "queue"),
        ]

    def test_discard_deletes_the_remote_branch_and_it_drops_out_of_the_unmerged_list(self):
        repo = make_repo_with_pushed_branch("agent/discard-test-1")
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            before = app.list_unmerged_branches(force=True)
            self.assertTrue(any(b["branch"] == "agent/discard-test-1" for b in before))

            res = self.client.post("/api/git/branches/agent%2Fdiscard-test-1/discard")
            self.assertEqual(res.status_code, 200)
            body = res.get_json()
            self.assertTrue(body["succeeded"])
            self.assertFalse(body["taskArchived"], "no matching task file exists in this fixture")

            after = app.list_unmerged_branches(force=True)
            self.assertFalse(any(b["branch"] == "agent/discard-test-1" for b in after))
        finally:
            for p in patches:
                p.stop()

    def test_discard_archives_the_matching_task_file_as_dismissed(self):
        repo = make_repo_with_pushed_branch("agent/discard-test-2")
        task_id = "discard-test-2"
        (repo / "queue" / "done" / f"{task_id}.json").write_text(json.dumps({
            "id": task_id, "domain": "default", "source": "manual", "title": "t", "history": [],
        }))
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post("/api/git/branches/agent%2Fdiscard-test-2/discard")
            body = res.get_json()
            self.assertTrue(body["succeeded"])
            self.assertTrue(body["taskArchived"])

            self.assertFalse((repo / "queue" / "done" / f"{task_id}.json").exists())
            archived = json.loads((repo / "queue" / "done" / "_archived_no_action" / f"{task_id}.json").read_text())
            self.assertEqual(archived["terminalDisposition"], "dismissed")
            self.assertEqual(archived["history"][-1]["stage"], "dismissed")
        finally:
            for p in patches:
                p.stop()

    def test_discard_is_a_no_op_success_when_the_task_is_already_archived(self):
        repo = make_repo_with_pushed_branch("agent/discard-test-3")
        task_id = "discard-test-3"
        (repo / "queue" / "done" / "_archived_no_action" / f"{task_id}.json").write_text(json.dumps({
            "id": task_id, "title": "t", "terminalDisposition": "dismissed",
        }))
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post("/api/git/branches/agent%2Fdiscard-test-3/discard")
            body = res.get_json()
            self.assertTrue(body["succeeded"])
            self.assertTrue(body["taskArchived"])
        finally:
            for p in patches:
                p.stop()

    def test_discard_succeeds_with_taskArchived_false_when_no_task_file_exists_at_all(self):
        repo = make_repo_with_pushed_branch("agent/discard-test-4")
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post("/api/git/branches/agent%2Fdiscard-test-4/discard")
            body = res.get_json()
            self.assertTrue(body["succeeded"])
            self.assertFalse(body["taskArchived"])
        finally:
            for p in patches:
                p.stop()

    def test_discard_404s_a_branch_not_in_the_current_unmerged_list(self):
        repo = make_repo_with_pushed_branch("agent/discard-test-5")
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post("/api/git/branches/agent%2Fnot-a-real-branch/discard")
            self.assertEqual(res.status_code, 404)
        finally:
            for p in patches:
                p.stop()


if __name__ == "__main__":
    unittest.main()
