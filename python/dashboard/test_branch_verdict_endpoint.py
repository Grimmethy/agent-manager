"""Tests for POST /api/git/branches/<branch>/verdict (routes/branch_verdicts.py) through the real Flask app,
with the git-backed lookups stubbed. Store/check behavior is covered in test_branch_verdicts.py.

Run: python -m unittest python.dashboard.test_branch_verdict_endpoint -v   (from the repo root)
"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import branch_verdicts as bv  # noqa: E402


class Endpoint(unittest.TestCase):
    """POST /api/git/branches/<branch>/verdict through the real Flask app, with the git-backed lookups stubbed."""

    def setUp(self):
        import app  # noqa: WPS433
        self.app = app
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)
        self.client = app.app.test_client()
        branch = {"branch": "agent/t1", "taskId": "t1", "headSha": "sha-A", "hub": None}
        patches = [
            mock.patch.object(app, "get_active_repo_root", return_value="/repo"),
            mock.patch.object(app, "queue_dir", return_value=self.q),
            mock.patch.object(app, "list_unmerged_branches", return_value=[branch]),
            mock.patch.object(app, "_invalidate_branch_cache"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def post(self, body, branch="agent/t1"):
        return self.client.post(f"/api/git/branches/{branch}/verdict", json=body)

    def test_round_trip_records_and_reads_back(self):
        r = self.post({"verdict": "merge", "reasons": ["reviewed"], "source": "manual"})
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertTrue(body["succeeded"])
        self.assertEqual((body["verdict"], body["stale"], body["headSha"]), ("merge", False, "sha-A"))
        self.assertEqual(bv.get_verdict(self.q, "agent/t1", "sha-A")["verdict"], "merge")

    def test_unknown_verdict_is_400(self):
        self.assertEqual(self.post({"verdict": "ship-it", "reasons": [], "source": "manual"}).status_code, 400)

    def test_non_object_body_is_400(self):
        self.assertEqual(self.client.post("/api/git/branches/agent/t1/verdict", data="nope", content_type="application/json").status_code, 400)

    def test_unlisted_branch_is_404(self):
        self.assertEqual(self.post({"verdict": "merge", "reasons": [], "source": "manual"}, branch="agent/nope").status_code, 404)

    def test_claimed_sha_that_is_not_the_head_is_409_and_records_nothing(self):
        r = self.post({"verdict": "merge", "reasons": [], "source": "manual", "sha": "sha-OLD"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(bv.load_verdicts(self.q), {})

    def test_endpoint_only_records_it_never_merges_or_discards(self):
        with mock.patch.object(self.app, "_run_git") as run_git_mock:
            self.post({"verdict": "discard", "reasons": ["x"], "source": "manual"})
        run_git_mock.assert_not_called()

    def test_without_a_cached_head_sha_the_only_git_call_is_a_read_only_rev_parse(self):
        no_sha = {"branch": "agent/t2", "taskId": "t2", "hub": None}
        with mock.patch.object(self.app, "list_unmerged_branches", return_value=[no_sha]), \
                mock.patch.object(self.app, "_run_git", return_value="sha-B\n") as run_git_mock:
            r = self.post({"verdict": "needs-work", "reasons": ["x"], "source": "manual"}, branch="agent/t2")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["headSha"], "sha-B")
        self.assertEqual([c.args[0] for c in run_git_mock.call_args_list], [["rev-parse", "origin/agent/t2"]])


if __name__ == "__main__":
    unittest.main()
