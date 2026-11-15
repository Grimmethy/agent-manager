"""Tests for the Unmerged Branches tab's "Discard all" batch route (POST /api/git/branches/discard-batch, owner request 2026-10-31) and the helper both it and the
single Discard route share (branch_discard.py). Same real-git fixtures as test_git_discard_branch.py.

Run: .venv/bin/python -m unittest python.dashboard.test_discard_batch -v
"""
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import branch_discard  # noqa: E402
import branch_verdicts  # noqa: E402
from test_git_discard_branch import _git, make_repo_with_pushed_branch  # noqa: E402


def add_branch(repo, name):
    _git(["checkout", "-q", "-b", name, "main"], cwd=repo)
    (repo / (name.replace("/", "_") + ".txt")).write_text("change for " + name)
    _git(["add", "-A"], cwd=repo)
    _git(["commit", "-q", "-m", "change " + name], cwd=repo)
    _git(["push", "-q", "origin", name], cwd=repo)
    _git(["checkout", "-q", "main"], cwd=repo)


def head_of(repo, branch):
    return subprocess.run(["git", "rev-parse", f"refs/remotes/origin/{branch}"], cwd=str(repo), capture_output=True, text=True, check=True).stdout.strip()


def on_origin(repo, branch):
    out = subprocess.run(["git", "ls-remote", "--heads", "origin", branch], cwd=str(repo), capture_output=True, text=True, check=True).stdout
    return bool(out.strip())


def mark(repo, branch, verdict="discard", sha=None):
    branch_verdicts.record_verdict(repo / "queue", branch, sha or head_of(repo, branch), verdict, ["test reason"], "chat")


