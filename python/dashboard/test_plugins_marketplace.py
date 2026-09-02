"""Tests for the /api/plugins/marketplace endpoint and its helpers in app.py.

The catalog is a static, pre-generated JSON file (plugins-catalog.json) at the
package root; app.py reads and validates it (hand-rolled, no jsonschema),
annotates each entry with installed-plugin status from the plugins.json
manifest, and serves it via GET /api/plugins/marketplace -- always 200, with
catalogError set and entries [] when the catalog is missing or invalid.

Run: .venv/bin/python -m unittest python.dashboard.test_plugins_marketplace -v
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
            "pricing": {"model": "free"},
            "tags": ["maintenance"],
        }
    ],
}


class MarketplaceTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = Path(self._tmp.name)
        self._orig_catalog = app.PLUGIN_CATALOG_PATH
        self._orig_manifest = app.PLUGINS_MANIFEST_PATH
        app.PLUGIN_CATALOG_PATH = d / "plugins-catalog.json"
        app.PLUGINS_MANIFEST_PATH = d / "plugins.json"

    def tearDown(self):
        app.PLUGIN_CATALOG_PATH = self._orig_catalog
        app.PLUGINS_MANIFEST_PATH = self._orig_manifest
        self._tmp.cleanup()

    def _write_catalog(self, text_or_doc):
        if isinstance(text_or_doc, str):
            app.PLUGIN_CATALOG_PATH.write_text(text_or_doc, encoding="utf-8")
        else:
            app.PLUGIN_CATALOG_PATH.write_text(
                json.dumps(text_or_doc, indent=2) + "\n", encoding="utf-8"
            )

    def _write_manifest(self, entries):
        app.PLUGINS_MANIFEST_PATH.write_text(
            json.dumps(entries, indent=2) + "\n", encoding="utf-8"
        )

    def _get_marketplace(self):
        resp = app.app.test_client().get("/api/plugins/marketplace")
        return resp


class ValidCatalogTest(MarketplaceTestBase):
    def setUp(self):
        super().setUp()
        self._write_catalog(copy.deepcopy(GOOD_CATALOG))

    def test_read_plugin_catalog_returns_doc_and_none(self):
        doc, err = app._read_plugin_catalog()
        self.assertIsNone(err)
        self.assertEqual(doc["catalog_version"], 1)
        self.assertEqual(len(doc["plugins"]), 1)
        self.assertEqual(doc["plugins"][0]["id"], "agent-manager-hygiene")

    def test_endpoint_200_with_one_entry(self):
        resp = self._get_marketplace()
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIsNone(data["catalogError"])
        self.assertEqual(len(data["entries"]), 1)
        self.assertEqual(data["entries"][0]["id"], "agent-manager-hygiene")
        self.assertIsInstance(data["pluginsDir"], str)


class MissingCatalogTest(MarketplaceTestBase):
    """The path points into the temp dir but the file is absent."""

    def test_read_plugin_catalog_returns_empty_dict_and_error(self):
        doc, err = app._read_plugin_catalog()
        self.assertEqual(doc, {})
        self.assertIsInstance(err, str)
        self.assertTrue(err)

    def test_endpoint_200_with_catalogError_and_no_entries(self):
        resp = self._get_marketplace()
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIsInstance(data["catalogError"], str)
        self.assertTrue(data["catalogError"])
        self.assertEqual(data["entries"], [])


class MalformedCatalogTest(MarketplaceTestBase):
    def _check_malformed(self, content):
        self._write_catalog(content)
        doc, err = app._read_plugin_catalog()
        self.assertEqual(doc, {})
        self.assertIsInstance(err, str)
        self.assertTrue(err)
        resp = self._get_marketplace()
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["catalogError"])
        self.assertEqual(data["entries"], [])

    def test_invalid_json(self):
        self._check_malformed("{not json")

    def test_valid_json_bad_shape(self):
        self._check_malformed(json.dumps({"plugins": {"not": "a list"}}))


class InstalledStatusTest(MarketplaceTestBase):
    def setUp(self):
        super().setUp()
        self._write_catalog(copy.deepcopy(GOOD_CATALOG))

    def _entry_for(self, name):
        resp = self._get_marketplace()
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        matches = [e for e in data["entries"] if e["name"] == name]
        self.assertEqual(len(matches), 1)
        return matches[0]

    def test_installed_old_version_update_available(self):
        self._write_manifest([
            {"name": "agent-manager-hygiene",
             "registerPath": "/x/register.js", "enabled": True, "version": "0.9.0"}
        ])
        entry = self._entry_for("agent-manager-hygiene")
        self.assertTrue(entry["installed"])
        self.assertEqual(entry["installedVersion"], "0.9.0")
        self.assertTrue(entry["updateAvailable"])

    def test_installed_same_version_no_update(self):
        self._write_manifest([
            {"name": "agent-manager-hygiene",
             "registerPath": "/x/register.js", "enabled": True, "version": "1.0.0"}
        ])
        entry = self._entry_for("agent-manager-hygiene")
        self.assertTrue(entry["installed"])
        self.assertEqual(entry["installedVersion"], "1.0.0")
        self.assertFalse(entry["updateAvailable"])

    def test_manifest_name_mismatch_not_installed(self):
        self._write_manifest([
            {"name": "some-other-plugin",
             "registerPath": "/y/register.js", "enabled": True, "version": "0.1.0"}
        ])
        entry = self._entry_for("agent-manager-hygiene")
        self.assertFalse(entry["installed"])
        self.assertIsNone(entry["installedVersion"])
        self.assertFalse(entry["updateAvailable"])

    def test_manifest_entry_lacking_version(self):
        self._write_manifest([
            {"name": "agent-manager-hygiene",
             "registerPath": "/x/register.js", "enabled": True}
        ])
        entry = self._entry_for("agent-manager-hygiene")
        self.assertTrue(entry["installed"])
        self.assertIsNone(entry["installedVersion"])
        self.assertFalse(entry["updateAvailable"])


class ValidatorTest(MarketplaceTestBase):
    def _good_doc(self):
        return copy.deepcopy(GOOD_CATALOG)

    def test_accepts_good_catalog(self):
        self.assertIsNone(app.validate_plugin_catalog(self._good_doc()))

    def test_rejects_wrong_top_level_keys(self):
        doc = self._good_doc()
        doc["extra_key"] = 1
        err = app.validate_plugin_catalog(doc)
        self.assertIsInstance(err, str)
        self.assertTrue(err)

    def test_rejects_non_int_catalog_version(self):
        doc = self._good_doc()
        doc["catalog_version"] = "1"
        err = app.validate_plugin_catalog(doc)
        self.assertIsInstance(err, str)
        self.assertTrue(err)

    def test_rejects_bad_generated_at(self):
        doc = self._good_doc()
        doc["generated_at"] = "not a timestamp"
        err = app.validate_plugin_catalog(doc)
        self.assertIsInstance(err, str)
        self.assertTrue(err)

    def test_rejects_duplicate_plugin_ids(self):
        doc = self._good_doc()
        doc["plugins"].append(copy.deepcopy(doc["plugins"][0]))
        err = app.validate_plugin_catalog(doc)
        self.assertIsInstance(err, str)
        self.assertTrue(err)

    def test_rejects_svn_source_type(self):
        doc = self._good_doc()
        doc["plugins"][0]["source"]["type"] = "svn"
        err = app.validate_plugin_catalog(doc)
        self.assertIsInstance(err, str)
        self.assertTrue(err)

    def test_rejects_one_time_pricing_without_amount_cents(self):
        doc = self._good_doc()
        doc["plugins"][0]["pricing"] = {"model": "one-time"}
        err = app.validate_plugin_catalog(doc)
        self.assertIsInstance(err, str)
        self.assertTrue(err)

    def test_rejects_non_dict_doc(self):
        err = app.validate_plugin_catalog(["not", "a", "dict"])
        self.assertIsInstance(err, str)
        self.assertTrue(err)


class VersionHelpersTest(MarketplaceTestBase):
    def test_version_tuple_ordering(self):
        self.assertGreater(app._version_tuple("1.0.0"), app._version_tuple("0.9.0"))
        self.assertLess(app._version_tuple("0.9.0"), app._version_tuple("1.0.0"))
        self.assertEqual(app._version_tuple("1.0.0"), app._version_tuple("1.0.0"))
        self.assertEqual(app._version_tuple("garbage"), (0,))
        self.assertEqual(app._version_tuple(None), (0,))

    def test_installed_plugin_version_lookup(self):
        manifest = [
            {"name": "a", "version": "2.0.0"},
            {"name": "b"},
        ]
        self.assertEqual(app._installed_plugin_version(manifest, "a"), "2.0.0")
        self.assertIsNone(app._installed_plugin_version(manifest, "b"))
        self.assertIsNone(app._installed_plugin_version(manifest, "missing"))
        self.assertIsNone(app._installed_plugin_version([], "a"))


if __name__ == "__main__":
    unittest.main()
