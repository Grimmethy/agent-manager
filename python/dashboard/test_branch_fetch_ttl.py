"""The dashboard's timed `git fetch origin` cadence for branch lists (ADR-0024: fewer disk calls while nothing changed).

Run: .venv/bin/python -m unittest test_branch_fetch_ttl -v   (from python/dashboard)
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import app_catalog_helpers as helpers  # noqa: E402
import branch_projects  # noqa: E402


class ActiveProjectFetchTtl(unittest.TestCase):
    def test_default_is_five_minutes(self):
        self.assertEqual(helpers._branch_fetch_ttl_seconds({}), 300.0)

    def test_env_override_is_honoured_with_a_30_second_floor(self):
        self.assertEqual(helpers._branch_fetch_ttl_seconds({"AGENT_MANAGER_BRANCH_FETCH_TTL_SECONDS": "900"}), 900.0)
        self.assertEqual(helpers._branch_fetch_ttl_seconds({"AGENT_MANAGER_BRANCH_FETCH_TTL_SECONDS": "1"}), 30.0)

    def test_garbage_falls_back_to_the_default(self):
        self.assertEqual(helpers._branch_fetch_ttl_seconds({"AGENT_MANAGER_BRANCH_FETCH_TTL_SECONDS": "soon"}), 300.0)

    def test_module_constant_uses_the_helper(self):
        self.assertEqual(app._BRANCH_FETCH_TTL_SECONDS, helpers._BRANCH_FETCH_TTL_SECONDS)
        self.assertGreaterEqual(app._BRANCH_FETCH_TTL_SECONDS, 30.0)

    def test_a_merge_or_discard_still_forces_the_next_fetch(self):
        with app._branch_cache_lock:
            saved = dict(app._branch_fetch_state)
            app._branch_fetch_state["at"] = 10 ** 10        # "fetched far in the future": not due by the timer
        try:
            app._invalidate_branch_cache(refetch=True)
            with app._branch_cache_lock:
                self.assertEqual(app._branch_fetch_state["at"], 0.0)
        finally:
            with app._branch_cache_lock:
                app._branch_fetch_state.update(saved)


class OtherProjectsTtl(unittest.TestCase):
    def test_default_is_thirty_minutes(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop("AGENT_MANAGER_BRANCH_OTHER_PROJECTS_TTL_SECONDS", None)
            self.assertEqual(branch_projects._ttl_seconds(), 1800.0)

    def test_env_override_and_floor(self):
        with mock.patch.dict("os.environ", {"AGENT_MANAGER_BRANCH_OTHER_PROJECTS_TTL_SECONDS": "600"}):
            self.assertEqual(branch_projects._ttl_seconds(), 600.0)
        with mock.patch.dict("os.environ", {"AGENT_MANAGER_BRANCH_OTHER_PROJECTS_TTL_SECONDS": "5"}):
            self.assertEqual(branch_projects._ttl_seconds(), 30.0)
        with mock.patch.dict("os.environ", {"AGENT_MANAGER_BRANCH_OTHER_PROJECTS_TTL_SECONDS": "x"}):
            self.assertEqual(branch_projects._ttl_seconds(), 1800.0)


if __name__ == "__main__":
    unittest.main()
