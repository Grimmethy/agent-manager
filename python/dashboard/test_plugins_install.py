"""Tests for the /api/plugins/install endpoint and its helpers in app.py.

The install route fetches a free catalog entry's source (git clone or npm install)
into the plugins install dir, then registers the resulting register.js in the
plugins manifest. Paid entries are rejected with 402, unknown ids 404, and an
already-registered name 409.

These tests stub app.subprocess.run so no real git/npm/network work happens, and
point the manifest/env/catalog paths and the plugins install dir at a tempdir.

Run: .venv/bin/python -m unittest python.dashboard.test_plugins_install -v
"""
import copy
import json
import os
import subprocess
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
            "id": "fake-git-plugin",
            "name": "Fake Git Plugin",
            "summary": "A free git plugin for tests",
            "description": "Free git-sourced plugin used by the install tests",
            "source": {
                "type": "git",
                "url": "https://example.com/fake.git",
                "ref": "main",
            },
            "version": "1.2.3",
            "pricing": {"model": "free"},
            "tags": ["testing"],
        },
        {
            "id": "fake-paid",
            "name": "Fake Paid Plugin",
            "summary": "A paid plugin for tests",
            "description": "Paid plugin used by the install tests",
            "source": {
                "type": "git",
                "url": "https://example.com/paid.git",
                "ref": "main",
            },
            "version": "2.0.0",
            "pricing": {"model": "one-time", "amount_cents": 1000, "currency": "USD"},
            "tags": ["testing"],
        },
    ],
}


class PluginsInstallTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = Path(self._tmp.name)

        self._orig_manifest = app.PLUGINS_MANIFEST_PATH
        self._orig_env = app.ENV_FILE_PATH
        self._orig_catalog = app.PLUGIN_CATALOG_PATH
        self._orig_plugins_dir_env = os.environ.get("AGENT_MANAGER_PLUGINS_DIR")
        self._orig_run = app.subprocess.run

        # Point the shared paths at the temp dir.
        app.PLUGINS_MANIFEST_PATH = d / "plugins.json"
        app.ENV_FILE_PATH = d / "agent-manager.env"
        app.PLUGIN_CATALOG_PATH = d / "plugins-catalog.json"

        # The plugins install dir lives in the temp dir too.
        self._install_dir = d / "install"
        self._install_dir.mkdir(parents=True, exist_ok=True)
        os.environ["AGENT_MANAGER_PLUGINS_DIR"] = str(self._install_dir)

        # Fake catalog + a clean (empty) manifest.
        app.PLUGIN_CATALOG_PATH.write_text(
            json.dumps(copy.deepcopy(GOOD_CATALOG), indent=2) + "\n", encoding="utf-8"
        )
        self._write_manifest([])

        # Stub out subprocess.run so git clone / npm install are no-ops.
        app.subprocess.run = lambda *a, **kw: subprocess.CompletedProcess(
            args=(a[0] if a else None), returncode=0, stdout="", stderr=""
        )

    def tearDown(self):
        app.PLUGINS_MANIFEST_PATH = self._orig_manifest
        app.ENV_FILE_PATH = self._orig_env
        app.PLUGIN_CATALOG_PATH = self._orig_catalog
        app.subprocess.run = self._orig_run
        if self._orig_plugins_dir_env is None:
            os.environ.pop("AGENT_MANAGER_PLUGINS_DIR", None)
        else:
            os.environ["AGENT_MANAGER_PLUGINS_DIR"] = self._orig_plugins_dir_env
        self._tmp.cleanup()

    def _write_manifest(self, entries):
        app.PLUGINS_MANIFEST_PATH.write_text(
            json.dumps(entries, indent=2) + "\n", encoding="utf-8"
        )

    def _precreate_register(self, plugin_id):
        """Create <installDir>/<id>/register.js so the locate step succeeds."""
        plugin_dir = self._install_dir / plugin_id
        plugin_dir.mkdir(parents=True, exist_ok=True)
        (plugin_dir / "register.js").write_text("module.exports = {};\n", encoding="utf-8")
        return plugin_dir / "register.js"

    def _post_install(self, plugin_id):
        return app.app.test_client().post(
            "/api/plugins/install", json={"id": plugin_id}
        )


class InstallFreeTest(PluginsInstallTestBase):
    def test_free_git_entry_installs_and_registers(self):
        register_js = self._precreate_register("fake-git-plugin")
        resp = self._post_install("fake-git-plugin")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["installed"])
        self.assertEqual(data["name"], "fake-git-plugin")

        manifest = app._read_plugins_manifest()
        matches = [p for p in manifest if p.get("name") == "fake-git-plugin"]
        self.assertEqual(len(matches), 1)
        entry = matches[0]
        self.assertEqual(entry["version"], "1.2.3")
        self.assertEqual(
            entry["source"],
            {"type": "git", "url": "https://example.com/fake.git", "ref": "main"},
        )
        self.assertTrue(entry["enabled"])
        self.assertEqual(entry["registerPath"], str(register_js))


class InstallPaidTest(PluginsInstallTestBase):
    def test_paid_entry_rejected_and_manifest_unchanged(self):
        before = app._read_plugins_manifest()
        resp = self._post_install("fake-paid")
        self.assertEqual(resp.status_code, 402)
        data = resp.get_json()
        self.assertIsInstance(data.get("error"), str)
        self.assertTrue(data["error"])
        # Nothing was written: manifest is unchanged and no install dir was made.
        self.assertEqual(app._read_plugins_manifest(), before)
        self.assertFalse((self._install_dir / "fake-paid").exists())


class InstallUnknownTest(PluginsInstallTestBase):
    def test_unknown_id_returns_404(self):
        resp = self._post_install("does-not-exist")
        self.assertEqual(resp.status_code, 404)
        data = resp.get_json()
        self.assertIsInstance(data.get("description"), str)
        self.assertTrue(data["description"])


class InstallDuplicateTest(PluginsInstallTestBase):
    def test_reinstall_of_present_name_returns_409(self):
        self._write_manifest([
            {"name": "fake-git-plugin", "registerPath": "/x/register.js", "enabled": True}
        ])
        resp = self._post_install("fake-git-plugin")
        self.assertEqual(resp.status_code, 409)
        data = resp.get_json()
        self.assertIsInstance(data.get("description"), str)
        self.assertTrue(data["description"])


if __name__ == "__main__":
    unittest.main()
