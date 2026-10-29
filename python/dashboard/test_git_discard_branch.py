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



# --- brain-dump #1740 (2026-10-03): a removal row says WHAT the branch held and WHY, and the commits stay reachable ----------------------------

def _git_out(args, cwd):
    return subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True).stdout.strip()


def _git_succeeds(args, cwd):
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True).returncode == 0


def _last_row(repo):
    return json.loads((repo / "queue" / "branch-removals.jsonl").read_text().splitlines()[-1])


def add_candidate_doc_commit(repo, branch_name):
    """One more commit on an already-pushed branch: a candidates doc with two headings (each with a Files: line) plus a NON-markdown file
    that also contains a heading-shaped line, which must not be counted."""
    _git(["checkout", branch_name], cwd=repo)
    (repo / "Docs").mkdir(exist_ok=True)
    (repo / "Docs" / "X_CANDIDATES.md").write_text(
        "# Candidates\n\n### AC-1 \u00b7 Decompose foo\nStrength: Strong\nFiles: src/a.js\n\nProblem:\np\n\n"
        "### AC-2 \u00b7 Decompose bar\nStrength: Strong\nFiles: src/b.js, src/c.js\n\nProblem:\np\n")
    (repo / "notes.txt").write_text("### AC-9 \u00b7 not a markdown doc\nFiles: nope.js\n")
    _git(["add", "Docs", "notes.txt"], cwd=repo)
    _git(["commit", "-q", "-m", "add candidates"], cwd=repo)
    _git(["push", "origin", branch_name], cwd=repo)
    _git(["checkout", "main"], cwd=repo)


