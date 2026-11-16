"""expire(project_root) -- marks only one project's cache entry stale.

Run: .venv/bin/python -m unittest python.dashboard.test_branch_projects_expire -v   (from the repo root)
"""
import time
import unittest
from unittest import mock

from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).parent))

import branch_projects  # noqa: E402


class ExpireOneCase(unittest.TestCase):
    def setUp(self):
        # Seed two cache entries with fresh `at` values. Keys are the cache
        # repo-root strings; values mimic the real entry shape.
        self.now = time.time()
        with branch_projects._lock:
            self._saved = dict(branch_projects._state)
            branch_projects._state.update({
                "cache": {
                    "/project/a": {"at": self.now, "branches": [], "error": None},
                    "/project/b": {"at": self.now, "branches": [], "error": None},
                },
                "thread": None,
            })
        self.addCleanup(self._restore)

    def _restore(self):
        with branch_projects._lock:
            branch_projects._state.clear()
            branch_projects._state.update(self._saved)

    def test_expire_marks_only_the_named_project_stale(self):
        """expire('/project/a') should set /project/a's `at` to 0.0 and leave
        /project/b at its fresh value."""
        branch_projects.expire("/project/a")
        with branch_projects._lock:
            a = dict(branch_projects._state["cache"].get("/project/a", {}))
            b = dict(branch_projects._state["cache"].get("/project/b", {}))
        self.assertEqual(a["at"], 0.0, "/project/a should be stale")
        self.assertEqual(a["branches"], [], "branches list must be preserved")
        self.assertEqual(a["error"], None, "error field must be preserved")
        self.assertAlmostEqual(b["at"], self.now, delta=0.05,
                               msg="/project/b must stay fresh (TTL untouched)")

    def test_expire_does_not_touch_ttl_or_expire_all(self):
        """expire() is a targeted invalidation: the TTL default and the
        all-projects path must behave exactly as before."""
        branch_projects.expire("/project/a")
        # TTL unchanged: default is 1800 (no env override in this test).
        self.assertEqual(branch_projects._ttl_seconds(), 1800.0)
        # expire_all still stamps every entry stale.
        branch_projects.expire_all()
        with branch_projects._lock:
            a = branch_projects._state["cache"].get("/project/a", {}).get("at")
            b = branch_projects._state["cache"].get("/project/b", {}).get("at")
        self.assertEqual(a, 0.0)
        self.assertEqual(b, 0.0)

    def test_expire_on_missing_key_is_a_no_op(self):
        """Calling expire() for a project that has no cache entry must not
        raise and must leave the rest of the cache untouched."""
        before_b = branch_projects._state["cache"]["/project/b"]["at"]
        branch_projects.expire("/project/does-not-exist")
        with branch_projects._lock:
            b = branch_projects._state["cache"].get("/project/b", {}).get("at")
        self.assertEqual(b, before_b)

    def test_expire_preserves_other_projects_branches_and_error(self):
        """expire() must not touch branches[] or error on the stale entry,
        only the `at` timestamp."""
        branch_projects._state["cache"]["/project/a"]["branches"] = [{"branch": "x"}]
        branch_projects._state["cache"]["/project/a"]["error"] = "old failure"
        branch_projects.expire("/project/a")
        with branch_projects._lock:
            entry = dict(branch_projects._state["cache"]["/project/a"])
        self.assertEqual(entry["at"], 0.0)
        self.assertEqual(entry["branches"], [{"branch": "x"}])
        self.assertEqual(entry["error"], "old failure")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
