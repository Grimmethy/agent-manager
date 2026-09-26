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

    def test_tab_passes_through_read(self):
        tab = {"key": "hub-tasks", "label": "Hub Tasks", "kind": "script", "script": "ui/hub-tasks.js"}
        entry = {"name": "x", "registerPath": "/x/register.js", "enabled": True, "description": "", "tab": tab}
        app._write_plugins_manifest([entry])
        self.assertEqual(app._read_plugins_manifest()[0]["tab"], tab)


class ResolvePluginRootTest(unittest.TestCase):
    """S5a of the hub-tasks extraction (2026-09-25) -- the Python-side twin of
    src/resolve-plugin-root.js's test coverage. Corrects the same real gap: the ORIGINAL
    resolution this generalizes, `.split(",")[0]`, could only ever find the FIRST
    comma-separated AGENT_MANAGER_REGISTER_PATH entry."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = Path(self._tmp.name)
        self._orig_manifest = app.PLUGINS_MANIFEST_PATH
        app.PLUGINS_MANIFEST_PATH = d / "plugins.json"

    def tearDown(self):
        app.PLUGINS_MANIFEST_PATH = self._orig_manifest
        self._tmp.cleanup()

    def test_finds_a_plugin_by_name_regardless_of_position(self):
        app._write_plugins_manifest([
            {"name": "agent-manager-hygiene", "registerPath": "/plugins/agent-manager-hygiene/register.js", "enabled": True},
            {"name": "agent-manager-hub-tasks", "registerPath": "/plugins/agent-manager-hub-tasks/register.js", "enabled": True},
        ])
        self.assertEqual(app._resolve_plugin_root("agent-manager-hygiene"), Path("/plugins/agent-manager-hygiene"))
        # The whole point of S5a: a SECOND, non-first plugin resolves too.
        self.assertEqual(app._resolve_plugin_root("agent-manager-hub-tasks"), Path("/plugins/agent-manager-hub-tasks"))

    def test_returns_none_for_a_plugin_not_in_the_manifest(self):
        app._write_plugins_manifest([{"name": "agent-manager-hygiene", "registerPath": "/plugins/agent-manager-hygiene/register.js", "enabled": True}])
        self.assertIsNone(app._resolve_plugin_root("agent-manager-doesnt-exist"))

    def test_returns_none_for_a_disabled_plugin(self):
        app._write_plugins_manifest([{"name": "agent-manager-hygiene", "registerPath": "/plugins/agent-manager-hygiene/register.js", "enabled": False}])
        self.assertIsNone(app._resolve_plugin_root("agent-manager-hygiene"))

    def test_returns_none_for_an_entry_missing_register_path(self):
        app._write_plugins_manifest([{"name": "agent-manager-hardware-plugin", "slot": "hardware-tab", "enabled": True}])
        self.assertIsNone(app._resolve_plugin_root("agent-manager-hardware-plugin"))


class ValidatePluginTabTest(unittest.TestCase):
    """Docs/hub-tasks-extraction-plan.md section 5: a plugins.json entry may carry
    `tab: {key, label, description?, group?, kind:'script', script:'ui/<file>.js',
    replaces?}` so its dashboard tab is served from the plugin's own repo. This is the
    schema gate every later piece (static-file route, tab-bar merge, renderer dispatch)
    relies on to treat a malformed tab as absent rather than crashing."""

    def _valid(self, **overrides):
        tab = {"key": "hub-tasks", "label": "Hub Tasks", "kind": "script", "script": "ui/hub-tasks.js"}
        tab.update(overrides)
        return tab

    def test_valid_minimal_tab(self):
        self.assertIsNone(app._validate_plugin_tab(self._valid()))

    def test_valid_with_all_optional_fields(self):
        tab = self._valid(description="Hub coordination", group="Job Status", replaces="coordinating")
        self.assertIsNone(app._validate_plugin_tab(tab))

    def test_not_a_dict(self):
        self.assertEqual(app._validate_plugin_tab("hub-tasks"), "tab must be an object")
        self.assertEqual(app._validate_plugin_tab(None), "tab must be an object")

    def test_unknown_key_rejected(self):
        err = app._validate_plugin_tab(self._valid(icon="star"))
        self.assertIn("unknown key", err)
        self.assertIn("icon", err)

    def test_missing_or_empty_key(self):
        tab = self._valid()
        del tab["key"]
        self.assertEqual(app._validate_plugin_tab(tab), "tab.key must be a non-empty string")
        self.assertEqual(app._validate_plugin_tab(self._valid(key="  ")), "tab.key must be a non-empty string")

    def test_missing_or_empty_label(self):
        tab = self._valid()
        del tab["label"]
        self.assertEqual(app._validate_plugin_tab(tab), "tab.label must be a non-empty string")

    def test_kind_must_be_script(self):
        self.assertEqual(
            app._validate_plugin_tab(self._valid(kind="iframe")),
            "tab.kind must be 'script' (the only supported kind)",
        )

    def test_script_must_be_non_empty_string(self):
        self.assertEqual(
            app._validate_plugin_tab(self._valid(script="")),
            "tab.script must be a non-empty string",
        )

    def test_script_must_be_relative(self):
        self.assertEqual(
            app._validate_plugin_tab(self._valid(script="/etc/passwd")),
            "tab.script must be a relative path with no '..' segments",
        )

    def test_script_rejects_path_traversal(self):
        self.assertEqual(
            app._validate_plugin_tab(self._valid(script="ui/../../../etc/passwd")),
            "tab.script must be a relative path with no '..' segments",
        )

    def test_script_must_be_under_ui_dir(self):
        self.assertEqual(
            app._validate_plugin_tab(self._valid(script="static/hub-tasks.js")),
            "tab.script must be under 'ui/' and end in '.js'",
        )

    def test_script_must_end_in_js(self):
        self.assertEqual(
            app._validate_plugin_tab(self._valid(script="ui/hub-tasks.py")),
            "tab.script must be under 'ui/' and end in '.js'",
        )

    def test_optional_string_fields_reject_empty(self):
        for field in ("description", "group", "replaces"):
            with self.subTest(field=field):
                err = app._validate_plugin_tab(self._valid(**{field: "  "}))
                self.assertEqual(err, f"tab.{field} must be a non-empty string")


if __name__ == "__main__":
    unittest.main()
