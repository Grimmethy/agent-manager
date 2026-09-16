"""Tests for the POST /api/plugins/update endpoint in routes/plugins.py.

Mirrors test_plugins_marketplace.py's setUp/tearDown pattern of monkeypatching
app.PLUGINS_MANIFEST_PATH and app.PLUGIN_CATALOG_PATH to a tempdir. The update route
also shells out to git/npm via app._run_plugin_subprocess and touches the real
pipeline via app._pipeline_running/_restart_pipeline -- both are monkeypatched to
no-op recorders here so no real git/npm/pipeline calls ever happen.

Run: .venv/bin/python -m unittest python.dashboard.test_plugins_update -v
"""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


GOOD_CATALOG = {
    "catalog_version": 1,
    "generated_at": "2025-01-15T00:00:00Z",
    "plugins": [
        {
            "id": "agent-manager-hygiene",
            "name": "Agent Manager Hygiene",
            "summary": "Keeps the agent manager tidy",
            "description": "Hygiene plugin for agent-manager",
            "source": {
                "type": "git",
                "url": "https://example.com/agent-manager-hygiene.git",
                "ref": "main",
            },
            "version": "1.0.0",
        }
    ],
}


class PluginsUpdateTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = Path(self._tmp.name)

        self._orig_catalog = app.PLUGIN_CATALOG_PATH
        self._orig_manifest = app.PLUGINS_MANIFEST_PATH
        self._orig_install_dir_default = app.PLUGINS_INSTALL_DIR_DEFAULT
        self._orig_pipeline_running = app._pipeline_running
        self._orig_restart_pipeline = app._restart_pipeline
        self._orig_run_subprocess = app._run_plugin_subprocess

        app.PLUGIN_CATALOG_PATH = d / "plugins-catalog.json"
        app.PLUGINS_MANIFEST_PATH = d / "plugins.json"
        app.PLUGINS_INSTALL_DIR_DEFAULT = d / "plugins"
        (d / "plugins").mkdir(parents=True, exist_ok=True)

        # No real pipeline is ever touched.
        app._pipeline_running = lambda: False
        self.restart_calls = []
        app._restart_pipeline = lambda: self.restart_calls.append(True)

        # No real git/npm subprocess ever runs -- record the args instead.
        self.subprocess_calls = []

        def _fake_run_plugin_subprocess(args, cwd):
            self.subprocess_calls.append((list(args), str(cwd)))
            return "", ""

        app._run_plugin_subprocess = _fake_run_plugin_subprocess

    def tearDown(self):
        app.PLUGIN_CATALOG_PATH = self._orig_catalog
        app.PLUGINS_MANIFEST_PATH = self._orig_manifest
        app.PLUGINS_INSTALL_DIR_DEFAULT = self._orig_install_dir_default
        app._pipeline_running = self._orig_pipeline_running
        app._restart_pipeline = self._orig_restart_pipeline
        app._run_plugin_subprocess = self._orig_run_subprocess
        self._tmp.cleanup()

    def _write_catalog(self, doc):
        app.PLUGIN_CATALOG_PATH.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    def _write_manifest(self, entries):
        app.PLUGINS_MANIFEST_PATH.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")

    def _manifest_entry(self, plugin_id="agent-manager-hygiene", version="1.0.0"):
        return {
            "name": plugin_id,
            "version": version,
            "source": {"type": "git", "url": "https://example.com/agent-manager-hygiene.git", "ref": "main"},
            "enabled": True,
        }

    def _install_plugin_dir(self, plugin_id="agent-manager-hygiene"):
        d = app.PLUGINS_INSTALL_DIR_DEFAULT / plugin_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _post_update(self, plugin_id="agent-manager-hygiene"):
        return app.app.test_client().post("/api/plugins/update", json={"id": plugin_id})


class NoChangeTest(PluginsUpdateTestBase):
    def setUp(self):
        super().setUp()
        self._write_catalog(copy.deepcopy(GOOD_CATALOG))  # version 1.0.0
        self._write_manifest([self._manifest_entry(version="1.0.0")])
        self._install_plugin_dir()

    def test_no_change_returns_no_op_response(self):
        resp = self._post_update()
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertFalse(data["updated"])
        self.assertIn("no update", data.get("reason", "").lower())

    def test_no_change_manifest_file_unchanged_on_disk(self):
        before = app.PLUGINS_MANIFEST_PATH.read_text(encoding="utf-8")
        self._post_update()
        after = app.PLUGINS_MANIFEST_PATH.read_text(encoding="utf-8")
        self.assertEqual(before, after)

    def test_no_change_no_subprocess_calls_recorded(self):
        self._post_update()
        self.assertEqual(self.subprocess_calls, [])


class VersionBumpTest(PluginsUpdateTestBase):
    def setUp(self):
        super().setUp()
        catalog = copy.deepcopy(GOOD_CATALOG)
        catalog["plugins"][0]["version"] = "2.0.0"
        self._write_catalog(catalog)
        self._write_manifest([self._manifest_entry(version="1.0.0")])
        self._install_plugin_dir()

    def test_newer_catalog_version_updates_and_reports_versions(self):
        resp = self._post_update()
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["updated"])
        self.assertEqual(data["installedVersion"], "1.0.0")
        self.assertEqual(data["latestVersion"], "2.0.0")

    def test_newer_catalog_version_manifest_bumped_on_disk(self):
        self._post_update()
        manifest = json.loads(app.PLUGINS_MANIFEST_PATH.read_text(encoding="utf-8"))
        entry = next(p for p in manifest if p["name"] == "agent-manager-hygiene")
        self.assertEqual(entry["version"], "2.0.0")

    def test_newer_catalog_version_invokes_update_and_npm_install(self):
        self._post_update()
        # git fetch, a git checkout (ref or version), then npm install -- at minimum a
        # checkout attempt and the final npm install must both have run.
        self.assertTrue(any(c[0][:2] == ["git", "fetch"] for c in self.subprocess_calls))
        self.assertTrue(any(c[0][:2] == ["git", "checkout"] for c in self.subprocess_calls))
        self.assertTrue(any(c[0] == ["npm", "install"] for c in self.subprocess_calls))


class NotInstalledOrNotInCatalogTest(PluginsUpdateTestBase):
    def setUp(self):
        super().setUp()
        self._write_catalog(copy.deepcopy(GOOD_CATALOG))

    def test_id_not_installed_404(self):
        self._write_manifest([])
        resp = self._post_update("agent-manager-hygiene")
        self.assertEqual(resp.status_code, 404)

    def test_id_not_in_catalog_404(self):
        self._write_manifest([self._manifest_entry(plugin_id="not-in-catalog")])
        resp = self._post_update("not-in-catalog")
        self.assertEqual(resp.status_code, 404)


if __name__ == "__main__":
    unittest.main()
