"""Tests for app.py's backfill_env_from_file -- the dashboard filling os.environ from
agent-manager.env when it was NOT started via scripts/launch.sh (which does
`set -a; source agent-manager.env`). Without it, the node children the dashboard shells
out to (local-tool-client.js for Chat) get no AGENT_MANAGER_REPO_ROOT and abort.

Run: .venv/bin/python -m unittest python.dashboard.test_env_backfill -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TestEnvBackfill(unittest.TestCase):
    def setUp(self):
        self._saved = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)

    def _write(self, text):
        f = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False)
        f.write(text)
        f.close()
        self.addCleanup(os.unlink, f.name)
        return Path(f.name)

    def test_fills_missing_keys_only(self):
        os.environ.pop("AGENT_MANAGER_REPO_ROOT", None)
        os.environ["ALREADY_SET"] = "keep-me"
        p = self._write(
            "# comment\n"
            "AGENT_MANAGER_REPO_ROOT=/x/y\n"
            "ALREADY_SET=from-file\n"
            "\n"
            "LOCAL_MODEL=qwen\n"
        )
        filled = app.backfill_env_from_file(p)
        self.assertEqual(os.environ["AGENT_MANAGER_REPO_ROOT"], "/x/y")
        self.assertEqual(os.environ["ALREADY_SET"], "keep-me", "an explicitly-set var must not be overridden")
        self.assertEqual(os.environ["LOCAL_MODEL"], "qwen")
        self.assertCountEqual(filled, ["AGENT_MANAGER_REPO_ROOT", "LOCAL_MODEL"])

    def test_missing_file_is_a_noop(self):
        self.assertEqual(app.backfill_env_from_file(Path("/no/such/agent-manager.env")), [])

    def test_blank_values_are_skipped(self):
        os.environ.pop("EMPTY_ONE", None)
        p = self._write("EMPTY_ONE=\nREAL=v\n")
        filled = app.backfill_env_from_file(p)
        self.assertNotIn("EMPTY_ONE", os.environ)
        self.assertEqual(filled, ["REAL"])


if __name__ == "__main__":
    unittest.main()