class TestDiscardBatch(unittest.TestCase):
    def setUp(self):
        app._invalidate_branch_cache()
        self.client = app.app.test_client()
        self.acquire = mock.MagicMock(return_value=object())
        self.release = mock.MagicMock(return_value=None)
        self.started = [
            mock.patch.object(app, "_sync_live_checkout", return_value={"synced": False}),
            mock.patch.object(app, "_acquire_apply_lock", self.acquire),
            mock.patch.object(app, "_release_apply_lock", self.release),
        ]
        for p in self.started:
            p.start()

    def tearDown(self):
        for p in self.started:
            p.stop()
        app._invalidate_branch_cache()

    def _post(self, repo, items, **extra):
        patches = [
            mock.patch.object(app, "get_active_repo_root", return_value=str(repo)),
            mock.patch.object(app, "get_pipeline_dir", return_value=repo),
            mock.patch.object(app, "queue_dir", return_value=repo / "queue"),
        ]
        for p in patches:
            p.start()
        try:
            return self.client.post("/api/git/branches/discard-batch", json={"branches": items, **extra})
        finally:
            for p in patches:
                p.stop()

    def _item(self, repo, branch, **kw):
        return {"branch": branch, "project": "", "sha": head_of(repo, branch), **kw}

    def test_every_discard_verdict_item_is_deleted_under_one_lock(self):
        repo = make_repo_with_pushed_branch("agent/b-1")
        add_branch(repo, "agent/b-2")
        for b in ("agent/b-1", "agent/b-2"):
            mark(repo, b)
        res = self._post(repo, [self._item(repo, "agent/b-1"), self._item(repo, "agent/b-2")])
        body = res.get_json()
        self.assertEqual(res.status_code, 200, body)
        self.assertEqual((body["discarded"], body["failed"], body["succeeded"]), (2, 0, True))
        self.assertFalse(on_origin(repo, "agent/b-1"))
        self.assertFalse(on_origin(repo, "agent/b-2"))
        self.assertEqual(self.acquire.call_count, 1, "one lock for the whole batch")
        self.assertEqual(self.release.call_count, 1)

    def test_each_deletion_writes_the_same_ledger_row_and_snapshot_as_the_single_route(self):
        repo = make_repo_with_pushed_branch("agent/led-1")
        mark(repo, "agent/led-1")
        sha = head_of(repo, "agent/led-1")
        body = self._post(repo, [self._item(repo, "agent/led-1")]).get_json()
        self.assertTrue(body["results"][0]["succeeded"])
        self.assertTrue(body["results"][0]["snapshotRef"])
        rows = [__import__("json").loads(l) for l in (repo / "queue" / "branch-removals.jsonl").read_text().splitlines()]
        self.assertEqual((rows[-1]["branch"], rows[-1]["cause"], rows[-1]["actor"], rows[-1]["headSha"]), ("agent/led-1", "discarded", "dashboard-discard", sha))
        self.assertEqual(rows[-1]["reason"], "test reason")

    def test_a_non_discard_verdict_is_refused_and_its_branch_survives(self):
        repo = make_repo_with_pushed_branch("agent/keep-1")
        add_branch(repo, "agent/gone-1")
        mark(repo, "agent/keep-1", verdict="merge")
        mark(repo, "agent/gone-1")
        body = self._post(repo, [self._item(repo, "agent/keep-1"), self._item(repo, "agent/gone-1")]).get_json()
        by = {r["branch"]: r for r in body["results"]}
        self.assertFalse(by["agent/keep-1"]["succeeded"])
        self.assertIn("not discard", by["agent/keep-1"]["reason"])
        self.assertTrue(by["agent/gone-1"]["succeeded"])
        self.assertTrue(on_origin(repo, "agent/keep-1"))
        self.assertFalse(on_origin(repo, "agent/gone-1"))

    def test_a_stale_verdict_for_an_older_commit_is_refused(self):
        repo = make_repo_with_pushed_branch("agent/stale-1")
        old = head_of(repo, "agent/stale-1")
        mark(repo, "agent/stale-1", sha=old)
        _git(["checkout", "-q", "agent/stale-1"], cwd=repo)
        (repo / "more.txt").write_text("new commit after the verdict")
        _git(["add", "-A"], cwd=repo)
        _git(["commit", "-q", "-m", "moved"], cwd=repo)
        _git(["push", "-q", "origin", "agent/stale-1"], cwd=repo)
        _git(["checkout", "-q", "main"], cwd=repo)
        body = self._post(repo, [self._item(repo, "agent/stale-1")]).get_json()
        self.assertFalse(body["results"][0]["succeeded"])
        self.assertIn("not discard", body["results"][0]["reason"])
        self.assertTrue(on_origin(repo, "agent/stale-1"))

    def test_a_head_that_moved_since_the_list_was_shown_is_refused(self):
        repo = make_repo_with_pushed_branch("agent/moved-1")
        mark(repo, "agent/moved-1")
        item = self._item(repo, "agent/moved-1", sha="0" * 40)
        body = self._post(repo, [item]).get_json()
        self.assertFalse(body["results"][0]["succeeded"])
        self.assertIn("head moved", body["results"][0]["reason"])
        self.assertTrue(on_origin(repo, "agent/moved-1"))

    def test_a_missing_sha_is_refused(self):
        repo = make_repo_with_pushed_branch("agent/nosha-1")
        mark(repo, "agent/nosha-1")
        body = self._post(repo, [{"branch": "agent/nosha-1", "project": ""}]).get_json()
        self.assertFalse(body["results"][0]["succeeded"])
        self.assertIn("no head sha", body["results"][0]["reason"])
        self.assertTrue(on_origin(repo, "agent/nosha-1"))

    def test_a_busy_apply_lock_answers_409_for_the_whole_batch_and_deletes_nothing(self):
        repo = make_repo_with_pushed_branch("agent/busy-1")
        mark(repo, "agent/busy-1")
        self.acquire.side_effect = RuntimeError("held")
        res = self._post(repo, [self._item(repo, "agent/busy-1")])
        self.assertEqual(res.status_code, 409)
        self.assertTrue(on_origin(repo, "agent/busy-1"))
        self.assertEqual(self.release.call_count, 0, "no lock was taken, so none is released")

    def test_one_failing_item_does_not_stop_the_rest_and_the_lock_is_still_released(self):
        repo = make_repo_with_pushed_branch("agent/fail-1")
        add_branch(repo, "agent/ok-1")
        for b in ("agent/fail-1", "agent/ok-1"):
            mark(repo, b)
        real = branch_discard.discard_branch

        def flaky(branch, *a, **kw):
            if branch == "agent/fail-1":
                raise RuntimeError("push rejected")
            return real(branch, *a, **kw)

        with mock.patch.object(branch_discard, "discard_branch", side_effect=flaky):
            body = self._post(repo, [self._item(repo, "agent/fail-1"), self._item(repo, "agent/ok-1")]).get_json()
        by = {r["branch"]: r for r in body["results"]}
        self.assertEqual((body["discarded"], body["failed"], body["succeeded"]), (1, 1, False))
        self.assertEqual(by["agent/fail-1"]["reason"], "push rejected")
        self.assertTrue(by["agent/ok-1"]["succeeded"])
        self.assertFalse(on_origin(repo, "agent/ok-1"))
        self.assertEqual(self.release.call_count, 1)

    def test_triage_queue_is_excluded_by_default_and_included_when_asked(self):
        repo = make_repo_with_pushed_branch("agent/triage-queue")
        mark(repo, "agent/triage-queue")
        body = self._post(repo, [self._item(repo, "agent/triage-queue")]).get_json()
        self.assertFalse(body["results"][0]["succeeded"])
        self.assertIn("excluded", body["results"][0]["reason"])
        self.assertTrue(on_origin(repo, "agent/triage-queue"))
        body = self._post(repo, [self._item(repo, "agent/triage-queue")], includeTriage=True).get_json()
        self.assertTrue(body["results"][0]["succeeded"])
        self.assertFalse(on_origin(repo, "agent/triage-queue"))

    def test_an_item_for_another_project_is_discarded_in_that_project_only(self):
        active = make_repo_with_pushed_branch("agent/act-1")
        other = make_repo_with_pushed_branch("agent/oth-1")
        mark(active, "agent/act-1")
        mark(other, "agent/oth-1")
        scope = {"label": "other", "repoRoot": str(other), "pipelineDir": str(other), "repoPath": other, "qdir": other / "queue"}

        def fake_scope(project_root, active_root):
            return scope if project_root == str(other) else None

        with mock.patch("branch_projects.resolve_scope", side_effect=fake_scope), mock.patch("branch_projects.after_action"):
            body = self._post(active, [{"branch": "agent/oth-1", "project": str(other), "sha": head_of(other, "agent/oth-1")}]).get_json()
        self.assertTrue(body["results"][0]["succeeded"], body)
        self.assertFalse(on_origin(other, "agent/oth-1"))
        self.assertTrue(on_origin(active, "agent/act-1"), "the active project's branch is untouched")
        self.assertTrue((other / "queue" / "branch-removals.jsonl").exists(), "the ledger row went to the other project's queue")

    def test_an_unknown_project_is_refused_per_item(self):
        repo = make_repo_with_pushed_branch("agent/unk-1")
        mark(repo, "agent/unk-1")
        body = self._post(repo, [{"branch": "agent/unk-1", "project": "/nowhere", "sha": head_of(repo, "agent/unk-1")}]).get_json()
        self.assertFalse(body["results"][0]["succeeded"])
        self.assertIn("not a registered project", body["results"][0]["reason"])
        self.assertTrue(on_origin(repo, "agent/unk-1"))

    def test_a_branch_that_is_not_listed_is_refused(self):
        repo = make_repo_with_pushed_branch("agent/real-1")
        body = self._post(repo, [{"branch": "agent/never-pushed", "project": "", "sha": "a" * 40}]).get_json()
        self.assertFalse(body["results"][0]["succeeded"])
        self.assertIn("not a currently-listed", body["results"][0]["reason"])

    def test_bad_bodies_are_400_and_take_no_lock(self):
        repo = make_repo_with_pushed_branch("agent/bad-1")
        for items in ([], None, [{"branch": "master"}], ["agent/x"], [{"branch": "agent/x"}] * (branch_discard.MAX_BATCH + 1)):
            self.assertEqual(self._post(repo, items).status_code, 400, items if items is None or len(items) < 5 else "too many")
        self.assertEqual(self.acquire.call_count, 0)


class TestRefusal(unittest.TestCase):
    def test_pure_gates(self):
        row = {"headSha": "abc", "verdict": "discard", "stale": False}
        self.assertIsNone(branch_discard.refusal(row, "abc", False, "agent/x"))
        self.assertIn("excluded", branch_discard.refusal(row, "abc", False, "agent/triage-queue"))
        self.assertIsNone(branch_discard.refusal(row, "abc", True, "agent/triage-queue"))
        self.assertIn("no head sha", branch_discard.refusal(row, "", False, "agent/x"))
        self.assertIn("head moved", branch_discard.refusal(row, "def", False, "agent/x"))
        self.assertIn("not discard", branch_discard.refusal({**row, "stale": True}, "abc", False, "agent/x"))
        self.assertIn("not discard", branch_discard.refusal({**row, "verdict": "hold"}, "abc", False, "agent/x"))
        self.assertIn("not discard", branch_discard.refusal({**row, "verdict": None}, "abc", False, "agent/x"))


if __name__ == "__main__":
    unittest.main()
