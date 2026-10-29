"""A requeue must not delete a branch other live work sits on (2026-10-08: the HUB0022-01 requeue deleted the hub's shared branch and destroyed the
approved, unmerged HUB0018-01 commit on it, which reconcile then recorded as "abandoned: work lost").

Same real bare-origin + clone fixture as test_requeue_abandons_branch.py. The sibling check is src/lib/shared-branch.js, reached through its CLI.

Run: .venv/bin/python -m unittest python.dashboard.test_requeue_keeps_shared_branch -v
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
from test_requeue_abandons_branch import make_repo_with_applied_branch, _git  # noqa: E402

SHARED = "agent/decompose-adhoc-token-sync-1791297583352"


def make_shared_branch(sibling_disposition=None):
    """Origin with ONE branch carrying two tasks' commits: the requeued child and a sibling."""
    repo, bare, _own = make_repo_with_applied_branch("unused-own-branch", with_task_log=False)
    _git(["checkout", "-b", SHARED], cwd=repo)
    (repo / "StartPage.tsx").write_text("the sibling's approved change")
    _git(["add", "StartPage.tsx"], cwd=repo)
    _git(["commit", "-q", "-m", "HUB0018-01\n\nTask: HUB0018-01 (adhoc/manual)"], cwd=repo)
    (repo / "App.tsx").write_text("the requeued child's change")
    _git(["add", "App.tsx"], cwd=repo)
    _git(["commit", "-q", "-m", "HUB0022-01\n\nTask: HUB0022-01 (adhoc/manual)"], cwd=repo)
    _git(["push", "origin", SHARED], cwd=repo)
    _git(["checkout", "main"], cwd=repo)
    applied = lambda: [  # noqa: E731
        {"stage": "created", "at": "2026-10-07T07:00:00Z"},
        {"stage": "applied", "at": "2026-10-07T07:20:18Z", "detail": SHARED},
        {"stage": "pending-merge", "at": "2026-10-07T07:20:29Z", "detail": f"{SHARED} is 2 commit(s) ahead of main, not merged"},
    ]
    done = repo / "queue" / "done"
    done.mkdir(parents=True, exist_ok=True)
    (repo / "queue" / "pending").mkdir(parents=True, exist_ok=True)
    child = {"id": "HUB0022-01", "title": "T", "domain": "adhoc", "source": "manual", "stacked": {"branch": SHARED, "seq": 2, "total": 3},
             "terminalDisposition": "pending-merge", "history": applied()}
    sibling = {"id": "HUB0018-01", "title": "T", "domain": "adhoc", "source": "manual", "stacked": {"branch": SHARED, "seq": 1, "total": 2},
               "history": applied()}
    if sibling_disposition:
        sibling["terminalDisposition"] = sibling_disposition
    (done / "HUB0022-01.json").write_text(json.dumps(child))
    (done / "HUB0018-01.json").write_text(json.dumps(sibling))
    return repo, bare


def remote_branches(repo, bare):
    clone = Path(tempfile.mkdtemp()) / "c"
    _git(["clone", str(bare), str(clone)], cwd=repo.parent)
    return subprocess.run(["git", "branch", "-r"], cwd=clone, capture_output=True, text=True, check=True).stdout


class TestRequeueKeepsSharedBranch(unittest.TestCase):
    def setUp(self):
        app._invalidate_branch_cache()
        self.client = app.app.test_client()

    def tearDown(self):
        app._invalidate_branch_cache()

    def _patches(self, repo):
        return [
            mock.patch.object(app, "get_active_repo_root", return_value=str(repo)),
            mock.patch.object(app, "get_pipeline_dir", return_value=repo),
            mock.patch.object(app, "queue_dir", return_value=repo / "queue"),
        ]

    def _requeue(self, repo, task_id="HUB0022-01"):
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            return self.client.post(f"/api/task/done/{task_id}/requeue")
        finally:
            for p in patches:
                p.stop()

    def test_a_branch_shared_with_a_live_sibling_is_kept_and_nothing_is_stamped_abandoned(self):
        repo, bare = make_shared_branch()
        res = self._requeue(repo)
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertIn(SHARED, remote_branches(repo, bare), "the shared branch must survive the requeue")
        pending = json.loads((repo / "queue" / "pending" / "HUB0022-01.json").read_text())
        stages = [h["stage"] for h in pending["history"]]
        self.assertIn("branch-kept", stages)
        self.assertNotIn("abandoned", stages)
        self.assertNotIn("terminalDisposition", pending)
        kept = next(h for h in pending["history"] if h["stage"] == "branch-kept")
        self.assertIn("HUB0018-01", kept["detail"])
        self.assertEqual(pending["stacked"]["branch"], SHARED, "the stack is carried so the redraft grounds on the kept branch")
        self.assertFalse((repo / "queue" / "branch-removals.jsonl").exists(), "no removal was made, so none is recorded")
        # the sibling's record is untouched
        sib = json.loads((repo / "queue" / "done" / "HUB0018-01.json").read_text())
        self.assertNotIn("abandoned", [h["stage"] for h in sib["history"]])

    def test_a_terminal_sibling_does_not_protect_the_branch(self):
        repo, bare = make_shared_branch(sibling_disposition="merged")
        res = self._requeue(repo)
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertNotIn(SHARED, remote_branches(repo, bare), "only a MERGED sibling shares it: deleting loses nothing live")
        pending = json.loads((repo / "queue" / "pending" / "HUB0022-01.json").read_text())
        self.assertIn("abandoned", [h["stage"] for h in pending["history"]])

    def test_a_failing_sibling_check_keeps_the_branch(self):
        repo, bare = make_shared_branch(sibling_disposition="merged")  # would otherwise be deleted
        with mock.patch("routes.task._shared_branch_siblings", return_value={"siblings": [], "error": "node missing"}):
            res = self._requeue(repo)
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertIn(SHARED, remote_branches(repo, bare))
        pending = json.loads((repo / "queue" / "pending" / "HUB0022-01.json").read_text())
        kept = next(h for h in pending["history"] if h["stage"] == "branch-kept")
        self.assertIn("sibling check failed", kept["detail"])

    def test_the_helper_reports_siblings_through_the_node_cli(self):
        repo, _bare = make_shared_branch()
        from routes.task import _shared_branch_siblings
        out = _shared_branch_siblings(repo / "queue", SHARED, "HUB0022-01")
        self.assertEqual([s["id"] for s in out["siblings"]], ["HUB0018-01"])
        self.assertNotIn("error", out)


if __name__ == "__main__":
    unittest.main()
