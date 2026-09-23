"""Tests for POST /api/plugins/add accepting an optional 'tab' declaration (Docs/
hub-tasks-extraction-plan.md section 5, piece 1: manifest schema + GET /api/plugins).

A register.js-only plugin (no server slot) declares its dashboard tab this way. An
invalid tab is rejected with 400 before anything is written; GET /api/plugins then
returns it as part of the raw manifest entry, same as any other field.

Run: .venv/bin/python -m unittest python.dashboard.test_plugins_add_tab -v
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class PluginsAddTabTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = Path(self._tmp.name)
        self._orig_manifest = app.PLUGINS_MANIFEST_PATH
        app.PLUGINS_MANIFEST_PATH = d / "plugins.json"
        app._write_plugins_manifest([])

        # api_plugins_add requires registerPath to be an existing .js file.
        self._register_js = d / "register.js"
        self._register_js.write_text("module.exports = {};\n", encoding="utf-8")

        self.client = app.app.test_client()

    def tearDown(self):
        app.PLUGINS_MANIFEST_PATH = self._orig_manifest
        self._tmp.cleanup()

    def _post_add(self, **body):
        body.setdefault("registerPath", str(self._register_js))
        body.setdefault("name", "hub-tasks-plugin")
        return self.client.post("/api/plugins/add", json=body)

    def test_add_without_tab_is_unaffected(self):
        resp = self._post_add()
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("tab", resp.get_json()["plugin"])

    def test_add_with_valid_tab_is_stored_and_returned(self):
        tab = {"key": "hub-tasks", "label": "Hub Tasks", "kind": "script", "script": "ui/hub-tasks.js"}
        resp = self._post_add(tab=tab)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["plugin"]["tab"], tab)

        manifest = app._read_plugins_manifest()
        self.assertEqual(manifest[0]["tab"], tab)

        # GET /api/plugins is a raw passthrough of the manifest -- the tab rides along.
        get_resp = self.client.get("/api/plugins")
        self.assertEqual(get_resp.get_json()["plugins"][0]["tab"], tab)

    def test_add_with_invalid_tab_is_rejected_and_nothing_written(self):
        resp = self._post_add(tab={"key": "hub-tasks"})  # missing label/kind/script
        self.assertEqual(resp.status_code, 400)
        self.assertIn(b"tab:", resp.data)
        self.assertEqual(app._read_plugins_manifest(), [])


if __name__ == "__main__":
    unittest.main()
