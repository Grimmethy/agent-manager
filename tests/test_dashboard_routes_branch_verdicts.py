"""Tests for the batch verdict endpoint atomicity contract.

Validates:
- A batch with one unlisted branch rejects the entire batch (404) with no side effects
- A batch with all valid branches succeeds (200) and records verdicts for all

Run: python -m unittest tests.test_dashboard_routes_branch_verdicts -v
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "python" / "dashboard"))

import app
import branch_verdicts as bv
from unittest import mock


class TestBatchEndpointAtomicity(unittest.TestCase):
    """Tests for POST /api/git/branches/batch atomicity contract."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)
        self.client = app.app.test_client()
        # Two valid branches that exist in the list
        branches = [
            {"branch": "agent/valid1", "taskId": "t1", "headSha": "sha-1", "hub": None},
            {"branch": "agent/valid2", "taskId": "t2", "headSha": "sha-2", "hub": None},
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

    def test_batch_atomicity_conflict_rejects_entire_batch(self):
        """A batch with one unlisted branch must reject the whole batch with no side effects."""
        # Request includes one valid branch and one unlisted branch
        r = self.post({
            "branches": ["agent/valid1", "agent/nonexistent"],
            "verdict": "merge",
            "reasons": ["reviewed"],
            "source": "manual"
        })
        # Should return 404 with unlisted branch error
        self.assertEqual(r.status_code, 404)
        body = r.get_json()
        self.assertFalse(body["succeeded"])
        self.assertIn("unlisted", body["reason"])
        # CRITICAL: No verdicts should be recorded for ANY branch in the batch
        verdicts = bv.load_verdicts(self.q)
        self.assertEqual(verdicts, {}, f"Expected no verdicts, got: {verdicts}")

    def test_batch_with_all_valid_branches_succeeds(self):
        """A batch with all valid branches must succeed and record verdicts for all."""
        r = self.post({
            "branches": ["agent/valid1", "agent/valid2"],
            "verdict": "merge",
            "reasons": ["reviewed"],
            "source": "manual"
        })
        # Should return 200 with success
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertTrue(body["succeeded"], f"Expected succeeded=True, got: {body}")
        self.assertEqual(len(body["results"]), 2)
        # Both branches should have verdicts recorded
        for result in body["results"]:
            self.assertTrue(result["succeeded"], f"Branch {result['branch']} failed: {result.get('reason')}")
            v = bv.get_verdict(self.q, result["branch"], result["headSha"])
            self.assertEqual(v["verdict"], "merge")
