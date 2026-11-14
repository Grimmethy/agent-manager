"""Test that plugins.example.json entries pass the tab validation.

This test ensures that the example plugin configuration file contains entries
that would pass the existing validation in app_source_plugin_helpers._validate_plugin_tab.
"""

import json
import os
import sys
import unittest
from pathlib import Path

# Add the dashboard directory to the path so we can import app_source_plugin_helpers
sys.path.insert(0, str(Path(__file__).parent))

from app_source_plugin_helpers import _validate_plugin_tab


class TestPluginsExampleValidation(unittest.TestCase):
    """Validate that plugins.example.json entries pass tab validation."""

    @classmethod
    def setUpClass(cls):
        """Load plugins.example.json once for all tests."""
        example_path = Path(__file__).parent.parent.parent / "plugins.example.json"
        with open(example_path, "r") as f:
            cls.plugins = json.load(f)

    def test_all_entries_have_valid_tabs(self):
        """Every entry in plugins.example.json must have a valid tab."""
        for i, entry in enumerate(self.plugins):
            with self.subTest(entry=i):
                self.assertIn("name", entry, f"Entry {i} missing 'name'")
                self.assertIn("tab", entry, f"Entry {i} ({entry['name']}) missing 'tab'")
                error = _validate_plugin_tab(entry["tab"])
                self.assertIsNone(error, f"Entry {i} ({entry['name']}) has invalid tab: {error}")

    def test_gpu_broker_entry_structure(self):
        """The GPU broker entry has the documented structure."""
        gpu_broker = next(
            (e for e in self.plugins if e["name"] == "gpu-broker"),
            None,
        )
        self.assertIsNotNone(gpu_broker, "plugins.example.json must include gpu-broker")
        tab = gpu_broker["tab"]
        self.assertEqual(tab["key"], "gpu-broker")
        self.assertEqual(tab["label"], "🎛 GPU Cards")
        self.assertEqual(tab["kind"], "script")
        self.assertEqual(tab["script"], "ui/gpu-broker-tab.js")
        self.assertEqual(tab["group"], "Forges")

    def test_no_machine_specific_values(self):
        """plugins.example.json must not contain machine-specific values."""
        machine_specific_patterns = [
            "/media/",
            "~/.local/",
            "127.0.0.1",
            "localhost",
            "7449",
            "8188",
            "11434",
        ]
        for i, entry in enumerate(self.plugins):
            with self.subTest(entry=i):
                entry_str = json.dumps(entry)
                for pattern in machine_specific_patterns:
                    self.assertNotIn(
                        pattern,
                        entry_str,
                        f"Entry {i} ({entry['name']}) contains machine-specific value: {pattern}",
                    )


if __name__ == "__main__":
    unittest.main()
