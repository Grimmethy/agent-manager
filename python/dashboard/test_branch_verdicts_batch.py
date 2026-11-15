"""Tests for POST /api/git/branches/verdicts (batch endpoint) and cache-patching behavior.

Run: python -m unittest python.dashboard.test_branch_verdicts_batch -v   (from the repo root)
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import branch_projects  # noqa: E402
import branch_verdicts as bv  # noqa: E402


class BatchEndpoint(unittest.TestCase):
    """POST /api/git/branches/verdicts through the real Flask app, with the git-backed lookups stubbed."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)
        self.client = app.app.test_client()
        self.branches = [
            {"branch": "agent/t1", "taskId": "t1", "headSha": "sha-A", "hub": None},
            {"branch": "agent/t2", "taskId": "t2", "headSha": "sha-B", "hub": None},
            {"branch": "agent/t3", "taskId": "t3", "headSha": "sha-C", "hub": None},
        ]
        patches = [
            mock.patch.object(app, "get_active_repo_root", return_value="/repo"),
            mock.patch.object(app, "queue_dir", return_value=self.q),
            mock.patch.object(app, "list_unmerged_branches", return_value=self.branches),
            mock.patch.object(app, "_invalidate_branch_cache"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def post_batch(self, verdicts):
        return self.client.post("/api/git/branches/verdicts", json={"verdicts": verdicts})

    def test_batch_records_all_verdicts(self):
        r = self.post_batch([
            {"branch": "agent/t1", "verdict": "merge", "reasons": ["reviewed"], "source": "manual"},
            {"branch": "agent/t2", "verdict": "discard", "reasons": [], "source": "chat"},
            {"branch": "agent/t3", "verdict": "needs-work", "reasons": ["fix tests"], "source": "manual"},
        ])
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(len(body["results"]), 3)
        for i, result in enumerate(body["results"]):
            self.assertTrue(result["succeeded"], f"item {i} failed: {result.get('reason')}")
            self.assertEqual(result["branch"], f"agent/t{i+1}")

        # Verify all three were recorded
        v1 = bv.get_verdict(self.q, "agent/t1", "sha-A")
        self.assertEqual(v1["verdict"], "merge")
        v2 = bv.get_verdict(self.q, "agent/t2", "sha-B")
        self.assertEqual(v2["verdict"], "discard")
        v3 = bv.get_verdict(self.q, "agent/t3", "sha-C")
        self.assertEqual(v3["verdict"], "needs-work")

    def test_batch_one_bad_item_does_not_fail_others(self):
        r = self.post_batch([
            {"branch": "agent/t1", "verdict": "merge", "reasons": [], "source": "manual"},
            {"branch": "agent/t2", "verdict": "ship-it", "reasons": [], "source": "manual"},  # invalid
            {"branch": "agent/t3", "verdict": "discard", "reasons": [], "source": "manual"},
        ])
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(len(body["results"]), 3)
        self.assertTrue(body["results"][0]["succeeded"])
        self.assertFalse(body["results"][1]["succeeded"])
        self.assertIn("verdict must be one of", body["results"][1]["reason"])
        self.assertTrue(body["results"][2]["succeeded"])

        # t1 and t3 should still be recorded
        self.assertEqual(bv.get_verdict(self.q, "agent/t1", "sha-A")["verdict"], "merge")
        self.assertEqual(bv.get_verdict(self.q, "agent/t3", "sha-C")["verdict"], "discard")

    def test_batch_409_for_moved_head_sha_per_item(self):
        r = self.post_batch([
            {"branch": "agent/t1", "verdict": "merge", "reasons": [], "source": "manual", "sha": "sha-OLD"},
            {"branch": "agent/t2", "verdict": "discard", "reasons": [], "source": "manual"},
        ])
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(len(body["results"]), 2)
        self.assertFalse(body["results"][0]["succeeded"])
        self.assertIn("head has moved", body["results"][0]["reason"])
        self.assertEqual(body["results"][0]["headSha"], "sha-A")
        self.assertTrue(body["results"][1]["succeeded"])

    def test_batch_empty_list_returns_empty_results(self):
        r = self.post_batch([])
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["results"], [])

    def test_batch_invalid_body_is_400(self):
        r = self.client.post("/api/git/branches/verdicts", json={"not_verdicts": []})
        self.assertEqual(r.status_code, 400)

    def test_batch_non_list_verdicts_is_400(self):
        r = self.client.post("/api/git/branches/verdicts", json={"verdicts": "not a list"})
        self.assertEqual(r.status_code, 400)


class CachePatching(unittest.TestCase):
    """Verify that verdicts patch the cache instead of recomputing (no git fetch)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)
        self.client = app.app.test_client()
        # Clear the branch_projects cache
        with branch_projects._lock:
            self._saved = dict(branch_projects._state)
            branch_projects._state.update({"cache": {}, "thread": None})
        self.addCleanup(self._restore)

    def _restore(self):
        with branch_projects._lock:
            branch_projects._state.clear()
            branch_projects._state.update(self._saved)

    def test_batch_does_not_call_list_unmerged_branches_uncached_with_force_fetch(self):
        """A 10-verdict batch against a foreign project must NOT trigger a git fetch."""
        import app as app_module

        # Set up a foreign project cache entry
        foreign_root = "/fake/foreign/project"
        with branch_projects._lock:
            branch_projects._state["cache"][foreign_root] = {
                "at": 0.0,
                "branches": [
                    {"branch": f"agent/b{i}", "headSha": f"sha{i}", "taskId": f"t{i}", "hub": None}
                    for i in range(10)
                ],
                "error": None,
            }

        call_count = {"count": 0}

        def mock_list_uncached(force_fetch=False, **kwargs):
            if force_fetch:
                call_count["count"] += 1
            return []

        with mock.patch.object(app_module, "get_active_repo_root", return_value="/repo"), \
             mock.patch.object(app_module, "queue_dir", return_value=self.q), \
             mock.patch.object(app_module, "_list_unmerged_branches_uncached", side_effect=mock_list_uncached), \
             mock.patch.object(app_module, "_invalidate_branch_cache"):

            # Patch resolve_scope to return a scope for the foreign project
            def mock_resolve_scope(project_root, active_root):
                if project_root == foreign_root:
                    return {"repoRoot": foreign_root, "repoPath": Path(foreign_root), "qdir": self.q, "label": "foreign"}
                return None

            with mock.patch.object(branch_projects, "resolve_scope", side_effect=mock_resolve_scope):
                r = self.client.post("/api/git/branches/verdicts", json={
                    "verdicts": [
                        {"branch": f"agent/b{i}", "project": foreign_root, "verdict": "merge", "reasons": [], "source": "manual"}
                        for i in range(10)
                    ]
                })

        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(len(body["results"]), 10)
        self.assertTrue(all(r["succeeded"] for r in body["results"]))
        self.assertEqual(call_count["count"], 0, "force_fetch must not be called during a batch")

    def test_background_refresh_marks_entry_stale(self):
        """After a verdict, the cache entry should be marked stale (at=0.0) for background refresh."""
        foreign_root = "/fake/foreign/project"
        with branch_projects._lock:
            branch_projects._state["cache"][foreign_root] = {
                "at": 1000.0,
                "branches": [{"branch": "agent/b1", "headSha": "sha1", "taskId": "t1", "hub": None}],
                "error": None,
            }

        with mock.patch.object(app, "get_active_repo_root", return_value="/repo"), \
             mock.patch.object(app, "queue_dir", return_value=self.q), \
             mock.patch.object(app, "list_unmerged_branches", return_value=[]), \
             mock.patch.object(app, "_invalidate_branch_cache"):

            def mock_resolve_scope(project_root, active_root):
                if project_root == foreign_root:
                    return {"repoRoot": foreign_root, "repoPath": Path(foreign_root), "qdir": self.q, "label": "foreign"}
                return None

            with mock.patch.object(branch_projects, "resolve_scope", side_effect=mock_resolve_scope):
                r = self.client.post("/api/git/branches/verdicts", json={
                    "verdicts": [{"branch": "agent/b1", "project": foreign_root, "verdict": "merge", "reasons": [], "source": "manual"}]
                })

        self.assertEqual(r.status_code, 200)
        with branch_projects._lock:
            entry = branch_projects._state["cache"].get(foreign_root)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["at"], 0.0, "cache entry must be marked stale for background refresh")
        self.assertEqual(entry["branches"][0]["verdict"], "merge")


class ActiveProjectCacheInvalidation(unittest.TestCase):
    """The batch route must drop the ACTIVE project's cached cards after recording, once, exactly like the single route (2026-10-31 review: it imported
    _invalidate_branch_cache and never called it, so a batch wrote verdicts the tab did not show)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)
        self.client = app.app.test_client()
        self.branches = [{"branch": f"agent/t{i}", "taskId": f"t{i}", "headSha": f"sha-{i}", "hub": None} for i in (1, 2, 3)]
        self.invalidate = mock.MagicMock()
        for p in (mock.patch.object(app, "get_active_repo_root", return_value="/repo"),
                  mock.patch.object(app, "queue_dir", return_value=self.q),
                  mock.patch.object(app, "list_unmerged_branches", return_value=self.branches),
                  mock.patch.object(app, "_invalidate_branch_cache", self.invalidate)):
            p.start()
            self.addCleanup(p.stop)

    def post(self, verdicts):
        return self.client.post("/api/git/branches/verdicts", json={"verdicts": verdicts})

    def item(self, i, **extra):
        return {"branch": f"agent/t{i}", "verdict": "needs-work", "reasons": ["r"], "source": "chat", "sha": f"sha-{i}", **extra}

    def test_a_batch_of_three_invalidates_once_without_a_fetch(self):
        r = self.post([self.item(1), self.item(2), self.item(3)])
        self.assertEqual([x["succeeded"] for x in r.get_json()["results"]], [True, True, True])
        self.invalidate.assert_called_once_with(refetch=False)

    def test_a_batch_where_nothing_was_recorded_invalidates_nothing(self):
        r = self.post([self.item(1, verdict="ship-it"), self.item(2, sha="sha-OLD"), {"reasons": []}])
        self.assertEqual([x["succeeded"] for x in r.get_json()["results"]], [False, False, False])
        self.invalidate.assert_not_called()

    def test_a_foreign_project_batch_does_not_touch_the_active_cache(self):
        foreign = "/fake/foreign/project"
        with branch_projects._lock:
            self._saved = dict(branch_projects._state)
            branch_projects._state["cache"] = {foreign: {"at": 5.0, "branches": [dict(self.branches[0])], "error": None}}
        self.addCleanup(lambda: (branch_projects._lock.acquire(), branch_projects._state.clear(), branch_projects._state.update(self._saved), branch_projects._lock.release()))
        scope = {"repoRoot": foreign, "repoPath": Path(foreign), "qdir": self.q, "label": "foreign"}
        with mock.patch.object(branch_projects, "resolve_scope", return_value=scope):
            r = self.post([self.item(1, project=foreign)])
        self.assertTrue(r.get_json()["results"][0]["succeeded"])
        self.invalidate.assert_not_called()


