"""The Unmerged Branches list hides a branch whose content already landed on main by SQUASH merge (2026-09-21).

A squash merge leaves the branch's own commits "ahead" of main by ancestry, so the tab kept offering an already-landed branch (the rolling
agent/triage-queue branch after its PRs were squash-merged). The lister now compares CONTENT: a branch is hidden only when every file it changed is
byte-identical on origin/<main>. Real bare origin + clone, same fixture shape as test_git_discard_branch.py.

Run: .venv/bin/python -m unittest python.dashboard.test_unmerged_squash_merged -v
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


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def make_repo():
    root = Path(tempfile.mkdtemp())
    bare, repo = root / "origin.git", root / "repo"
    _git(["init", "--bare", "-b", "main", str(bare)], cwd=root)
    _git(["clone", str(bare), str(repo)], cwd=root)
    _git(["config", "user.email", "t@example.com"], cwd=repo)
    _git(["config", "user.name", "T"], cwd=repo)
    (repo / "README.md").write_text("base\n")
    _git(["add", "-A"], cwd=repo)
    _git(["commit", "-q", "-m", "initial"], cwd=repo)
    _git(["push", "-q", "origin", "main"], cwd=repo)
    return repo


def branch_with(repo, name, files):
    _git(["checkout", "-q", "-b", name], cwd=repo)
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    _git(["add", "-A"], cwd=repo)
    _git(["commit", "-q", "-m", f"work on {name}"], cwd=repo)
    _git(["push", "-q", "origin", name], cwd=repo)
    _git(["checkout", "-q", "main"], cwd=repo)


def land_on_main(repo, files):
    """A separate commit on main carrying the same content -- what a squash merge produces (new sha, same tree change)."""
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    _git(["add", "-A"], cwd=repo)
    _git(["commit", "-q", "-m", "squash of the branch (#1)"], cwd=repo)
    _git(["push", "-q", "origin", "main"], cwd=repo)


class TestHideSquashMerged(unittest.TestCase):
    def setUp(self):
        app._invalidate_branch_cache()

    def tearDown(self):
        app._invalidate_branch_cache()

    def listed(self, repo):
        patches = [mock.patch.object(app, "get_active_repo_root", return_value=str(repo)),
                   mock.patch.object(app, "get_pipeline_dir", return_value=repo)]
        for p in patches:
            p.start()
        try:
            return {b["branch"] for b in app.list_unmerged_branches(force=True)}
        finally:
            for p in patches:
                p.stop()

    def test_a_squash_merged_branch_is_hidden(self):
        repo = make_repo()
        branch_with(repo, "agent/sq-1", {"Docs/x.md": "candidate\n"})
        self.assertIn("agent/sq-1", self.listed(repo), "premise: unmerged before the squash lands")
        land_on_main(repo, {"Docs/x.md": "candidate\n"})
        self.assertNotIn("agent/sq-1", self.listed(repo))

    def test_a_genuinely_unmerged_branch_stays_listed(self):
        repo = make_repo()
        branch_with(repo, "agent/real-1", {"src/feature.js": "new\n"})
        self.assertIn("agent/real-1", self.listed(repo))

    def test_a_branch_with_one_file_still_missing_from_main_stays_listed(self):
        repo = make_repo()
        branch_with(repo, "agent/partial-1", {"a.txt": "A\n", "b.txt": "B\n"})
        land_on_main(repo, {"a.txt": "A\n"})
        self.assertIn("agent/partial-1", self.listed(repo))

    def test_a_file_main_has_since_changed_differently_stays_listed(self):
        repo = make_repo()
        branch_with(repo, "agent/diverged-1", {"a.txt": "branch version\n"})
        land_on_main(repo, {"a.txt": "a different version on main\n"})
        self.assertIn("agent/diverged-1", self.listed(repo))

    def test_kill_switch_restores_the_ancestry_only_behaviour(self):
        repo = make_repo()
        branch_with(repo, "agent/sq-2", {"Docs/y.md": "c\n"})
        land_on_main(repo, {"Docs/y.md": "c\n"})
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_LIST_HIDE_SQUASHED": "false"}):
            self.assertIn("agent/sq-2", self.listed(repo))

    def test_a_git_failure_keeps_the_branch_listed(self):
        repo = make_repo()
        branch_with(repo, "agent/sq-3", {"Docs/z.md": "c\n"})
        land_on_main(repo, {"Docs/z.md": "c\n"})
        with mock.patch.object(app, "_run_git", side_effect=RuntimeError("boom")):
            self.assertTrue(app._branch_content_already_on_main(repo, "main", "origin/agent/sq-3") is False)


if __name__ == "__main__":
    unittest.main()
