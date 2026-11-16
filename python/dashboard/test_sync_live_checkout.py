"""Tests for app._sync_live_checkout against real temporary git repos.

A bare "origin" repo stands in for the remote, a seed clone pushes upstream
commits, and a clone at "live/" stands in for PACKAGE_ROOT.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app  # noqa: E402

GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}


def _git(cwd, *args):
    result = subprocess.run(
        ["git", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", *args],
        cwd=str(cwd), env=GIT_ENV, check=True, capture_output=True, text=True,
    )
    return result.stdout.strip()


class SyncLiveCheckoutTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.origin = base / "origin.git"
        self.seed = base / "seed"
        self.live = base / "live"
        _git(base, "init", "--bare", str(self.origin))
        _git(base, "init", str(self.seed))
        (self.seed / "README.md").write_text("readme\n")
        (self.seed / ".gitignore").write_text("*.bak-*\n")
        _git(self.seed, "add", "README.md", ".gitignore")
        _git(self.seed, "commit", "-m", "seed")
        _git(self.seed, "remote", "add", "origin", str(self.origin))
        _git(self.seed, "push", "origin", "HEAD:main")
        _git(base, "clone", str(self.origin), str(self.live))

    def _push_upstream(self, files):
        """Commit files on the seed repo (forced add, so ignored names still go in) and push to origin/main."""
        for rel, content in files.items():
            path = self.seed / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        _git(self.seed, "add", "-f", *files.keys())
        _git(self.seed, "commit", "-m", "upstream change")
        _git(self.seed, "push", "origin", "HEAD:main")
        return _git(self.seed, "rev-parse", "HEAD")

    def _live_head(self):
        return _git(self.live, "rev-parse", "HEAD")

    def _sync(self):
        with mock.patch.object(app, "PACKAGE_ROOT", self.live):
            return app._sync_live_checkout("main")

    def test_untracked_file_does_not_block_clean_fast_forward(self):
        (self.live / "notes.txt").write_text("local notes\n")
        new_sha = self._push_upstream({"upstream.txt": "up\n"})

        result = self._sync()

        self.assertIs(result["synced"], True, result)
        self.assertIs(result["changed"], True, result)
        self.assertEqual(self._live_head(), new_sha)
        self.assertEqual((self.live / "notes.txt").read_text(), "local notes\n")

    def test_modified_tracked_file_blocks_with_tracked_dirty(self):
        (self.live / "README.md").write_text("local edit\n")
        self._push_upstream({"other.txt": "x\n"})
        head_before = self._live_head()

        result = self._sync()

        self.assertIs(result["synced"], False, result)
        self.assertEqual(result["reason_code"], "tracked-dirty")
        self.assertTrue(result.get("reason"), "reason must be non-empty")
        self.assertIn("uncommitted", result["reason"])
        self.assertEqual(self._live_head(), head_before)
        self.assertEqual((self.live / "README.md").read_text(), "local edit\n")

    def test_clean_fast_forward_reports_synced_and_changed(self):
        new_sha = self._push_upstream({"upstream.txt": "up\n"})

        result = self._sync()

        self.assertIs(result["synced"], True, result)
        self.assertIs(result["changed"], True, result)
        self.assertEqual(self._live_head(), new_sha)

    def test_non_repo_returns_not_repo_with_reason(self):
        with tempfile.TemporaryDirectory() as plain:
            with mock.patch.object(app, "PACKAGE_ROOT", Path(plain)):
                result = app._sync_live_checkout("main")

        self.assertIs(result["synced"], False, result)
        self.assertEqual(result["reason_code"], "not-repo")
        self.assertTrue(result.get("reason"), "reason must be non-empty")

    def test_untracked_collision_with_upstream_added_path_blocks_and_names_path(self):
        (self.live / "docs").mkdir()
        (self.live / "docs" / "new.txt").write_text("local draft\n")
        self._push_upstream({"docs/new.txt": "upstream version\n"})
        head_before = self._live_head()

        result = self._sync()

        self.assertIs(result["synced"], False, result)
        self.assertEqual(result["reason_code"], "untracked-collision")
        self.assertIn("docs/new.txt", result["reason"])
        self.assertEqual(self._live_head(), head_before)
        self.assertEqual((self.live / "docs" / "new.txt").read_text(), "local draft\n")

    def test_ignored_collision_with_upstream_added_path_blocks_and_preserves_file(self):
        (self.live / "x.bak-1").write_text("local backup\n")
        self._push_upstream({"x.bak-1": "upstream copy\n"})
        head_before = self._live_head()

        result = self._sync()

        self.assertIs(result["synced"], False, result)
        self.assertEqual(result["reason_code"], "untracked-collision")
        self.assertIn("x.bak-1", result["reason"])
        self.assertEqual(self._live_head(), head_before)
        self.assertEqual((self.live / "x.bak-1").read_text(), "local backup\n")


if __name__ == "__main__":
    unittest.main()
