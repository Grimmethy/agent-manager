"""GET /api/git/stale-branch-candidates returns the branch_staleness.stale_candidates dict as JSON.

The cached row source (app.list_unmerged_branches) and the project scan are stubbed with a
fixed list of rows, so nothing touches a real repo. The real branch_staleness classifier runs.
The route is read-only: the Path write methods are replaced with MagicMocks that must never fire.

Run: python -I -m unittest python.dashboard.test_stale_branch_route -v   (from the repo root)
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import branch_projects  # noqa: E402
import branch_staleness  # noqa: E402

URL = "/api/git/stale-branch-candidates?projects=all"
ROWS = [
    {"project": {"label": "alpha"}, "branch": "agent/far", "headSha": "sha-far", "behind": 150,
     "hub": "HUB0001", "taskId": "t-far", "subject": "far", "verdict": None, "source": "auto", "ahead": 0},
    {"project": {"label": "alpha"}, "branch": "agent/near", "headSha": "sha-near", "behind": 3,
     "hub": "HUB0002", "taskId": "t-near", "subject": "near", "verdict": None, "source": "auto", "ahead": 0},
]


class StaleBranchRoute(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self.tmp = tempfile.mkdtemp()
        self.write_text = mock.MagicMock(name="write_text")
        self.write_bytes = mock.MagicMock(name="write_bytes")

    def get(self):
        env = {k: v for k, v in os.environ.items() if k != branch_staleness.ENV_VAR}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(app, "list_unmerged_branches", return_value=[dict(r) for r in ROWS]), \
                mock.patch.object(branch_projects, "combined_branches", side_effect=lambda b, root: (b, [])), \
                mock.patch.object(app, "get_active_repo_root", return_value=self.tmp), \
                mock.patch.object(app, "get_pipeline_dir", return_value=self.tmp), \
                mock.patch.object(app, "_find_task_record_anywhere", return_value=(None, None)), \
                mock.patch.object(Path, "write_text", self.write_text), \
                mock.patch.object(Path, "write_bytes", self.write_bytes):
            return self.client.get(URL)

    def test_returns_200_with_stale_candidates_shape(self):
        resp = self.get()
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertIsInstance(body, dict)
        self.assertIsInstance(body["candidates"], list)
        self.assertIsInstance(body["excluded"], dict)
        self.assertIsInstance(body["excludedOwner"], list)
        self.assertIsInstance(body["threshold"], int)
        self.assertIsInstance(body["lookupErrors"], int)

    def test_classifies_rows_with_the_real_branch_staleness_functions(self):
        body = self.get().get_json()
        self.assertEqual(body["threshold"], branch_staleness.DEFAULT_THRESHOLD)
        self.assertEqual([c["branch"] for c in body["candidates"]], ["agent/far"])
        self.assertEqual(body["excluded"], {"not-far-behind": 1})

    def test_never_writes(self):
        self.get()
        self.write_text.assert_not_called()
        self.write_bytes.assert_not_called()


if __name__ == "__main__":
    unittest.main()
