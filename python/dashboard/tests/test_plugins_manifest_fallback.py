"""Tests for the plugins.json last-known-good fallback and atomic write in app.py.

unittest.TestCase classes (the package's convention); pytest collects them too:
    python -I -m pytest python/dashboard/tests/test_plugins_manifest_fallback.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# `python -I` ignores PYTHONPATH, so put dashboard/ on sys.path explicitly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402


class PluginsManifestFallbackTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "plugins.json"
        for name, value in (
            ("PLUGINS_MANIFEST_PATH", self.path),
            ("_plugins_manifest_last_good", None),
            ("_plugins_manifest_fallback_logged", False),
        ):
            patcher = mock.patch.object(app, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_truncated_file_returns_prior_manifest(self):
        entries = [{"name": "alpha", "enabled": True}, {"name": "beta", "enabled": False}]
        app._write_plugins_manifest(entries)
        self.assertEqual(app._read_plugins_manifest(), entries)

        self.path.write_text('[{"name": "alp', encoding="utf-8")
        self.assertEqual(app._read_plugins_manifest(), entries)

        self.path.write_bytes(b"")
        self.assertEqual(app._read_plugins_manifest(), entries)

    def test_cold_start_truncated_file_returns_empty_list(self):
        self.path.write_text('[{"name": ', encoding="utf-8")
        self.assertEqual(app._read_plugins_manifest(), [])

    def test_failure_before_replace_leaves_old_file_intact(self):
        old = [{"name": "alpha", "enabled": True}]
        app._write_plugins_manifest(old)
        before = self.path.read_bytes()

        with mock.patch.object(app.os, "replace", side_effect=OSError("simulated")):
            with self.assertRaises(OSError):
                app._write_plugins_manifest([{"name": "new"}])

        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), old)
        self.assertEqual(app._read_plugins_manifest(), old)


if __name__ == "__main__":
    unittest.main()
