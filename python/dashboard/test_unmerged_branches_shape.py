"""Tests for the shape of GET /api/git/unmerged-branches:

- Default response is a flat list of branch rows (each with a `branch` key)
- ?group=hub returns the hub-grouped shape
- ?projects=all still returns flat (default behavior unchanged by other params)

Run: .venv/bin/python -m unittest python.dashboard.test_unmerged_branches_shape -v

2026-10-30, HUB0241 corrective: the endpoint was returning hub-grouped data by
default, breaking consumers that expect flat rows. This test pins the shape so the
fix cannot regress.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes.pipeline_1_more import api_git_unmerged_branches  # noqa: E402


# Fixture: three branches, two with hubs, one without.
FIXTURE_BRANCHES = [
    {"branch": "agent/h1", "headSha": "sha1", "hub": {"id": "HUB0001"}},
    {"branch": "agent/h2", "headSha": "sha2", "hub": {"id": "HUB0001"}},
    {"branch": "agent/h3", "headSha": "sha3"},  # No hub
]


class UnmergedBranchesShapeTest(unittest.TestCase):
    def setUp(self):
        # Patch list_unmerged_branches to return our fixture without hitting git
        self.patcher = mock.patch.object(
            app,
            "list_unmerged_branches",
            return_value=FIXTURE_BRANCHES,
        )
        self.mock_list = self.patcher.start()
        self.addCleanup(self.patcher.stop)

        # Also patch the cache so the X-Branch-Cache-Age header is set cleanly
        with app._branch_cache_lock:
            self._saved_cache = dict(app._branch_cache)
            app._branch_cache.update({"at": 0.0, "branches": []})
        self.addCleanup(self._restore_cache)

    def _restore_cache(self):
        with app._branch_cache_lock:
            app._branch_cache.clear()
            app._branch_cache.update(self._saved_cache)

    def _call(self, **query_args):
        """Call the route with a mock request context and return the parsed JSON."""
        from flask import Flask, Request

        # Build a minimal request with the given query args
        with app.app.test_request_context("/api/git/unmerged-branches", query_string=query_args):
            resp = api_git_unmerged_branches()

        # resp is a (response, status_code) tuple from jsonify
        if hasattr(resp, "get_json"):
            return resp.get_json()
        # Flask test_client returns (data, status, headers) -- handle both shapes
        if isinstance(resp, tuple) and len(resp) == 2:
            return resp[0].get_json()
        return resp

    def test_default_returns_flat_list(self):
        """Default (no params) is a flat list of branch rows."""
        data = self._call()
        self.assertIsInstance(data, list, f"expected list, got {type(data).__name__}: {data}")
        self.assertEqual(len(data), len(FIXTURE_BRANCHES))
        # Every row has a `branch` key
        for row in data:
            self.assertIn("branch", row, f"row missing 'branch' key: {row}")
            self.assertEqual(row["branch"], row["branch"])  # sanity

    def test_group_hub_returns_grouped_shape(self):
        """?group=hub returns the hub-grouped shape: list of {hub_id, position, status, branches}."""
        data = self._call(group="hub")
        self.assertIsInstance(data, list, f"expected list, got {type(data).__name__}")
        self.assertTrue(len(data) > 0, "expected at least one group")
        # First group should have hub_id key
        first = data[0]
        self.assertIn("hub_id", first, f"group missing 'hub_id' key: {first}")
        self.assertIn("position", first, f"group missing 'position' key: {first}")
        self.assertIn("status", first, f"group missing 'status' key: {first}")
        self.assertIn("branches", first, f"group missing 'branches' key: {first}")
        # The branches inside each group are the original branch rows
        for group in data:
            for b in group["branches"]:
                self.assertIn("branch", b, f"inner branch missing 'branch' key: {b}")

    def test_projects_all_still_flat(self):
        """?projects=all returns flat (default behavior unchanged by other params)."""
        data = self._call(projects="all")
        self.assertIsInstance(data, list, f"expected list, got {type(data).__name__}")
        # The first row should have a `branch` key (flat shape), not `hub_id` (grouped shape)
        if len(data) > 0:
            first = data[0]
            self.assertIn("branch", first, f"row missing 'branch' key in ?projects=all: {first}")
            self.assertNotIn("hub_id", first, f"row has 'hub_id' in ?projects=all (should be flat): {first}")

    def test_group_and_projects_both_params(self):
        """?group=hub with ?projects=all: group wins (explicit opt-in)."""
        data = self._call(group="hub", projects="all")
        self.assertIsInstance(data, list)
        if len(data) > 0:
            first = data[0]
            self.assertIn("hub_id", first, f"expected hub_id in grouped response: {first}")


if __name__ == "__main__":
    unittest.main()