class PatchedRowCarriesSourceAndTime(unittest.TestCase):
    """A patched cached row must show who recorded the verdict and when, like a recomputed one."""

    FOREIGN = "/fake/foreign/project"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)
        self.client = app.app.test_client()
        with branch_projects._lock:
            self._saved = dict(branch_projects._state)
            branch_projects._state["cache"] = {self.FOREIGN: {"at": 5.0, "error": None, "branches": [
                {"branch": "agent/b1", "headSha": "sha1", "taskId": "t1", "hub": None}]}}
        self.addCleanup(self._restore)
        scope = {"repoRoot": self.FOREIGN, "repoPath": Path(self.FOREIGN), "qdir": self.q, "label": "foreign"}
        for p in (mock.patch.object(app, "get_active_repo_root", return_value="/repo"),
                  mock.patch.object(app, "queue_dir", return_value=self.q),
                  mock.patch.object(app, "list_unmerged_branches", return_value=[]),
                  mock.patch.object(app, "_invalidate_branch_cache"),
                  mock.patch.object(branch_projects, "resolve_scope", return_value=scope),
                  mock.patch.object(branch_projects, "find_other_project_branch",
                                    return_value=(None, {"branch": "agent/b1", "headSha": "sha1", "taskId": "t1", "hub": None, "mainBranch": "main"}))):
            p.start()
            self.addCleanup(p.stop)

    def _restore(self):
        with branch_projects._lock:
            branch_projects._state.clear()
            branch_projects._state.update(self._saved)

    def _row(self):
        with branch_projects._lock:
            return branch_projects._state["cache"][self.FOREIGN]["branches"][0]

    def test_the_batch_route_stamps_source_and_verified_at(self):
        r = self.client.post("/api/git/branches/verdicts", json={"verdicts": [
            {"branch": "agent/b1", "project": self.FOREIGN, "verdict": "needs-work", "reasons": ["waiting"], "source": "chat"}]})
        self.assertTrue(r.get_json()["results"][0]["succeeded"], r.get_json())
        row = self._row()
        self.assertEqual((row["verdict"], row["source"]), ("needs-work", "chat"))
        self.assertTrue(row["verifiedAt"])

    def test_the_single_route_stamps_them_too(self):
        r = self.client.post("/api/git/branches/agent/b1/verdict?project=" + self.FOREIGN, json={"verdict": "merge", "reasons": ["ok"], "source": "manual"})
        self.assertEqual(r.status_code, 200, r.get_json())
        row = self._row()
        self.assertEqual((row["verdict"], row["source"]), ("merge", "manual"))
        self.assertTrue(row["verifiedAt"])


if __name__ == "__main__":
    unittest.main()