class TestRemovalSnapshot(unittest.TestCase):
    """The discard/merge endpoints record a snapshot of the branch in queue/branch-removals.jsonl (brain-dump #1740)."""

    def setUp(self):
        app._invalidate_branch_cache()
        self.client = app.app.test_client()
        # The real apply lock is ~/.local/state/agent-manager/locks/apply-task.lock, the SAME file the live apply-task.sh loop holds every tick.
        # An endpoint test that takes it for real gets a 409 whenever the live pipeline happens to be mid-apply (seen under load: the older
        # tests in this file are exposed to that flake). These tests are about the ledger row, not the lock, so they do not touch it.
        self._patches_started = [
            mock.patch.object(app, "_sync_live_checkout", return_value={"synced": False}),
            mock.patch.object(app, "_acquire_apply_lock", return_value=object()),
            mock.patch.object(app, "_release_apply_lock", return_value=None),
        ]
        for p in self._patches_started:
            p.start()

    def tearDown(self):
        for p in self._patches_started:
            p.stop()
        app._invalidate_branch_cache()

    def _discard(self, repo, branch, body=None):
        patches = TestDiscardBranch._patches(self, repo)
        for p in patches:
            p.start()
        try:
            kwargs = {"json": body} if body is not None else {}
            return self.client.post(f"/api/git/branches/{branch.replace('/', '%2F')}/discard", **kwargs)
        finally:
            for p in patches:
                p.stop()

    def test_discard_row_carries_the_branch_snapshot(self):
        repo = make_repo_with_pushed_branch("agent/snap-1")
        head = _git_out(["rev-parse", "refs/remotes/origin/agent/snap-1"], repo)
        self.assertTrue(self._discard(repo, "agent/snap-1").get_json()["succeeded"])
        row = _last_row(repo)
        self.assertEqual(row["headSha"], head)
        self.assertEqual(row["base"], "origin/main")
        self.assertEqual(row["commitCount"], 1)
        self.assertEqual(row["commits"], [{"sha": head[:12], "subject": "a real feature commit"}])
        # the original keys are all still there, unchanged
        self.assertEqual((row["branch"], row["cause"], row["taskId"], row["actor"]), ("agent/snap-1", "discarded", "snap-1", "dashboard-discard"))

    def test_snapshot_ref_still_resolves_after_the_remote_and_local_branch_are_gone(self):
        repo = make_repo_with_pushed_branch("agent/snap-2")
        head = _git_out(["rev-parse", "refs/remotes/origin/agent/snap-2"], repo)
        res = self._discard(repo, "agent/snap-2").get_json()
        row = _last_row(repo)
        self.assertTrue(row["snapshotRef"].startswith("refs/discarded/agent/snap-2/"), row.get("snapshotRef"))
        self.assertEqual(res["snapshotRef"], row["snapshotRef"])
        self.assertEqual(_git_out(["rev-parse", row["snapshotRef"]], repo), head)
        self.assertFalse(_git_succeeds(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/agent/snap-2"], repo), "remote-tracking ref is gone")
        self.assertEqual(_git_out(["branch", "--list", "agent/snap-2"], repo), "", "local branch is gone")

    def test_candidates_added_by_the_branch_are_recorded_with_their_files(self):
        repo = make_repo_with_pushed_branch("agent/snap-3")
        add_candidate_doc_commit(repo, "agent/snap-3")
        self._discard(repo, "agent/snap-3")
        row = _last_row(repo)
        self.assertEqual(row["commitCount"], 2)
        self.assertEqual(row["candidates"], [
            {"id": "AC-1", "title": "Decompose foo", "files": "src/a.js"},
            {"id": "AC-2", "title": "Decompose bar", "files": "src/b.js, src/c.js"},
        ])
        self.assertEqual(row["candidatesTotal"], 2)

    def test_a_recorded_verdict_is_copied_and_becomes_the_default_reason(self):
        import branch_verdicts as bv
        repo = make_repo_with_pushed_branch("agent/snap-4")
        head = _git_out(["rev-parse", "refs/remotes/origin/agent/snap-4"], repo)
        bv.record_verdict(repo / "queue", "agent/snap-4", head, "discard", ["first reason", "second reason"], "chat")
        self._discard(repo, "agent/snap-4")
        row = _last_row(repo)
        self.assertEqual(row["reason"], "first reason")
        self.assertEqual(row["verdict"], {"verdict": "discard", "reasons": ["first reason", "second reason"], "source": "chat", "sha": head[:12]})

    def test_an_explicit_reason_in_the_request_body_wins_over_the_verdict_default(self):
        import branch_verdicts as bv
        repo = make_repo_with_pushed_branch("agent/snap-5")
        head = _git_out(["rev-parse", "refs/remotes/origin/agent/snap-5"], repo)
        bv.record_verdict(repo / "queue", "agent/snap-5", head, "discard", ["verdict reason"], "chat")
        self._discard(repo, "agent/snap-5", body={"reason": "dead end, duplicates AC-10"})
        row = _last_row(repo)
        self.assertEqual(row["reason"], "dead end, duplicates AC-10")
        self.assertEqual(row["verdict"]["reasons"], ["verdict reason"])

    def test_a_verdict_for_an_older_commit_is_not_copied_and_gives_no_reason(self):
        import branch_verdicts as bv
        repo = make_repo_with_pushed_branch("agent/snap-6")
        bv.record_verdict(repo / "queue", "agent/snap-6", "a" * 40, "discard", ["about some OLDER commit"], "chat")
        self._discard(repo, "agent/snap-6")
        row = _last_row(repo)
        self.assertNotIn("verdict", row)
        self.assertNotIn("reason", row)

    def test_a_failing_snapshot_still_discards_and_writes_the_original_minimal_row(self):
        repo = make_repo_with_pushed_branch("agent/snap-7")
        with mock.patch("branch_removals.snapshot_branch", side_effect=RuntimeError("boom")):
            res = self._discard(repo, "agent/snap-7")
        self.assertTrue(res.get_json()["succeeded"])
        self.assertIsNone(res.get_json()["snapshotRef"])
        self.assertEqual(set(_last_row(repo)), {"branch", "taskId", "cause", "detail", "actor", "at"})
        self.assertFalse(_git_succeeds(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/agent/snap-7"], repo), "the branch really was deleted")

    def test_merge_row_carries_the_snapshot_and_pins_no_ref(self):
        repo = make_repo_with_pushed_branch("agent/snap-8")
        head = _git_out(["rev-parse", "refs/remotes/origin/agent/snap-8"], repo)
        patches = TestDiscardBranch._patches(self, repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post("/api/git/branches/agent%2Fsnap-8/merge")
            self.assertEqual(res.status_code, 200, res.get_json())
        finally:
            for p in patches:
                p.stop()
        row = _last_row(repo)
        self.assertEqual((row["cause"], row["actor"]), ("merged", "dashboard-merge"))
        self.assertEqual(row["headSha"], head)
        self.assertEqual(row["commits"][0]["subject"], "a real feature commit")
        self.assertNotIn("snapshotRef", row)


class TestRemovalRowFields(unittest.TestCase):
    """record_branch_removal's optional fields and snapshot_branch, directly."""

    def test_the_legacy_call_shape_writes_exactly_the_original_keys(self):
        from branch_removals import record_branch_removal
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(record_branch_removal(d, "origin/agent/x", "merged", task_id="x", detail="d", actor="a"))
            row = json.loads((Path(d) / "branch-removals.jsonl").read_text())
            self.assertEqual(set(row), {"branch", "taskId", "cause", "detail", "actor", "at"})

    def test_oversized_lists_are_capped_and_unknown_snapshot_keys_are_ignored(self):
        from branch_removals import record_branch_removal
        snap = {
            "headSha": "a" * 40, "base": "origin/master", "commitCount": 99,
            "commits": [{"sha": "b" * 40, "subject": "s" * 500}] * 50,
            "candidates": [{"id": "AC-%d" % i, "title": "t" * 400, "files": "f" * 400} for i in range(60)], "candidatesTotal": 60,
            "verdict": {"verdict": "discard", "reasons": ["r" * 500] * 9, "source": "chat", "sha": "c" * 40},
            "bogus": "drop me",
        }
        with tempfile.TemporaryDirectory() as d:
            record_branch_removal(d, "agent/y", "discarded", reason="r" * 900, snapshot=snap)
            row = json.loads((Path(d) / "branch-removals.jsonl").read_text())
        self.assertNotIn("bogus", row)
        self.assertEqual(len(row["reason"]), 300)
        self.assertLessEqual(len(row["commits"]), 20)
        self.assertEqual(len(row["commits"][0]["sha"]), 12)
        self.assertLessEqual(len(row["candidates"]), 25)
        self.assertEqual(row["candidatesTotal"], 60)
        self.assertEqual(len(row["verdict"]["reasons"]), 5)
        self.assertLessEqual(len(row["verdict"]["reasons"][0]), 200)

    def test_a_malformed_snapshot_is_ignored_and_the_row_is_still_written(self):
        from branch_removals import record_branch_removal
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(record_branch_removal(d, "agent/z", "discarded", snapshot="not a dict"))
            self.assertTrue(record_branch_removal(d, "agent/w", "discarded", snapshot={"commits": "x", "candidates": 5, "commitCount": True, "verdict": "no"}))
            for line in (Path(d) / "branch-removals.jsonl").read_text().splitlines():
                self.assertEqual(set(json.loads(line)), {"branch", "taskId", "cause", "detail", "actor", "at"})

    def test_a_row_over_the_size_limit_trims_commits_first_and_keeps_the_candidates(self):
        import branch_removals as br
        snap = {"commits": [{"sha": "b" * 12, "subject": "s" * 120}] * 20,
                "candidates": [{"id": "AC-%d" % i, "title": "t" * 140, "files": "f" * 160} for i in range(25)], "candidatesTotal": 25}
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(br, "MAX_ROW_CHARS", 9000):
                br.record_branch_removal(d, "agent/q", "discarded", snapshot=snap)
            row = json.loads((Path(d) / "branch-removals.jsonl").read_text())
        self.assertLess(len(row["commits"]), 20, "commits are trimmed first")
        self.assertEqual(len(row["candidates"]), 25, "candidates survive while trimming commits is enough")
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(br, "MAX_ROW_CHARS", 3000):
                br.record_branch_removal(d, "agent/q", "discarded", snapshot=snap)
            row = json.loads((Path(d) / "branch-removals.jsonl").read_text())
        self.assertEqual(row["commits"], [])
        self.assertLess(len(row["candidates"]), 25)
        self.assertEqual(row["candidatesOmitted"], 25 - len(row["candidates"]), "the cut is stated, never silent")

    def test_snapshot_branch_never_raises_even_when_git_fails_everywhere(self):
        from branch_removals import snapshot_branch
        def boom(args, cwd):
            raise RuntimeError("git exploded")
        self.assertEqual(snapshot_branch(boom, "/nonexistent", "main", "agent/x", None, None), {})
        partial = snapshot_branch(boom, "/nonexistent", "main", "agent/x", "d" * 40, None, keep_ref=True)
        self.assertEqual(partial["headSha"], "d" * 40)
        self.assertNotIn("snapshotRef", partial)

    def test_snapshot_branch_on_a_real_repo_without_a_verdict_file(self):
        from branch_removals import snapshot_branch
        repo = make_repo_with_pushed_branch("agent/snap-u")
        snap = snapshot_branch(app._run_git, str(repo), "main", "agent/snap-u", None, repo / "queue")
        self.assertEqual(snap["headSha"], _git_out(["rev-parse", "refs/remotes/origin/agent/snap-u"], repo))
        self.assertEqual((snap["base"], snap["commitCount"]), ("origin/main", 1))
        self.assertNotIn("verdict", snap)
        self.assertNotIn("snapshotRef", snap, "no ref unless keep_ref=True")
        with_ref = snapshot_branch(app._run_git, str(repo), "main", "agent/snap-u", None, repo / "queue", keep_ref=True)
        self.assertEqual(_git_out(["rev-parse", with_ref["snapshotRef"]], repo), snap["headSha"])

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
