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


    # --- local-branch cleanup (2026-09-19) ---------------------------------------------------------------
    # The discard used to delete only the REMOTE branch. The apply repo is usually the pipeline's own
    # checkout, so the local agent/<id> branch (and the discarded commit) stayed behind: the task kept
    # reading pending-merge, and apply-task's prepareStackedBranch would reuse a local branch that descends
    # from current main as "real unpushed work" and rebuild on the discarded commit.

    @staticmethod
    def _local_branches(repo):
        out = subprocess.run(["git", "branch", "--format=%(refname:short)"], cwd=str(repo), capture_output=True, text=True, check=True)
        return out.stdout.split()

    @staticmethod
    def _sha(repo, ref):
        return subprocess.run(["git", "rev-parse", ref], cwd=str(repo), capture_output=True, text=True, check=True).stdout.strip()

    def _discard(self, repo, branch_name):
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            return self.client.post(f"/api/git/branches/{branch_name.replace('/', '%2F')}/discard")
        finally:
            for p in patches:
                p.stop()

    def test_discard_also_deletes_the_local_branch_and_reports_its_sha_for_recovery(self):
        repo = make_repo_with_pushed_branch("agent/discard-local-1")
        tip = self._sha(repo, "agent/discard-local-1")
        self.assertIn("agent/discard-local-1", self._local_branches(repo), "sanity: the fixture leaves a local branch behind")

        res = self._discard(repo, "agent/discard-local-1")
        body = res.get_json()
        self.assertEqual(res.status_code, 200)
        self.assertTrue(body["succeeded"])
        self.assertEqual(body["localBranch"], {"deleted": True, "sha": tip})
        self.assertNotIn("agent/discard-local-1", self._local_branches(repo))
        # Recoverable from the reported sha.
        subprocess.run(["git", "branch", "recovered", tip], cwd=str(repo), check=True, capture_output=True)
        self.assertIn("recovered", self._local_branches(repo))

    def test_discard_deletes_a_local_branch_that_has_unpushed_commits_and_no_longer_descends_from_main(self):
        # The PropertyForager shape: main moved on after the branch was cut, and the local copy holds a commit
        # the remote never had (apply committed locally, push later discarded). Both are exactly what `-D` is for.
        repo = make_repo_with_pushed_branch("agent/discard-local-2")
        _git(["checkout", "agent/discard-local-2"], cwd=repo)
        (repo / "extra.txt").write_text("unpushed")
        _git(["add", "extra.txt"], cwd=repo)
        _git(["commit", "-q", "-m", "unpushed local-only commit"], cwd=repo)
        _git(["checkout", "main"], cwd=repo)
        (repo / "main-moved.txt").write_text("x")
        _git(["add", "main-moved.txt"], cwd=repo)
        _git(["commit", "-q", "-m", "main moved on"], cwd=repo)
        _git(["push", "origin", "main"], cwd=repo)

        body = self._discard(repo, "agent/discard-local-2").get_json()
        self.assertTrue(body["succeeded"])
        self.assertTrue(body["localBranch"]["deleted"])
        self.assertNotIn("agent/discard-local-2", self._local_branches(repo))

    def test_discard_never_deletes_the_checked_out_branch_but_still_deletes_the_remote_and_says_so(self):
        repo = make_repo_with_pushed_branch("agent/discard-local-3")
        _git(["checkout", "agent/discard-local-3"], cwd=repo)
        tip = self._sha(repo, "HEAD")

        body = self._discard(repo, "agent/discard-local-3").get_json()
        self.assertTrue(body["succeeded"], "the remote delete is the part that matters")
        self.assertFalse(body["localBranch"]["deleted"])
        self.assertEqual(body["localBranch"]["sha"], tip)
        self.assertIn("checked out", body["localBranch"]["reason"])
        self.assertIn("agent/discard-local-3", self._local_branches(repo))
        remote = subprocess.run(["git", "ls-remote", "--heads", "origin", "agent/discard-local-3"], cwd=str(repo), capture_output=True, text=True).stdout
        self.assertEqual(remote.strip(), "", "remote branch is gone")

    def test_discard_reports_no_local_branch_when_there_is_none(self):
        repo = make_repo_with_pushed_branch("agent/discard-local-4")
        _git(["branch", "-D", "agent/discard-local-4"], cwd=repo)
        body = self._discard(repo, "agent/discard-local-4").get_json()
        self.assertTrue(body["succeeded"])
        self.assertEqual(body["localBranch"], {"deleted": False, "reason": "no local branch"})

    def test_a_failed_remote_delete_leaves_the_local_branch_alone(self):
        repo = make_repo_with_pushed_branch("agent/discard-local-5")
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            listed = app.list_unmerged_branches(force=True)
            self.assertTrue(any(b["branch"] == "agent/discard-local-5" for b in listed))
            _git(["remote", "set-url", "origin", str(repo.parent / "does-not-exist.git")], cwd=repo)  # a REAL push failure
            res = self.client.post("/api/git/branches/agent%2Fdiscard-local-5/discard")
            self.assertEqual(res.status_code, 500)
            self.assertFalse(res.get_json()["succeeded"])
            self.assertIn("agent/discard-local-5", self._local_branches(repo), "nothing is deleted locally when the remote delete did not happen")
        finally:
            for p in patches:
                p.stop()


if __name__ == "__main__":
    unittest.main()


class TestBranchRemovalLedger(unittest.TestCase):
    """Every in-app path that deletes a branch records WHY in queue/branch-removals.jsonl, so a later
    task-log-reconcile no longer has to call the vanished branch a bare "work lost"."""

    def setUp(self):
        app._invalidate_branch_cache()
        self.client = app.app.test_client()

    def _patches(self, repo):
        return TestDiscardBranch._patches(self, repo)

    def test_discard_records_a_removal_entry(self):
        repo = make_repo_with_pushed_branch("agent/ledger-test-1")
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post("/api/git/branches/agent%2Fledger-test-1/discard")
            self.assertTrue(res.get_json()["succeeded"])
            lines = (repo / "queue" / "branch-removals.jsonl").read_text().splitlines()
            entry = json.loads(lines[-1])
            self.assertEqual(entry["branch"], "agent/ledger-test-1")
            self.assertEqual(entry["cause"], "discarded")
            self.assertEqual(entry["taskId"], "ledger-test-1")
            self.assertEqual(entry["actor"], "dashboard-discard")
        finally:
            for p in patches:
                p.stop()

    def test_writer_is_best_effort_and_validates_cause(self):
        from branch_removals import record_branch_removal
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(record_branch_removal(d, "origin/agent/x", "merged", task_id="x"))
            self.assertEqual(json.loads((Path(d) / "branch-removals.jsonl").read_text())["branch"], "agent/x")
            self.assertFalse(record_branch_removal(d, "agent/x", "because"))
            self.assertFalse(record_branch_removal(None, "agent/x", "merged"))
            blocker = Path(d) / "afile"
            blocker.write_text("x")
            self.assertFalse(record_branch_removal(blocker / "sub", "agent/x", "merged"))
