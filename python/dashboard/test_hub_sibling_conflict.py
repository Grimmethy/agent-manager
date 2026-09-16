"""Tests for hub-sibling conflict detection (2026-09-16) -- see _check_sibling_conflict's
and _annotate_hub_sibling_conflicts's own docstrings in app.py for the real incident this
closes: a coordinator hub decomposed one feature into 4 sub-tasks that all edited the
same file (src/local-tool-client.js), but the model never declared `after` links between
them, so each was independently branched straight off the same main commit. Every
branch's own `willConflict` (checked only against main) correctly said False -- the real
collision between SIBLINGS was invisible until they were merged one at a time and the 2nd
hit a real conflict. This adds a second, sibling-aware check surfaced as
`hubSiblingConflicts` on each branch, and a merge-endpoint gate that blocks (unless
forced) merging a branch whose still-unmerged hub sibling it would conflict with.

Uses the same real bare-origin + clone fixture as test_git_discard_branch.py /
test_git_merge_closes_task_log.py, since list_unmerged_branches/merge both do real
subprocess git calls, not mocked output.

Run: .venv/bin/python -m unittest python.dashboard.test_hub_sibling_conflict -v
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


def make_repo_with_conflicting_siblings():
    """Real bare 'origin' + a clone with TWO sibling branches, both branched directly off
    the same main commit, both editing OVERLAPPING lines of the same file -- the exact
    shape that produces a real conflict when merged one at a time, but shows
    willConflict:False for each individually (neither conflicts with main alone)."""
    root = Path(tempfile.mkdtemp())
    bare = root / "origin.git"
    repo = root / "repo"
    _git(["init", "--bare", "-b", "main", str(bare)], cwd=root)
    _git(["clone", str(bare), str(repo)], cwd=root)
    _git(["config", "user.email", "test@example.com"], cwd=repo)
    _git(["config", "user.name", "Test"], cwd=repo)
    (repo / "shared.js").write_text("line1\nline2\nline3\nline4\nline5\n")
    _git(["add", "shared.js"], cwd=repo)
    _git(["commit", "-q", "-m", "initial"], cwd=repo)
    _git(["push", "origin", "main"], cwd=repo)

    task_a, task_b = "adhoc-edit-shared-a-1789600000000-0", "adhoc-edit-shared-b-1789600000001-1"

    _git(["checkout", "-b", f"agent/{task_a}", "main"], cwd=repo)
    (repo / "shared.js").write_text("line1\nCHANGED-BY-A\nline3\nline4\nline5\n")
    _git(["commit", "-aq", "-m", f"Edit A\n\nTask: {task_a} (adhoc/manual)"], cwd=repo)
    _git(["push", "origin", f"agent/{task_a}"], cwd=repo)

    _git(["checkout", "-b", f"agent/{task_b}", "main"], cwd=repo)
    (repo / "shared.js").write_text("line1\nCHANGED-BY-B\nline3\nline4\nline5\n")
    _git(["commit", "-aq", "-m", f"Edit B\n\nTask: {task_b} (adhoc/manual)"], cwd=repo)
    _git(["push", "origin", f"agent/{task_b}"], cwd=repo)

    _git(["checkout", "main"], cwd=repo)

    (repo / "queue" / "coordinating").mkdir(parents=True, exist_ok=True)
    (repo / "queue" / "done").mkdir(parents=True, exist_ok=True)
    hub_id = "adhoc-shared-file-hub-1789600000000"
    hub = {
        "id": hub_id,
        "title": "Edit shared.js from two sub-tasks",
        "subTasks": [
            {"id": task_a, "title": "Edit A", "status": "pending-merge"},
            {"id": task_b, "title": "Edit B", "status": "pending-merge"},
        ],
    }
    (repo / "queue" / "coordinating" / f"{hub_id}.json").write_text(json.dumps(hub, indent=2))
    for tid in (task_a, task_b):
        (repo / "queue" / "done" / f"{tid}.json").write_text(json.dumps({
            "id": tid, "title": f"Edit {tid[-1]}", "domain": "adhoc", "source": "manual",
        }, indent=2))

    return repo, bare, task_a, task_b


class TestHubSiblingConflict(unittest.TestCase):
    def setUp(self):
        app._invalidate_branch_cache()
        self._sync_patch = mock.patch.object(app, "_sync_live_checkout", return_value={"synced": False})
        self._sync_patch.start()
        self.client = app.app.test_client()

    def tearDown(self):
        app._invalidate_branch_cache()
        self._sync_patch.stop()

    def _patches(self, repo_root):
        return [
            mock.patch.object(app, "get_active_repo_root", return_value=str(repo_root)),
            mock.patch.object(app, "get_pipeline_dir", return_value=repo_root),
            mock.patch.object(app, "queue_dir", return_value=repo_root / "queue"),
        ]

    def test_both_siblings_show_willConflict_false_against_main_but_flag_each_other(self):
        repo, bare, task_a, task_b = make_repo_with_conflicting_siblings()
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.get("/api/git/unmerged-branches")
            self.assertEqual(res.status_code, 200, res.get_json())
            branches = {b["taskId"]: b for b in res.get_json()}
            self.assertIn(task_a, branches)
            self.assertIn(task_b, branches)
            # Each branch, checked alone against main, has no conflict -- exactly the
            # blind spot that let the real incident through undetected.
            self.assertFalse(branches[task_a]["willConflict"])
            self.assertFalse(branches[task_b]["willConflict"])
            # But each correctly names the OTHER as a sibling it would conflict with.
            self.assertEqual(branches[task_a]["hubSiblingConflicts"], [f"agent/{task_b}"])
            self.assertEqual(branches[task_b]["hubSiblingConflicts"], [f"agent/{task_a}"])
        finally:
            for p in patches:
                p.stop()

    def test_merge_is_blocked_when_an_unmerged_sibling_would_conflict(self):
        repo, bare, task_a, task_b = make_repo_with_conflicting_siblings()
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post(f"/api/git/branches/agent%2F{task_a}/merge")
            self.assertEqual(res.status_code, 409)
            body = res.get_json()
            self.assertFalse(body["succeeded"])
            self.assertIn(f"agent/{task_b}", body["reason"])
            self.assertIn("dependency order", body["reason"])
        finally:
            for p in patches:
                p.stop()

    def test_force_bypasses_the_sibling_conflict_gate(self):
        repo, bare, task_a, task_b = make_repo_with_conflicting_siblings()
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post(
                f"/api/git/branches/agent%2F{task_a}/merge",
                json={"force": True},
            )
            self.assertEqual(res.status_code, 200, res.get_json())
            self.assertTrue(res.get_json()["succeeded"])
        finally:
            for p in patches:
                p.stop()

    def test_after_one_sibling_merges_the_other_is_no_longer_blocked_by_it(self):
        repo, bare, task_a, task_b = make_repo_with_conflicting_siblings()
        patches = self._patches(repo)
        for p in patches:
            p.start()
        try:
            res = self.client.post(
                f"/api/git/branches/agent%2F{task_a}/merge",
                json={"force": True},
            )
            self.assertEqual(res.status_code, 200, res.get_json())

            # b's real conflict against main now surfaces on its OWN primary check (a and
            # b touch the same lines), which is a pre-existing, already-correct signal --
            # this test only asserts the SIBLING gate itself no longer fires for a branch
            # that has already left the unmerged list.
            res2 = self.client.get("/api/git/unmerged-branches")
            branches = {b["taskId"]: b for b in res2.get_json()}
            self.assertNotIn(task_a, branches, "a is merged now -- gone from the unmerged list")
            self.assertIn(task_b, branches)
            self.assertEqual(branches[task_b]["hubSiblingConflicts"], [],
                              "a is no longer unmerged, so it can no longer appear as a live sibling conflict")
        finally:
            for p in patches:
                p.stop()


if __name__ == "__main__":
    unittest.main()
