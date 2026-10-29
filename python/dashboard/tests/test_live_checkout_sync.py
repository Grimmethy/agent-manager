"""Tests for _sync_live_checkout: untracked files must not block fast-forwarding."""
import os
import subprocess
import tempfile
import shutil
import unittest
from unittest.mock import patch
from pathlib import Path


def _git(args, cwd):
    """Run git and return stdout, raising on failure."""
    r = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


class TestSyncLiveCheckout(unittest.TestCase):
    """Use a throwaway bare + clone to exercise _sync_live_checkout end-to-end."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="live_sync_test_")
        self._origin = os.path.join(self._tmpdir, "origin.git")
        self._clone = os.path.join(self._tmpdir, "clone")
        # Create the origin as a non-bare repo so we can make the initial commit
        # directly (avoids the "no default branch" problem with bare repos).
        subprocess.run(["git", "init", "-b", "main", self._origin], check=True, capture_output=True)
        _git(["config", "user.email", "test@test.com"], self._origin)
        _git(["config", "user.name", "test"], self._origin)
        Path(os.path.join(self._origin, "README.md")).write_text("hello\n")
        _git(["add", "README.md"], self._origin)
        _git(["commit", "-m", "initial"], self._origin)
        # Convert to bare (standard origin pattern) so clones treat it as a remote.
        subprocess.run(["git", "clone", "--bare", self._origin, os.path.join(self._tmpdir, "origin_bare.git")],
                       check=True, capture_output=True)
        shutil.rmtree(self._origin)
        os.rename(os.path.join(self._tmpdir, "origin_bare.git"), self._origin)

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _rebuild_clone(self, extra_setup=None):
        """Re-clone from origin, then run extra_setup(clone_dir) for test-specific state."""
        subprocess.run(["git", "clone", "-b", "main", self._origin, self._clone], check=True, capture_output=True)
        _git(["config", "user.email", "test@test.com"], self._clone)
        _git(["config", "user.name", "test"], self._clone)
        if extra_setup:
            extra_setup(self._clone)
        return self._clone

    def _sync(self, main_branch="main"):
        """Call _sync_live_checkout with PACKAGE_ROOT pointing at our clone."""
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
        from app import _sync_live_checkout
        with patch("app.PACKAGE_ROOT", Path(self._clone)):
            return _sync_live_checkout(main_branch)

    def test_untracked_bak_files_do_not_block(self):
        """Untracked bak files alone must NOT block the fast-forward."""
        # 1. Make a new commit on origin (simulates a branch landing on main).
        seed = os.path.join(self._tmpdir, "seed")
        subprocess.run(["git", "clone", self._origin, seed], check=True, capture_output=True)
        _git(["config", "user.email", "test@test.com"], seed)
        _git(["config", "user.name", "test"], seed)
        Path(os.path.join(seed, "extra.txt")).write_text("extra\n")
        _git(["add", "extra.txt"], seed)
        _git(["commit", "-m", "extra"], seed)
        _git(["push", "origin", "main"], seed)
        shutil.rmtree(seed)

        # 2. Set up the clone with ONLY untracked bak files (no tracked changes).
        self._rebuild_clone(extra_setup=lambda c: (
            Path(os.path.join(c, "agent-manager.env.bak-1")).write_text("old\n"),
            Path(os.path.join(c, "plugins.json.bak-1")).write_text("{}\n"),
            Path(os.path.join(c, "projects.json.bak-1")).write_text("[]\n"),
        ))

        result = self._sync()
        self.assertTrue(result["synced"], f"Expected synced=True, got: {result}")

    def test_tracked_modification_blocks(self):
        """A tracked (committed-then-modified) file must still block."""
        # Origin advances with a new commit.
        seed = os.path.join(self._tmpdir, "seed2")
        subprocess.run(["git", "clone", self._origin, seed], check=True, capture_output=True)
        _git(["config", "user.email", "test@test.com"], seed)
        _git(["config", "user.name", "test"], seed)
        Path(os.path.join(seed, "extra2.txt")).write_text("extra2\n")
        _git(["add", "extra2.txt"], seed)
        _git(["commit", "-m", "extra2"], seed)
        _git(["push", "origin", "main"], seed)
        shutil.rmtree(seed)

        # Clone, then modify a TRACKED file (README.md exists in origin).
        self._rebuild_clone(extra_setup=lambda c: (
            Path(os.path.join(c, "README.md")).write_text("modified\n"),
        ))

        result = self._sync()
        self.assertFalse(result["synced"])
        self.assertIn("uncommitted local changes", result["reason"])

    def test_incoming_add_colliding_with_untracked_blocks(self):
        """If an incoming commit ADDS a file that collides with an untracked file,
        the function must return synced=False with the colliding path named."""
        # 1. Clone from origin (has only README.md). Create an UNTRACKED file.
        self._rebuild_clone(extra_setup=lambda c: (
            Path(os.path.join(c, "collision.txt")).write_text("UNTRACKED\n"),
        ))

        # 2. Advance origin/main with a commit that ADDS collision.txt.
        seed = os.path.join(self._tmpdir, "seed_collision")
        subprocess.run(["git", "clone", self._origin, seed], check=True, capture_output=True)
        _git(["config", "user.email", "test@test.com"], seed)
        _git(["config", "user.name", "test"], seed)
        Path(os.path.join(seed, "collision.txt")).write_text("FROM_ORIGIN\n")
        _git(["add", "collision.txt"], seed)
        _git(["commit", "-m", "add collision.txt"], seed)
        _git(["push", "origin", "main"], seed)
        shutil.rmtree(seed)

        # Now: clone has untracked collision.txt, origin/main will add it.
        result = self._sync()
        self.assertFalse(result["synced"], f"Expected synced=False, got: {result}")
        self.assertIn("untracked files block fast-forward", result["reason"])
        self.assertIn("collision.txt", result["reason"])


if __name__ == "__main__":
    unittest.main()
