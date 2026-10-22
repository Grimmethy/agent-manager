"""Merge, Discard and verdict on a card of ANOTHER registered project (the Unmerged Branches tab's all-projects view).

Everything runs against sandbox git repos (a bare 'origin' per project plus a clone registered as that project); no real project, remote, queue or lock
is touched. The apply lock and the dashboard's live-checkout sync are patched so a test never blocks on, or restarts, the real thing.

Run: .venv/bin/python -m unittest python.dashboard.test_branch_cross_project_actions -v   (from the repo root)
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import branch_projects  # noqa: E402


def git(args, cwd):
    return subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True).stdout


def make_project(root, name, branch=None, task_id=None):
    """A bare origin + a clone on `main`; optionally a pushed `agent/<branch>` ahead of main and a done/<task_id>.json record in the project's pipeline queue."""
    bare, repo, pipe = root / f"{name}.git", root / name, root / f"{name}-pipe"
    git(["init", "--bare", "-b", "main", str(bare)], root)
    git(["clone", str(bare), str(repo)], root)
    git(["config", "user.email", "t@example.com"], repo)
    git(["config", "user.name", "T"], repo)
    (repo / "README.md").write_text("hello")
    git(["add", "README.md"], repo)
    git(["commit", "-q", "-m", "initial"], repo)
    git(["push", "origin", "main"], repo)
    if branch:
        git(["checkout", "-q", "-b", f"agent/{branch}"], repo)
        (repo / f"{branch}.txt").write_text("a real change")
        git(["add", f"{branch}.txt"], repo)
        git(["commit", "-q", "-m", f"feature {branch}"], repo)
        git(["push", "origin", f"agent/{branch}"], repo)
        git(["checkout", "-q", "main"], repo)
    (pipe / "queue" / "done" / "_archived_no_action").mkdir(parents=True)
    if task_id:
        (pipe / "queue" / "done" / f"{task_id}.json").write_text(json.dumps({"id": task_id, "title": "t", "history": []}))
    return {"bare": bare, "repo": repo, "pipe": pipe}


def remote_heads(project):
    return git(["ls-remote", "--heads", str(project["bare"])], project["bare"].parent)


