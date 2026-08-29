"""Tests for the Plugins tab's manifest helpers in app.py (Grimmethy, 2026-08-29:
"I need to be able to enable/disable the plugins inside the plugins tab").

plugins.json is the contract shared with src/plugins-manifest.js (the JS reader
config.js's ensureRegistered() uses); these tests pin the seed-from-env migration and
the read/write round-trip on the Python side.

Run: .venv/bin/python -m unittest python.dashboard.test_plugins_manifest -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class PluginsManifestTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = Path(self._tmp.name)
        self._orig_manifest = app.PLUGINS_MANIFEST_PATH
        self._orig_env = app.ENV_FILE_PATH
        app.PLUGINS_MANIFEST_PATH = d / "plugins.json"
        app.ENV_FILE_PATH = d / "agent-manager.env"

    def tearDown(self):
        app.PLUGINS_MANIFEST_PATH = self._orig_manifest
        app.ENV_FILE_PATH = self._orig_env
        self._tmp.cleanup()

    def _write_env(self, text):
        app.ENV_FILE_PATH.write_text(text, encoding="utf-8")

    def test_seed_from_register_path_when_no_manifest(self):
        self._write_env(
            "AGENT_MANAGER_REPO_ROOT=/x\n"
            "AGENT_MANAGER_REGISTER_PATH=/a/agent-manager-hygiene/register.js,/b/other-plugin/register.js\n"
        )
        manifest = app._read_plugins_manifest()
        self.assertEqual([p["name"] for p in manifest], ["agent-manager-hygiene", "other-plugin"])
        self.assertTrue(all(p["enabled"] for p in manifest))
        self.assertEqual(manifest[0]["registerPath"], "/a/agent-manager-hygiene/register.js")
        # seeding wrote the file, so a second read is a straight load (no re-seed)
        self.assertTrue(app.PLUGINS_MANIFEST_PATH.is_file())
        self.assertEqual(app._read_plugins_manifest(), manifest)

    def test_seed_empty_when_no_register_path(self):
        self._write_env("AGENT_MANAGER_REPO_ROOT=/x\n")
        self.assertEqual(app._read_plugins_manifest(), [])
        self.assertEqual(json.loads(app.PLUGINS_MANIFEST_PATH.read_text()), [])

    def test_seed_dedupes_repeated_paths(self):
        self._write_env("AGENT_MANAGER_REGISTER_PATH=/a/p/register.js,/a/p/register.js\n")
        self.assertEqual(len(app._read_plugins_manifest()), 1)

    def test_read_returns_empty_list_on_malformed_manifest(self):
        app.PLUGINS_MANIFEST_PATH.write_text("{not json", encoding="utf-8")
        self.assertEqual(app._read_plugins_manifest(), [])

    def test_write_round_trips(self):
        entries = [{"name": "x", "registerPath": "/x/register.js", "enabled": False, "description": "d"}]
        app._write_plugins_manifest(entries)
        self.assertEqual(app._read_plugins_manifest(), entries)

    def test_plugin_name_from_path(self):
        self.assertEqual(app._plugin_name_from_path("/media/x/agent-manager-hygiene/register.js"), "agent-manager-hygiene")
        self.assertEqual(app._plugin_name_from_path("/media/x/imagegen/register.js"), "imagegen")


if __name__ == "__main__":
    unittest.main()
