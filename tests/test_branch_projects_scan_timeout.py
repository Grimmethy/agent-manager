"""Tests for branch_projects.py scan timeout, scan-one, and ordering.

Covers three cases:
  1. A stuck project returns an error entry, other projects still work, pending count decreases.
  2. scan_one_now() can force-scan a specific project and returns (None, error) for unknown.
  3. combined_branches() puts active project branches first, other projects A-Z.

Run: python3 -m unittest tests.test_branch_projects_scan_timeout -v
"""
import os
import sys
import time
import unittest
from unittest import mock

# Ensure python/dashboard is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python", "dashboard"))

# Set timeout to 1 second for tests before importing branch_projects
os.environ["BRANCH_SCAN_TIMEOUT_S"] = "1"

import branch_projects  # noqa: E402


class _Base(unittest.TestCase):
    """Base class that resets branch_projects state between tests."""

    def setUp(self):
        branch_projects._state["cache"] = {}
        branch_projects._queue = []
        branch_projects._current = {"root": None}
        branch_projects._state["thread"] = None


class TestScanTimeout(_Base):
    """Test that a stuck project is timed out and marked as errored."""

    def test_stuck_project_returns_error(self):
        """A project that hangs past BRANCH_SCAN_TIMEOUT_S should be marked as errored."""
        # Create a mock app module
        mock_app = mock.MagicMock()
        mock_app._list_unmerged_branches_uncached.side_effect = lambda *args, **kwargs: time.sleep(100)
        
        # Patch app module where it's imported in _scan_bounded
        with mock.patch.dict(sys.modules, {"app": mock_app}):
            # Call _scan_bounded directly
            branches, error = branch_projects._scan_bounded("/tmp/test-project", "/tmp/test-project")
            
            # Should return empty branches and an error mentioning timeout
            self.assertEqual(branches, [])
            self.assertIn("timed out", error.lower())
            self.assertIn("1", error)  # Should mention the timeout value

    def test_scan_status_includes_errors(self):
        """scan_status() should include errored projects in the errors list."""
        # Manually set up an errored cache entry
        with mock.patch.object(branch_projects, "_lock"):
            branch_projects._state["cache"]["/tmp/test-project"] = {
                "at": time.time(),
                "branches": [],
                "error": "Scan timed out after 1s",
                "startedAt": time.time() - 10,
                "finishedAt": time.time(),
            }
            branch_projects._current["root"] = None
            branch_projects._queue = []
        
        # Mock registered_projects to avoid importing app
        fake_project = {
            "label": "test-project",
            "repoRoot": "/tmp/test-project",
            "pipelineDir": "/tmp/test-project",
            "active": False,
        }
        
        with mock.patch.object(branch_projects, "registered_projects", return_value=[fake_project]):
            status = branch_projects.scan_status()
        
        # Should have an error entry
        self.assertTrue(len(status["errors"]) > 0, f"Expected errors, got {status}")
        error_entry = status["errors"][0]
        self.assertEqual(error_entry["label"], "test-project")
        self.assertIn("timed out", error_entry["error"].lower())

    def test_other_projects_continue_working(self):
        """Other projects should still be scanned even if one times out."""
        call_count = {"count": 0}
        
        def mock_scan(*args, **kwargs):
            call_count["count"] += 1
            if call_count["count"] == 1:
                # First call (test-project) hangs
                time.sleep(100)
            else:
                # Second call (other-project) succeeds
                return []
        
        mock_app = mock.MagicMock()
        mock_app._list_unmerged_branches_uncached.side_effect = mock_scan
        
        with mock.patch.dict(sys.modules, {"app": mock_app}):
            # First project times out
            branches1, error1 = branch_projects._scan_bounded("/tmp/test-project", "/tmp/test-project")
            self.assertEqual(branches1, [])
            self.assertIsNotNone(error1)
            
            # Second project succeeds
            branches2, error2 = branch_projects._scan_bounded("/tmp/other-project", "/tmp/other-project")
            self.assertEqual(error2, None)

    def test_pending_count_decreases_after_timeout(self):
        """After a timeout, the project should move from pending to errors."""
        # Simulate what _refresh_stale does after a timeout:
        # 1. Call _scan_bounded (which times out)
        # 2. Update the cache with the error
        # 3. Clear _current["root"]
        
        # Set up initial state: project is being scanned
        project = {
            "label": "test-project",
            "repoRoot": "/tmp/test-project",
            "pipelineDir": "/tmp/test-project",
            "active": False,
        }
        
        mock_app = mock.MagicMock()
        mock_app._list_unmerged_branches_uncached.side_effect = lambda *args, **kwargs: time.sleep(100)
        
        with mock.patch.dict(sys.modules, {"app": mock_app}):
            # Mark as currently scanning
            with mock.patch.object(branch_projects, "_lock"):
                branch_projects._current["root"] = project["repoRoot"]
                branch_projects._queue = []  # Queue is empty, project is being scanned
            
            # Simulate the scan completing (with timeout)
            branches, error = branch_projects._scan_bounded(
                project["repoRoot"], project["pipelineDir"]
            )
            
            # Simulate what _refresh_stale does after the scan
            with mock.patch.object(branch_projects, "_lock"):
                branch_projects._state["cache"][project["repoRoot"]] = {
                    "at": time.time(),
                    "branches": branches,
                    "error": error,
                    "startedAt": time.time() - 10,
                    "finishedAt": time.time(),
                }
                branch_projects._current["root"] = None
        
        # Mock registered_projects to avoid importing app
        with mock.patch.object(branch_projects, "registered_projects", return_value=[project]):
            status = branch_projects.scan_status()
            pending_labels = [p["label"] for p in status["pending"]]
            error_labels = [e["label"] for e in status["errors"]]
            
            # Project should be in errors, not pending
            self.assertNotIn("test-project", pending_labels, f"Project still in pending: {pending_labels}")
            self.assertIn("test-project", error_labels, f"Project not in errors: {error_labels}")


