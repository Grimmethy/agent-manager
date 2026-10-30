"""Tests for the batch verdict endpoint and _apply_verdicts_batch transactional wrapper.

Validates:
- _apply_verdicts_batch rejects on conflict (no side effects)
- _apply_verdicts_batch applies atomically when all branches pass
- The batch route coexists with the single-branch route without path conflicts
- Input validation (empty branches, invalid verdict, etc.)

Run: python -m unittest python.dashboard.test_branch_verdicts_batch -v   (from the repo root)
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
import branch_verdicts as bv  # noqa: E402


def git(args, cwd):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=str(cwd), check=True,
                          capture_output=True, text=True).stdout


def run_git(args, cwd):
    """Same contract as app.py's _run_git: raises RuntimeError with the output on a nonzero exit."""
    proc = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {(proc.stderr or proc.stdout).strip()}")
    return proc.stdout


class BatchWrapperFixture:
    """A minimal fixture for testing _apply_verdicts_batch: a bare origin + clone with two branches."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.origin, self.work, self.queue = root / "origin.git", root / "work", root / "queue"
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

    def make_branch(self, name, modify=None):
        git(["checkout", "-B", name, "master"], self.work)
        if modify:
            self.write(modify["file"], modify["content"])
            self.commit(modify.get("msg", "edit"))
        git(["push", "-f", "origin", name], self.work)
        git(["checkout", "master"], self.work)

    def cleanup(self):
        self.tmp.cleanup()


class TestApplyVerdictsBatch(unittest.TestCase):
    """Tests for the transactional wrapper _apply_verdicts_batch."""

    def setUp(self):
        self.fx = BatchWrapperFixture()
        self.addCleanup(self.fx.cleanup)

    def test_valid_batch_applies_to_all_branches(self):
        self.fx.make_branch("agent/one")
        self.fx.make_branch("agent/two")
        results, error = bv._apply_verdicts_batch(
            self.fx.queue, self.fx.work, "master",
            ["agent/one", "agent/two"],
            run_git, "merge", ["reviewed"], "manual"
        )
        self.assertIsNone(error)
        self.assertEqual(len(results), 2)
        self.assertTrue(all(r["succeeded"] for r in results))
        # Both branches should have the verdict recorded
        for r in results:
            v = bv.get_verdict(self.fx.queue, r["branch"], r["headSha"])
            self.assertEqual(v["verdict"], "merge")

    def test_conflict_rejects_entire_batch_with_no_side_effects(self):
        """A conflicting branch should reject the whole batch without recording anything."""
        self.fx.make_branch("agent/clean")
        self.fx.make_branch("agent/conflict", modify={"file": "shared.txt", "content": "line1\nBRANCH\nline3\n"})
        # Make master also modify the same file to create a conflict
        git(["checkout", "-B", "master"], self.fx.work)
        self.fx.write("shared.txt", "line1\nMASTER\nline3\n")
        self.fx.commit("master edit")
        git(["push", "origin", "master"], self.fx.work)

        results, error = bv._apply_verdicts_batch(
            self.fx.queue, self.fx.work, "master",
            ["agent/clean", "agent/conflict"],
            run_git, "merge", ["reviewed"], "manual"
        )
        self.assertIsNotNone(error)
        self.assertEqual(len(results), 0)
        # No verdicts should be recorded
        self.assertEqual(bv.load_verdicts(self.fx.queue), {})

    def test_invalid_verdict_rejects_batch(self):
        """An invalid verdict should reject without side effects."""
        self.fx.make_branch("agent/one")
        results, error = bv._apply_verdicts_batch(
            self.fx.queue, self.fx.work, "master",
            ["agent/one"],
            run_git, "invalid-verdict", [], "manual"
        )
        self.assertIsNotNone(error)
        self.assertEqual(len(results), 0)

    def test_empty_branches_list_rejected(self):
        """An empty branches list should be rejected."""
        self.fx.make_branch("agent/one")
        results, error = bv._apply_verdicts_batch(
            self.fx.queue, self.fx.work, "master",
            [],
            run_git, "merge", ["reviewed"], "manual"
        )
        self.assertIsNotNone(error)
        self.assertEqual(len(results), 0)

    def test_non_string_branch_rejected(self):
        """Non-string branch names should be rejected."""
        self.fx.make_branch("agent/one")
        results, error = bv._apply_verdicts_batch(
            self.fx.queue, self.fx.work, "master",
            ["agent/one", 123],
            run_git, "merge", ["reviewed"], "manual"
        )
        self.assertIsNotNone(error)
        self.assertEqual(len(results), 0)


class TestBatchEndpoint(unittest.TestCase):
    """Tests for POST /api/git/branches/batch through the real Flask app."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)
        self.client = app.app.test_client()
        branches = [
            {"branch": "agent/one", "taskId": "t1", "headSha": "sha-1", "hub": None},
            {"branch": "agent/two", "taskId": "t2", "headSha": "sha-2", "hub": None},
        ]
        patches = [
            mock.patch.object(app, "get_active_repo_root", return_value="/repo"),
            mock.patch.object(app, "queue_dir", return_value=self.q),
            mock.patch.object(app, "list_unmerged_branches", return_value=branches),
            mock.patch.object(app, "_invalidate_branch_cache"),
            mock.patch.object(app, "_run_git", return_value="sha-1\n"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def post(self, body):
        return self.client.post("/api/git/branches/batch", json=body)

    def test_batch_applies_to_all_branches(self):
        r = self.post({
            "branches": ["agent/one", "agent/two"],
            "verdict": "merge",
            "reasons": ["reviewed"],
            "source": "manual"
        })
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertTrue(body["succeeded"])
        self.assertEqual(len(body["results"]), 2)
        self.assertTrue(all(r["succeeded"] for r in body["results"]))

    def test_batch_rejects_with_conflict(self):
        """A conflicting branch should reject the whole batch."""
        # Mock _check_conflicts to return a conflict for one branch
        with mock.patch("branch_verdicts._check_conflicts",
                        return_value=("needs-work", ["conflicts with master on: shared.txt"])):
            r = self.post({
                "branches": ["agent/one", "agent/two"],
                "verdict": "merge",
                "reasons": ["reviewed"],
                "source": "manual"
            })
        self.assertEqual(r.status_code, 409)
        body = r.get_json()
        self.assertFalse(body["succeeded"])
        self.assertIn("conflict", body["reason"].lower())

    def test_batch_validates_input(self):
        """Invalid input should return 400."""
        r = self.post({"branches": [], "verdict": "merge", "reasons": [], "source": "manual"})
        self.assertEqual(r.status_code, 400)
        r = self.post({"branches": ["agent/one"], "verdict": "invalid", "reasons": [], "source": "manual"})
        self.assertEqual(r.status_code, 400)
        r = self.post({"branches": ["agent/one"], "verdict": "merge", "reasons": "not-a-list", "source": "manual"})
        self.assertEqual(r.status_code, 400)

    def test_batch_coexists_with_single_branch_route(self):
        """The batch route should not interfere with the single-branch route."""
        # Test the single-branch route still works
        r = self.client.post("/api/git/branches/agent/one/verdict", json={
            "verdict": "merge", "reasons": ["reviewed"], "source": "manual"
        })
        self.assertEqual(r.status_code, 200)
        # Test the batch route works
        r = self.post({"branches": ["agent/one", "agent/two"], "verdict": "merge", "reasons": [], "source": "manual"})
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main()
