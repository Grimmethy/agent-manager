"""Tests that /api/task/<state>/<id>/requeue stamps terminalDisposition:'abandoned' and
deletes the superseded remote branch when the task being requeued was already applied to
a branch that never merged (task-disposition.js's 'pending-merge' shape). Before this fix,
a requeue silently orphaned the prior agent/<id> branch -- it stayed pushed to GitHub,
unmerged, with no PR and no record anywhere that a later attempt superseded it. Confirmed
live 2026-09-13: adhoc-add-spec-comment-at-call-site-in-src-local-draft-js-1789232601161-1's
forbidden-path-gate-blocked branch sat dangling until a human noticed and deleted it by
hand.

Uses the same real bare-origin + clone fixture as test_git_merge_closes_task_log.py, since
this path does a real subprocess git branch delete, not mocked output. Deliberately does
NOT touch task-logs/<id>.json on <main> -- that file is committed only on the task's own
branch, so for an unmerged branch it was never on <main> to begin with (see the app.py
comment at the abandon block, and task-disposition.js's 'abandoned' docstring: reconcile's
own version of this has the identical scope).

Run: .venv/bin/python -m unittest python.dashboard.test_requeue_abandons_branch -v
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


def make_repo_with_applied_branch(task_id, *, with_task_log=True):
    """Real bare 'origin' + a clone with a pushed, unmerged agent/<id> branch -- the
    'pending-merge' shape a task reaches once apply-task.js pushes its branch but nothing
    has merged it yet."""
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

    branch = f"agent/{task_id}"
    _git(["checkout", "-b", branch], cwd=repo)
    (repo / "feature.txt").write_text("an off-target attempt")
    if with_task_log:
        task_log_dir = repo / "task-logs"
        task_log_dir.mkdir(parents=True, exist_ok=True)
        (task_log_dir / f"{task_id}.json").write_text(json.dumps({
            "id": task_id, "title": "T", "domain": "adhoc", "source": "manual",
            "history": [
                {"stage": "created", "at": "2026-09-13T00:00:00Z"},
                {"stage": "applied", "at": "2026-09-13T00:10:00Z", "detail": branch},
            ],
        }, indent=2) + "\n")
        _git(["add", "feature.txt", "task-logs"], cwd=repo)
    else:
        _git(["add", "feature.txt"], cwd=repo)
    _git(["commit", "-q", "-m", f"T\n\nTask: {task_id} (adhoc/manual)"], cwd=repo)
    _git(["push", "origin", branch], cwd=repo)
    _git(["checkout", "main"], cwd=repo)

    (repo / "queue" / "done").mkdir(parents=True, exist_ok=True)
    (repo / "queue" / "pending").mkdir(parents=True, exist_ok=True)
    return repo, bare, branch


class TestRequeueAbandonsBranch(unittest.TestCase):
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

    def _write_done(self, repo, task_id, branch):
        (repo / "queue" / "done" / f"{task_id}.json").write_text(json.dumps({
            "id": task_id, "title": "T", "domain": "adhoc", "source": "manual",
            "history": [
                {"stage": "created", "at": "2026-09-13T00:00:00Z"},
                {"stage": "applied", "at": "2026-09-13T00:10:00Z", "detail": branch},
                {"stage": "pending-merge", "at": "2026-09-13T00:11:00Z", "detail": f"{branch} is 1 commit(s) ahead of main, not merged"},
            ],
        }))

    def test_requeue_deletes_the_superseded_branch_and_stamps_abandoned(self):
        task_id = "adhoc-requeue-abandon-test-1"
        repo, bare, branch = make_repo_with_applied_branch(task_id)
        self._write_done(repo, task_id, branch)
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post(f"/api/task/done/{task_id}/requeue")
            self.assertEqual(res.status_code, 200, res.get_json())

            pending = json.loads((repo / "queue" / "pending" / f"{task_id}.json").read_text())
            self.assertEqual(pending["history"][-2]["stage"], "abandoned")
            self.assertIn(branch, pending["history"][-2]["detail"])
            self.assertEqual(pending["history"][-1]["stage"], "requeued")

            # The remote branch must actually be gone, not just forgotten locally.
            clone2 = repo.parent / "clone2"
            _git(["clone", str(bare), str(clone2)], cwd=repo.parent)
            branches = subprocess.run(
                ["git", "branch", "-r"], cwd=clone2, capture_output=True, text=True, check=True,
            ).stdout
            self.assertNotIn(branch, branches)
        finally:
            for p in patches:
                p.stop()

    def test_requeue_is_a_no_op_on_disposition_when_task_was_never_applied(self):
        # A task blocked before ever reaching implement/apply has no 'applied' history
        # event -- nothing to abandon, no branch to touch, no git calls attempted.
        task_id = "adhoc-never-applied-1"
        root = Path(tempfile.mkdtemp())
        pipeline_dir = root / "pipeline"
        (pipeline_dir / "queue" / "blocked").mkdir(parents=True, exist_ok=True)
        (pipeline_dir / "queue" / "pending").mkdir(parents=True, exist_ok=True)
        (pipeline_dir / "queue" / "blocked" / f"{task_id}.json").write_text(json.dumps({
            "id": task_id, "title": "T", "domain": "adhoc", "source": "manual",
            "history": [
                {"stage": "created", "at": "1"},
                {"stage": "blocked", "at": "2", "detail": "a real block reason"},
            ],
        }))
        patches = [
            mock.patch.object(app, "get_active_repo_root", return_value=None),
            mock.patch.object(app, "get_pipeline_dir", return_value=pipeline_dir),
            mock.patch.object(app, "queue_dir", return_value=pipeline_dir / "queue"),
        ]
        for p in patches:
            p.start()
        try:
            res = self.client.post(f"/api/task/blocked/{task_id}/requeue")
            self.assertEqual(res.status_code, 200, res.get_json())
            pending = json.loads((pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text())
            self.assertNotIn("terminalDisposition", pending)
            self.assertEqual([h["stage"] for h in pending["history"]], ["created", "blocked", "requeued"])
        finally:
            for p in patches:
                p.stop()

    def test_requeue_skips_branch_cleanup_when_already_merged(self):
        # A task record that (rarely) reached done/ with terminalDisposition already
        # 'merged' must never have its (now-legitimate, landed) branch deleted.
        task_id = "adhoc-already-merged-1"
        repo, bare, branch = make_repo_with_applied_branch(task_id, with_task_log=False)
        (repo / "queue" / "done" / f"{task_id}.json").write_text(json.dumps({
            "id": task_id, "title": "T", "domain": "adhoc", "source": "manual",
            "terminalDisposition": "merged",
            "history": [
                {"stage": "created", "at": "1"},
                {"stage": "applied", "at": "2", "detail": branch},
                {"stage": "merged", "at": "3"},
            ],
        }))
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post(f"/api/task/done/{task_id}/requeue")
            self.assertEqual(res.status_code, 200, res.get_json())
            clone2 = repo.parent / "clone2"
            _git(["clone", str(bare), str(clone2)], cwd=repo.parent)
            branches = subprocess.run(
                ["git", "branch", "-r"], cwd=clone2, capture_output=True, text=True, check=True,
            ).stdout
            self.assertIn(branch, branches)
        finally:
            for p in patches:
                p.stop()


if __name__ == "__main__":
    unittest.main()