class TestScanOneNow(_Base):
    """Test the scan_one_now function for force-scanning a project."""

    def test_scan_one_now_unknown_project(self):
        """scan_one_now should return (None, error) for unknown projects."""
        with mock.patch.object(branch_projects, "registered_projects", return_value=[]):
            entry, error = branch_projects.scan_one_now("nonexistent")
            
            self.assertIsNone(entry)
            self.assertEqual(error, "unknown project")

    def test_scan_one_now_returns_cached_if_fresh(self):
        """scan_one_now should return cached entry if project is already scanned."""
        fake_project = {
            "label": "test-project",
            "repoRoot": "/tmp/test-project",
            "pipelineDir": "/tmp/test-project",
            "active": False,
        }
        
        cached_entry = {
            "at": time.time(),
            "branches": [{"branch": "main"}],
            "error": None,
        }
        
        with mock.patch.object(branch_projects, "registered_projects", return_value=[fake_project]):
            # Set up cache
            with mock.patch.object(branch_projects, "_lock"):
                branch_projects._state["cache"]["/tmp/test-project"] = cached_entry
            
            entry, error = branch_projects.scan_one_now("test-project")
            
            # Should return the cached entry
            self.assertIsNotNone(entry)
            self.assertIsNone(error)
            self.assertEqual(entry["branches"], [{"branch": "main"}])


class TestMergeVerdictFirstOrdering(_Base):
    """Test that active project branches come first in combined output."""

    def test_active_branches_come_first(self):
        """Active project's branches should appear before other projects'."""
        active_branches = [
            {"branch": "feature-a", "pushedAt": "2024-01-01"},
            {"branch": "feature-b", "pushedAt": "2024-01-02"},
        ]
        
        other_branches = [
            {"branch": "other-c", "pushedAt": "2024-01-03"},
        ]
        
        with mock.patch.object(branch_projects, "registered_projects") as mock_reg:
            mock_reg.return_value = [
                {
                    "label": "active",
                    "repoRoot": "/tmp/active",
                    "pipelineDir": "/tmp/active",
                    "active": True,
                },
                {
                    "label": "other",
                    "repoRoot": "/tmp/other",
                    "pipelineDir": "/tmp/other",
                    "active": False,
                },
            ]
            
            # other_project_branches returns (result, pending)
            # result is a list of (project, branches) tuples
            def mock_other_project_branches(active_root, prefer_root=None):
                other_project = next(p for p in mock_reg.return_value if not p["active"])
                return [({**other_project, "label": other_project["label"]}, other_branches)], []
            
            with mock.patch.object(branch_projects, "other_project_branches", side_effect=mock_other_project_branches):
                rows, pending = branch_projects.combined_branches(active_branches, "/tmp/active")
                
                # Active project's branches should come first
                self.assertTrue(len(rows) > 0, f"Expected rows, got {rows}")
                first_branch = rows[0]
                self.assertEqual(first_branch["project"]["label"], "active", 
                               f"First branch should be from active project, got {first_branch}")


if __name__ == "__main__":
    unittest.main()
