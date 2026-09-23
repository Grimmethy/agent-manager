"""Tests for GET /api/plugins/<name>/ui/<filename> and its resolver, app._resolve_plugin_ui_asset
(Docs/hub-tasks-extraction-plan.md section 5, piece 2: the core-served plugin UI file route).

Piece 1 (test_plugins_manifest.py) built the tab schema; this piece serves the .js/.css
files a declared tab points at, from the plugin's own ui/ directory, refusing anything for
a plugin that isn't enabled or hasn't declared a valid tab, and refusing traversal or
symlink escapes out of ui/.

Run: .venv/bin/python -m unittest python.dashboard.test_plugin_ui_asset_route -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


GOOD_TAB = {"key": "hub-tasks", "label": "Hub Tasks", "kind": "script", "script": "ui/hub-tasks.js"}


class PluginUiAssetTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._root = Path(self._tmp.name)

        self._plugin_dir = self._root / "hub-tasks-plugin"
        self._ui_dir = self._plugin_dir / "ui"
        self._ui_dir.mkdir(parents=True)
        (self._plugin_dir / "register.js").write_text("module.exports = {};\n", encoding="utf-8")
        (self._ui_dir / "hub-tasks.js").write_text("console.log('hub tasks tab');\n", encoding="utf-8")
        (self._ui_dir / "hub-tasks.css").write_text(".hub-tasks { color: red; }\n", encoding="utf-8")

        self._orig_manifest = app.PLUGINS_MANIFEST_PATH
        app.PLUGINS_MANIFEST_PATH = self._root / "plugins.json"
        self.client = app.app.test_client()

    def tearDown(self):
        app.PLUGINS_MANIFEST_PATH = self._orig_manifest
        self._tmp.cleanup()

    def _write_manifest(self, entries):
        app._write_plugins_manifest(entries)

    def _entry(self, **overrides):
        entry = {
            "name": "hub-tasks-plugin",
            "registerPath": str(self._plugin_dir / "register.js"),
            "enabled": True,
            "description": "",
            "tab": GOOD_TAB,
        }
        entry.update(overrides)
        return entry


class ResolvePluginUiAssetTest(PluginUiAssetTestBase):
    def test_resolves_declared_script(self):
        self._write_manifest([self._entry()])
        path, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "hub-tasks.js")
        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertEqual(path, self._ui_dir / "hub-tasks.js")

    def test_resolves_css_alongside_the_script(self):
        self._write_manifest([self._entry()])
        path, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "hub-tasks.css")
        self.assertIsNone(error)
        self.assertEqual(path, self._ui_dir / "hub-tasks.css")

    def test_unknown_plugin(self):
        self._write_manifest([])
        _, error, status = app._resolve_plugin_ui_asset("nope", "hub-tasks.js")
        self.assertEqual(status, 404)
        self.assertIn("no plugin named", error)

    def test_disabled_plugin_is_refused(self):
        self._write_manifest([self._entry(enabled=False)])
        _, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "hub-tasks.js")
        self.assertEqual(status, 404)
        self.assertIn("not enabled", error)

    def test_plugin_without_a_tab_is_refused(self):
        entry = self._entry()
        del entry["tab"]
        self._write_manifest([entry])
        _, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "hub-tasks.js")
        self.assertEqual(status, 404)
        self.assertIn("no valid tab", error)

    def test_plugin_with_malformed_tab_is_refused(self):
        self._write_manifest([self._entry(tab={"key": "hub-tasks"})])
        _, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "hub-tasks.js")
        self.assertEqual(status, 404)
        self.assertIn("no valid tab", error)

    def test_wrong_extension_is_refused(self):
        self._write_manifest([self._entry()])
        (self._ui_dir / "secrets.env").write_text("TOKEN=x\n", encoding="utf-8")
        _, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "secrets.env")
        self.assertEqual(status, 400)
        self.assertIn("only .js and .css", error)

    def test_missing_file_is_404(self):
        self._write_manifest([self._entry()])
        _, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "does-not-exist.js")
        self.assertEqual(status, 404)

    def test_traversal_with_dotdot_is_refused(self):
        self._write_manifest([self._entry()])
        secret = self._root / "outside.js"
        secret.write_text("evil\n", encoding="utf-8")
        _, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "../outside.js")
        self.assertEqual(status, 400)
        self.assertIn("no '..' segments", error)

    def test_symlink_escape_is_refused(self):
        outside_dir = self._root / "outside"
        outside_dir.mkdir()
        secret = outside_dir / "secret.js"
        secret.write_text("evil\n", encoding="utf-8")
        (self._ui_dir / "linked.js").symlink_to(secret)
        self._write_manifest([self._entry()])
        _, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "linked.js")
        self.assertEqual(status, 403)
        self.assertIn("escapes", error)

    def test_no_register_path_is_refused(self):
        entry = self._entry()
        del entry["registerPath"]
        self._write_manifest([entry])
        _, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "hub-tasks.js")
        self.assertEqual(status, 404)
        self.assertIn("no registerPath", error)


class ManifestTabsKillSwitchTest(PluginUiAssetTestBase):
    """AGENT_MANAGER_MANIFEST_TABS=false turns the whole feature back off (section 5),
    without touching plugins.json -- checked both by the resolver's own gate and by the
    GET /api/plugins flag the tab-bar merge reads."""

    def setUp(self):
        super().setUp()
        self._orig_env_var = os.environ.get("AGENT_MANAGER_MANIFEST_TABS")

    def tearDown(self):
        if self._orig_env_var is None:
            os.environ.pop("AGENT_MANAGER_MANIFEST_TABS", None)
        else:
            os.environ["AGENT_MANAGER_MANIFEST_TABS"] = self._orig_env_var
        super().tearDown()

    def test_enabled_by_default(self):
        self.assertTrue(app._manifest_tabs_enabled())

    def test_disabled_by_env_var(self):
        os.environ["AGENT_MANAGER_MANIFEST_TABS"] = "false"
        self.assertFalse(app._manifest_tabs_enabled())

    def test_case_insensitive_and_whitespace_tolerant(self):
        os.environ["AGENT_MANAGER_MANIFEST_TABS"] = "  FALSE  "
        self.assertFalse(app._manifest_tabs_enabled())

    def test_resolver_refuses_a_valid_tab_when_disabled(self):
        os.environ["AGENT_MANAGER_MANIFEST_TABS"] = "false"
        self._write_manifest([self._entry()])
        _, error, status = app._resolve_plugin_ui_asset("hub-tasks-plugin", "hub-tasks.js")
        self.assertEqual(status, 404)
        self.assertIn("disabled", error)

    def test_get_plugins_reports_the_flag(self):
        self._write_manifest([self._entry()])
        resp = self.client.get("/api/plugins")
        self.assertEqual(resp.get_json()["manifestTabsEnabled"], True)
        os.environ["AGENT_MANAGER_MANIFEST_TABS"] = "false"
        resp = self.client.get("/api/plugins")
        self.assertEqual(resp.get_json()["manifestTabsEnabled"], False)


class PluginUiAssetRouteTest(PluginUiAssetTestBase):
    def test_serves_js_with_javascript_mimetype(self):
        self._write_manifest([self._entry()])
        resp = self.client.get("/api/plugins/hub-tasks-plugin/ui/hub-tasks.js")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.mimetype, "application/javascript")
        self.assertIn(b"hub tasks tab", resp.data)

    def test_serves_css_with_css_mimetype(self):
        self._write_manifest([self._entry()])
        resp = self.client.get("/api/plugins/hub-tasks-plugin/ui/hub-tasks.css")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.mimetype, "text/css")

    def test_disabled_plugin_route_is_404(self):
        self._write_manifest([self._entry(enabled=False)])
        resp = self.client.get("/api/plugins/hub-tasks-plugin/ui/hub-tasks.js")
        self.assertEqual(resp.status_code, 404)

    def test_symlink_escape_route_is_403(self):
        outside_dir = self._root / "outside"
        outside_dir.mkdir()
        secret = outside_dir / "secret.js"
        secret.write_text("evil\n", encoding="utf-8")
        (self._ui_dir / "linked.js").symlink_to(secret)
        self._write_manifest([self._entry()])
        resp = self.client.get("/api/plugins/hub-tasks-plugin/ui/linked.js")
        self.assertEqual(resp.status_code, 403)


if __name__ == "__main__":
    unittest.main()
