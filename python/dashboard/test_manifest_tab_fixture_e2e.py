"""End-to-end proof for the manifest-driven dashboard tab (piece 6 of 6; Docs/
hub-tasks-extraction-plan.md section 5; documented in docs/PLUGIN_API.md's "Dashboard tab"
section), using the real fixture plugin at test-fixtures/manifest-tab-example-plugin/ --
not a mock built in setUp like the piece 1-5 unit tests. This is the serving half: proves
core registers the fixture, serves its exact on-disk bytes back through the real route, and
gates that route correctly on enabled/disabled and the AGENT_MANAGER_MANIFEST_TABS kill
switch. scripts/manifest-tab-fixture-e2e.test.js is the consuming half, running that same
file's content for real through core-ui.js's renderer dispatch.

Run: .venv/bin/python -m unittest python.dashboard.test_manifest_tab_fixture_e2e -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "test-fixtures" / "manifest-tab-example-plugin"
FIXTURE_REGISTER_JS = FIXTURE_DIR / "register.js"
FIXTURE_UI_JS = FIXTURE_DIR / "ui" / "example-tab.js"

FIXTURE_TAB = {
    "key": "example-tab",
    "label": "Example Tab",
    "kind": "script",
    "script": "ui/example-tab.js",
}


class ManifestTabFixtureE2ETest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(FIXTURE_REGISTER_JS.is_file(), f"fixture missing: {FIXTURE_REGISTER_JS}")
        self.assertTrue(FIXTURE_UI_JS.is_file(), f"fixture missing: {FIXTURE_UI_JS}")

        self._tmp = tempfile.TemporaryDirectory()
        self._orig_manifest = app.PLUGINS_MANIFEST_PATH
        app.PLUGINS_MANIFEST_PATH = Path(self._tmp.name) / "plugins.json"
        app._write_plugins_manifest([])

        self._orig_env_var = os.environ.get("AGENT_MANAGER_MANIFEST_TABS")
        os.environ.pop("AGENT_MANAGER_MANIFEST_TABS", None)

        self.client = app.app.test_client()

    def tearDown(self):
        app.PLUGINS_MANIFEST_PATH = self._orig_manifest
        if self._orig_env_var is None:
            os.environ.pop("AGENT_MANAGER_MANIFEST_TABS", None)
        else:
            os.environ["AGENT_MANAGER_MANIFEST_TABS"] = self._orig_env_var
        self._tmp.cleanup()

    def _register_fixture(self):
        resp = self.client.post("/api/plugins/add", json={
            "registerPath": str(FIXTURE_REGISTER_JS),
            "name": "manifest-tab-example-plugin",
            "tab": FIXTURE_TAB,
        })
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()["plugin"]

    def test_full_lifecycle(self):
        # 1. Registering the real fixture through the real route stores and validates its
        #    tab exactly as declared.
        entry = self._register_fixture()
        self.assertEqual(entry["tab"], FIXTURE_TAB)

        # 2. GET /api/plugins reflects it, plus the kill-switch flag the tab-bar merge reads.
        listing = self.client.get("/api/plugins").get_json()
        plugin = next(p for p in listing["plugins"] if p["name"] == "manifest-tab-example-plugin")
        self.assertEqual(plugin["tab"], FIXTURE_TAB)
        self.assertTrue(listing["manifestTabsEnabled"])

        # 3. The served bytes are exactly the file on disk -- not a stand-in, not truncated.
        asset_url = "/api/plugins/manifest-tab-example-plugin/ui/example-tab.js"
        resp = self.client.get(asset_url)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.mimetype, "application/javascript")
        self.assertEqual(resp.data, FIXTURE_UI_JS.read_bytes())

        # 4. Disabling the plugin closes the route (piece 5's enable/disable lifecycle),
        #    without touching plugins.json's tab declaration itself.
        toggle = self.client.post("/api/plugins/toggle", json={"name": "manifest-tab-example-plugin", "enabled": False})
        self.assertEqual(toggle.status_code, 200)
        self.assertEqual(self.client.get(asset_url).status_code, 404)

        # 5. Re-enabling restores it, byte-for-byte.
        self.client.post("/api/plugins/toggle", json={"name": "manifest-tab-example-plugin", "enabled": True})
        resp = self.client.get(asset_url)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data, FIXTURE_UI_JS.read_bytes())

        # 6. The kill switch closes the route even though the plugin is enabled and its tab
        #    is valid -- and GET /api/plugins reports it, which is what the tab-bar merge
        #    (piece 3, client-side) relies on to drop every plugin tab at once.
        os.environ["AGENT_MANAGER_MANIFEST_TABS"] = "false"
        self.assertFalse(self.client.get("/api/plugins").get_json()["manifestTabsEnabled"])
        self.assertEqual(self.client.get(asset_url).status_code, 404)
        os.environ.pop("AGENT_MANAGER_MANIFEST_TABS", None)
        self.assertEqual(self.client.get(asset_url).status_code, 200)

    def test_fixture_is_not_served_before_it_is_registered(self):
        # No add call yet -- proves the route's own gate, not just that the fixture exists.
        resp = self.client.get("/api/plugins/manifest-tab-example-plugin/ui/example-tab.js")
        self.assertEqual(resp.status_code, 404)

    def test_fixture_script_declares_the_registered_tab_key_in_its_own_source(self):
        # Cross-checks the two halves of the fixture agree with each other: the tab.key
        # declared in plugins.json (what this test registers) must be the same key the
        # fixture's real JS source calls registerPluginTabRenderer with (what
        # manifest-tab-fixture-e2e.test.js, the JS half, actually exercises). If someone
        # edits one side of the fixture without the other, this catches it here rather
        # than as a silent mismatch only the JS test would notice.
        source = FIXTURE_UI_JS.read_text(encoding="utf-8")
        self.assertIn(f"registerPluginTabRenderer('{FIXTURE_TAB['key']}'", source)


if __name__ == "__main__":
    unittest.main()
