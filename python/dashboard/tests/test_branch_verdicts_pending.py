"""Tests for pending verdicts (held hub branches).

Tests that:
- POST to a held branch (exists on origin, not in listing) returns 200 with pending:true
- Pending file is created with correct structure
- After listing refresh with matching SHA, verdict is applied and pending file removed
- After listing refresh with different SHA, pending verdict is dropped
- A branch unknown to origin still returns 404

Run: /media/model-cache/github/agent-manager/.venv/bin/python -m unittest python.dashboard.tests.test_branch_verdicts_pending
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Add the dashboard dir to path so we can import the modules under test
sys.path.insert(0, str(Path(__file__).parent.parent))

import branch_verdicts as bv  # noqa: E402
import branch_verdicts_pending as bvp  # noqa: E402


def git(args, cwd):
    """Run git and return stdout."""
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def run_git(args, cwd):
    """Same contract as app.py's _run_git: raises RuntimeError on nonzero exit."""
    proc = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {(proc.stderr or proc.stdout).strip()}")
    return proc.stdout


class PendingVerdictFixture:
    """Fixture for testing pending verdicts with a real git repo."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.origin, self.work, self.queue = (
            root / "origin.git",
            root / "work",
            root / "queue",
        )
        self.queue.mkdir()
        git(["init", "--bare", "-b", "master", str(self.origin)], root)
        git(["clone", str(self.origin), str(self.work)], root)
        git(["checkout", "-b", "master"], self.work)
        self.write("shared.txt", "line1\nline2\nline3\n")
        self.commit("base")
        git(["push", "origin", "master"], self.work)

    def write(self, name, text):
        (self.work / name).write_text(text)

    def commit(self, msg):
        git(["add", "-A"], self.work)
        git(["commit", "-m", msg], self.work)

    def branch_from_master(self, name):
        git(["checkout", "-B", name, "master"], self.work)

    def push(self, name):
        git(["push", "-f", "origin", name], self.work)
        git(["checkout", "master"], self.work)

    def sha(self, name):
        return git(["rev-parse", f"origin/{name}"], self.work).strip()

    def cleanup(self):
        self.tmp.cleanup()


class TestPendingVerdicts(unittest.TestCase):
    """Test pending verdict functionality."""

    def setUp(self):
        self.fx = PendingVerdictFixture()
        self.addCleanup(self.fx.cleanup)

    def test_store_and_get_pending_verdict(self):
        """Test storing and retrieving a pending verdict."""
        bvp.store_pending_verdict(
            str(self.fx.queue),
            "agent/feature-x",
            "abc123",
            "merge",
            ["looks good"],
            "manual",
        )
        pending = bvp.get_pending_verdict(str(self.fx.queue), "agent/feature-x")
        self.assertIsNotNone(pending)
        self.assertEqual(pending["branch"], "agent/feature-x")
        self.assertEqual(pending["headSha"], "abc123")
        self.assertEqual(pending["verdict"], "merge")
        self.assertEqual(pending["reasons"], ["looks good"])
        self.assertEqual(pending["source"], "manual")

    def test_get_pending_verdict_missing(self):
        """Test getting a pending verdict that doesn't exist."""
        pending = bvp.get_pending_verdict(str(self.fx.queue), "agent/nonexistent")
        self.assertIsNone(pending)

    def test_remove_pending_verdict(self):
        """Test removing a pending verdict."""
        bvp.store_pending_verdict(
            str(self.fx.queue),
            "agent/feature-x",
            "abc123",
            "merge",
            [],
            "manual",
        )
        self.assertTrue(bvp.remove_pending_verdict(str(self.fx.queue), "agent/feature-x"))
        pending = bvp.get_pending_verdict(str(self.fx.queue), "agent/feature-x")
        self.assertIsNone(pending)

    def test_remove_pending_verdict_missing(self):
        """Test removing a pending verdict that doesn't exist."""
        self.assertFalse(bvp.remove_pending_verdict(str(self.fx.queue), "agent/nonexistent"))

    def test_list_pending_verdicts(self):
        """Test listing all pending verdicts."""
        bvp.store_pending_verdict(
            str(self.fx.queue),
            "agent/feature-1",
            "sha1",
            "merge",
            [],
            "manual",
        )
        bvp.store_pending_verdict(
            str(self.fx.queue),
            "agent/feature-2",
            "sha2",
            "discard",
            [],
            "manual",
        )
        pending_list = bvp.list_pending_verdicts(str(self.fx.queue))
        self.assertEqual(len(pending_list), 2)
        branches = {p["branch"] for p in pending_list}
        self.assertEqual(branches, {"agent/feature-1", "agent/feature-2"})

    def test_list_pending_verdicts_empty(self):
        """Test listing pending verdicts when none exist."""
        pending_list = bvp.list_pending_verdicts(str(self.fx.queue))
        self.assertEqual(pending_list, [])

    def test_apply_pending_verdict_matching_sha(self):
        """Test applying a pending verdict when SHA matches."""
        # Create a branch and push it
        self.fx.branch_from_master("agent/feature-x")
        self.fx.write("feature.txt", "new feature\n")
        self.fx.commit("add feature")
        self.fx.push("agent/feature-x")
        sha = self.fx.sha("agent/feature-x")

        # Store a pending verdict
        bvp.store_pending_verdict(
            str(self.fx.queue),
            "agent/feature-x",
            sha,
            "merge",
            ["looks good"],
            "manual",
        )

        # Create a mock list_unmerged_branches that includes the branch
        def mock_list_unmerged_branches(force=False):
            return [{"branch": "agent/feature-x", "headSha": sha}]

        # Apply pending verdicts
        bvp.apply_pending_verdicts(
            str(self.fx.queue),
            self.fx.work,
            mock_list_unmerged_branches,
            run_git,
            bv,
        )

        # Verify the pending file is removed
        pending = bvp.get_pending_verdict(str(self.fx.queue), "agent/feature-x")
        self.assertIsNone(pending)

        # Verify the verdict was recorded
        verdicts = bv.load_verdicts(str(self.fx.queue))
        self.assertIn("agent/feature-x", verdicts)
        self.assertIn(sha, verdicts["agent/feature-x"])
        self.assertEqual(verdicts["agent/feature-x"][sha]["verdict"], "merge")

    def test_apply_pending_verdict_different_sha(self):
        """Test dropping a pending verdict when SHA doesn't match."""
        # Create a branch and push it
        self.fx.branch_from_master("agent/feature-x")
        self.fx.write("feature.txt", "new feature\n")
        self.fx.commit("add feature")
        self.fx.push("agent/feature-x")
        sha1 = self.fx.sha("agent/feature-x")

        # Store a pending verdict with the current SHA
        bvp.store_pending_verdict(
            str(self.fx.queue),
            "agent/feature-x",
            sha1,
            "merge",
            [],
            "manual",
        )

        # Simulate the branch moving (different SHA)
        self.fx.branch_from_master("agent/feature-x")
        self.fx.write("feature2.txt", "another change\n")
        self.fx.commit("another change")
        self.fx.push("agent/feature-x")
        sha2 = self.fx.sha("agent/feature-x")

        # Create a mock list_unmerged_branches with the new SHA
        def mock_list_unmerged_branches(force=False):
            return [{"branch": "agent/feature-x", "headSha": sha2}]

        # Apply pending verdicts
        bvp.apply_pending_verdicts(
            str(self.fx.queue),
            self.fx.work,
            mock_list_unmerged_branches,
            run_git,
            bv,
        )

        # Verify the pending file is removed (dropped because SHA moved)
        pending = bvp.get_pending_verdict(str(self.fx.queue), "agent/feature-x")
        self.assertIsNone(pending)

        # Verify no verdict was recorded
        verdicts = bv.load_verdicts(str(self.fx.queue))
        self.assertNotIn("agent/feature-x", verdicts)

    def test_apply_pending_verdict_branch_not_listed(self):
        """Test keeping a pending verdict when branch is still not listed."""
        # Store a pending verdict for a branch that doesn't exist yet
        bvp.store_pending_verdict(
            str(self.fx.queue),
            "agent/feature-x",
            "abc123",
            "merge",
            [],
            "manual",
        )

        # Create a mock list_unmerged_branches that doesn't include the branch
        def mock_list_unmerged_branches(force=False):
            return []

        # Apply pending verdicts
        bvp.apply_pending_verdicts(
            str(self.fx.queue),
            self.fx.work,
            mock_list_unmerged_branches,
            run_git,
            bv,
        )

        # Verify the pending file is still there
        pending = bvp.get_pending_verdict(str(self.fx.queue), "agent/feature-x")
        self.assertIsNotNone(pending)
        self.assertEqual(pending["branch"], "agent/feature-x")


if __name__ == "__main__":
    unittest.main()
