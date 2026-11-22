"""/api/git/unmerged-branches is tagged so the tab's 15 s poll gets a body-less 304 while the list is unchanged.

The reply is ~140 KB and almost always identical to the previous one; the list and the project scan are stubbed here so nothing touches a real repo.

Run: .venv/bin/python -m unittest python.dashboard.test_branch_list_etag -v   (from the repo root)
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import branch_projects  # noqa: E402

URL = "/api/git/unmerged-branches"
ALL = URL + "?projects=all"
ROWS = [{"branch": "agent/t1", "headSha": "sha-A", "mainBranch": "master"}]
MORE = ROWS + [{"branch": "agent/t2", "headSha": "sha-B", "mainBranch": "master"}]


class BranchListEtag(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def get(self, url, rows=ROWS, pending=(), headers=None, cached_at=100.0):
        with mock.patch.object(app, "list_unmerged_branches", return_value=rows), \
                mock.patch.dict(app._branch_cache, {"at": cached_at}), \
                mock.patch.object(app, "get_active_repo_root", return_value="/repo"), \
                mock.patch.object(branch_projects, "combined_branches", side_effect=lambda b, root: (b, list(pending))):
            return self.client.get(url, headers=headers or {})

    def test_reply_carries_a_strong_etag_and_no_cache(self):
        resp = self.get(ALL)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), ROWS)
        self.assertRegex(resp.headers["ETag"], r'^"[0-9a-f]{64}"$')
        self.assertEqual(resp.headers["Cache-Control"], "no-cache")

    def test_matching_if_none_match_gets_an_empty_304_that_keeps_the_branch_headers(self):
        first = self.get(ALL, pending=["beta"])
        again = self.get(ALL, pending=["beta"], headers={"If-None-Match": first.headers["ETag"]})
        self.assertEqual(again.status_code, 304)
        self.assertEqual(again.data, b"")
        self.assertEqual(again.headers["X-Branch-Projects-Pending"], "beta")
        self.assertIn("X-Branch-Cache-Age", again.headers)
        self.assertEqual(again.headers["ETag"], first.headers["ETag"])

    def test_changed_body_gets_a_new_tag_and_a_full_200(self):
        first = self.get(ALL)
        changed = self.get(ALL, rows=MORE, headers={"If-None-Match": first.headers["ETag"]})
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.get_json(), MORE)
        self.assertNotEqual(changed.headers["ETag"], first.headers["ETag"])

    def test_same_body_but_a_different_pending_header_gets_a_new_tag(self):
        scanning = self.get(ALL, pending=["beta"])
        done = self.get(ALL, pending=[], headers={"If-None-Match": scanning.headers["ETag"]})
        self.assertEqual(done.status_code, 200)
        self.assertEqual(done.headers["X-Branch-Projects-Pending"], "")
        self.assertNotEqual(done.headers["ETag"], scanning.headers["ETag"])

    def test_the_cache_age_header_does_not_change_the_tag(self):
        young = self.get(ALL, cached_at=100.0)
        old = self.get(ALL, cached_at=50.0)
        self.assertNotEqual(young.headers["X-Branch-Cache-Age"], old.headers["X-Branch-Cache-Age"])
        self.assertEqual(young.headers["ETag"], old.headers["ETag"])

    def test_the_plain_active_project_list_is_tagged_and_revalidates_too(self):
        first = self.get(URL)
        self.assertEqual(first.get_json(), ROWS)
        again = self.get(URL, headers={"If-None-Match": first.headers["ETag"]})
        self.assertEqual(again.status_code, 304)
        self.assertEqual(again.data, b"")


if __name__ == "__main__":
    unittest.main()