class CrossProjectActions(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.active = make_project(self.root, "active", branch="act-1", task_id="act-1")
        self.other = make_project(self.root, "other", branch="oth-1", task_id="oth-1")
        self.registry = [
            {"repoRoot": str(self.active["repo"]), "pipelineDir": str(self.active["pipe"]), "label": "active"},
            {"repoRoot": str(self.other["repo"]), "pipelineDir": str(self.other["pipe"]), "label": "other"},
        ]
        self.synced = mock.Mock(return_value={"synced": True})
        patches = [
            mock.patch.object(app, "read_project_registry", lambda: list(self.registry)),
            mock.patch.object(app, "get_active_repo_root", return_value=str(self.active["repo"])),
            mock.patch.object(app, "get_pipeline_dir", return_value=self.active["pipe"]),
            mock.patch.object(app, "queue_dir", return_value=self.active["pipe"] / "queue"),
            mock.patch.object(app, "list_unmerged_branches", lambda force=False: app._list_unmerged_branches_uncached(
                force_fetch=True, repo_root=str(self.active["repo"]), pipeline_dir=self.active["pipe"])),
            mock.patch.object(app, "_acquire_apply_lock", return_value=0),
            mock.patch.object(app, "_release_apply_lock", lambda fd: None),
            mock.patch.object(app, "_sync_live_checkout", self.synced),
            mock.patch.object(app, "PACKAGE_ROOT", self.active["repo"]),  # the dashboard's own repo is the ACTIVE project's clone here
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        with branch_projects._lock:
            self._saved = dict(branch_projects._state)
            branch_projects._state.update({"cache": {}, "thread": None})
        self.addCleanup(self._restore)
        self.client = app.app.test_client()
        self.other_root = os.path.realpath(self.other["repo"])

    def _restore(self):
        with branch_projects._lock:
            branch_projects._state.clear()
            branch_projects._state.update(self._saved)

    def post(self, branch, action, project=None, body=None):
        url = f"/api/git/branches/{branch.replace('/', '%2F')}/{action}" + (f"?project={self.other_root}" if project is True else (f"?project={project}" if project else ""))
        return self.client.post(url, json=body or {})

    # ---- discard ----
    def test_discard_deletes_the_other_projects_remote_branch_and_archives_its_task_only(self):
        res = self.post("agent/oth-1", "discard", project=True)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.assertTrue(res.get_json()["succeeded"])
        self.assertNotIn("agent/oth-1", remote_heads(self.other))
        self.assertIn("agent/act-1", remote_heads(self.active), "the active project's branch is untouched")
        self.assertFalse((self.other["pipe"] / "queue" / "done" / "oth-1.json").exists())
        archived = json.loads((self.other["pipe"] / "queue" / "done" / "_archived_no_action" / "oth-1.json").read_text())
        self.assertEqual(archived["terminalDisposition"], "dismissed")
        self.assertTrue((self.active["pipe"] / "queue" / "done" / "act-1.json").exists(), "the active project's task record is untouched")
        self.assertEqual(list((self.active["pipe"] / "queue" / "done" / "_archived_no_action").iterdir()), [])
        cached = branch_projects._state["cache"].get(self.other_root)
        self.assertIsNotNone(cached)
        self.assertFalse(any(b["branch"] == "agent/oth-1" for b in cached["branches"]), "the other project's cache was refreshed")

    def test_an_unknown_project_is_a_404_and_acts_on_nothing_not_even_the_active_project(self):
        res = self.post("agent/act-1", "discard", project="/no/such/project")
        self.assertEqual(res.status_code, 404)
        self.assertIn("agent/act-1", remote_heads(self.active), "no fallback to the active project")
        res = self.post("agent/act-1", "merge", project="/no/such/project")
        self.assertEqual(res.status_code, 404)
        self.assertIn("agent/act-1", remote_heads(self.active))

    def test_a_branch_that_is_not_in_that_projects_list_is_a_404(self):
        res = self.post("agent/act-1", "discard", project=True)  # act-1 belongs to the ACTIVE project, not 'other'
        self.assertEqual(res.status_code, 404)
        self.assertIn("agent/act-1", remote_heads(self.active))
        self.assertIn("agent/oth-1", remote_heads(self.other))

    def test_naming_the_active_project_is_the_old_path(self):
        res = self.post("agent/act-1", "discard", project=os.path.realpath(self.active["repo"]))
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.assertNotIn("agent/act-1", remote_heads(self.active))
        self.assertTrue((self.active["pipe"] / "queue" / "done" / "_archived_no_action" / "act-1.json").exists())

    # ---- merge ----
    def test_merge_lands_on_the_other_projects_main_without_touching_its_checkout(self):
        repo = self.other["repo"]
        (repo / "dirty.txt").write_text("uncommitted work")                        # an uncommitted file in the clone
        (repo / "README.md").write_text("local edit not committed")
        (repo / "local.txt").write_text("local commit")
        git(["add", "local.txt"], repo)
        git(["commit", "-q", "-m", "local only commit"], repo)                      # a local commit that was never pushed
        head_before = git(["rev-parse", "HEAD"], repo).strip()
        res = self.post("agent/oth-1", "merge", project=True)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertTrue(body["succeeded"])
        self.assertEqual(body["liveSync"], {"skipped": "not the dashboard's own repo"})
        self.synced.assert_not_called()
        self.assertEqual(git(["rev-parse", "HEAD"], repo).strip(), head_before, "the clone's HEAD did not move")
        self.assertEqual((repo / "dirty.txt").read_text(), "uncommitted work")
        self.assertEqual((repo / "README.md").read_text(), "local edit not committed", "no reset --hard ran in the working tree")
        self.assertEqual(git(["status", "--porcelain", "dirty.txt"], repo).strip(), "?? dirty.txt")
        check = self.root / "check"
        git(["clone", "-q", str(self.other["bare"]), str(check)], self.root)
        self.assertTrue((check / "oth-1.txt").exists(), "the feature landed on the other project's remote main")
        self.assertIn("(via dashboard)", git(["log", "-1", "--format=%s"], check))
        self.assertNotIn("agent/oth-1", remote_heads(self.other), "the merged branch was removed")
        merged = json.loads((self.other["pipe"] / "queue" / "done" / "oth-1.json").read_text())
        self.assertEqual(merged["terminalDisposition"], "merged")
        self.assertIsNotNone(merged.get("mergedAt"))
        self.assertNotIn("mergedAt", json.loads((self.active["pipe"] / "queue" / "done" / "act-1.json").read_text()), "the active project's record is untouched")
        self.assertEqual(git(["worktree", "list"], repo).count("\n"), 1, "the temp worktree was removed")

    def test_merging_the_dashboards_own_repo_from_another_projects_view_syncs_the_live_checkout(self):
        with mock.patch.object(app, "PACKAGE_ROOT", self.other["repo"]):
            res = self.post("agent/oth-1", "merge", project=True)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.synced.assert_called_once_with("main")

    def test_merge_without_a_project_still_takes_the_old_checkout_path(self):
        res = self.post("agent/act-1", "merge")
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.synced.assert_called_once_with("main")
        self.assertTrue((self.active["repo"] / "act-1.txt").exists(), "the old path merged inside the active clone's own checkout")
        self.assertIn("agent/oth-1", remote_heads(self.other), "the other project is untouched")

    def test_a_merge_conflict_in_the_other_project_leaves_its_checkout_and_remote_alone(self):
        repo = self.other["repo"]
        clash = self.root / "clash"
        git(["clone", "-q", str(self.other["bare"]), str(clash)], self.root)
        git(["config", "user.email", "t@example.com"], clash)
        git(["config", "user.name", "T"], clash)
        git(["checkout", "-q", "-b", "agent/clash-1"], clash)
        (clash / "same.txt").write_text("branch side")
        git(["add", "same.txt"], clash); git(["commit", "-q", "-m", "branch side"], clash); git(["push", "-q", "origin", "agent/clash-1"], clash)
        git(["checkout", "-q", "main"], clash)
        (clash / "same.txt").write_text("main side")
        git(["add", "same.txt"], clash); git(["commit", "-q", "-m", "main side"], clash); git(["push", "-q", "origin", "main"], clash)
        main_before = git(["rev-parse", "main"], clash).strip()
        res = self.post("agent/clash-1", "merge", project=True)
        self.assertEqual(res.status_code, 500)
        self.assertFalse(res.get_json()["succeeded"])
        self.assertEqual(git(["ls-remote", str(self.other["bare"]), "refs/heads/main"], self.root).split()[0], main_before, "remote main did not move")
        self.assertIn("agent/clash-1", remote_heads(self.other))
        self.assertEqual(git(["status", "--porcelain"], repo).strip(), "")
        self.assertEqual(git(["worktree", "list"], repo).count("\n"), 1)

    # ---- verdict ----
    def test_a_verdict_is_recorded_in_the_given_projects_queue(self):
        branch_projects.refresh_branches(branch_projects.resolve_scope(self.other_root, str(self.active["repo"])))
        sha = git(["rev-parse", "agent/oth-1"], self.other["repo"]).strip()
        body = {"verdict": "merge", "reasons": ["sandbox check"], "source": "chat", "sha": sha}
        res = self.post("agent/oth-1", "verdict", project=True, body=body)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.assertEqual(res.get_json()["verdict"], "merge")
        store = json.loads((self.other["pipe"] / "queue" / "branch-verdicts.json").read_text())
        self.assertIn("agent/oth-1", json.dumps(store))
        self.assertFalse((self.active["pipe"] / "queue" / "branch-verdicts.json").exists() and "oth-1" in (self.active["pipe"] / "queue" / "branch-verdicts.json").read_text())
        cached = branch_projects._state["cache"][self.other_root]["branches"]
        self.assertEqual(next(b for b in cached if b["branch"] == "agent/oth-1").get("verdict"), "merge", "the card carries the verdict")

    def test_a_verdict_for_an_unknown_project_or_unlisted_branch_is_a_404(self):
        body = {"verdict": "merge", "reasons": ["x"], "source": "chat"}
        self.assertEqual(self.post("agent/oth-1", "verdict", project="/no/such/project", body=body).status_code, 404)
        self.assertEqual(self.post("agent/never-existed", "verdict", project=True, body=body).status_code, 404)


if __name__ == "__main__":
    unittest.main()
