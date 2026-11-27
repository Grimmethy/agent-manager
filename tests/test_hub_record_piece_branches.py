"""Tests for hub record pieceBranches field (HUB0931 subtask 1/3).

Covers the schema, loader, and writer for the pieceBranches map:
  1. write_hub_record persists pieceBranches and defaults None to {}.
  2. load_hub_record returns pieceBranches as {} when the on-disk record lacks it.
  3. Round-trip: a non-empty pieceBranches map survives write then load unchanged.

Run: python3 -m unittest tests.test_hub_record_piece_branches -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Ensure python/dashboard is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python", "dashboard"))

# Import directly from hub_record.py -- this module has no external dependencies
# (no Flask, no networkx), so it works in any Python environment.
import hub_record  # noqa: E402


class TestHubRecordPieceBranches(unittest.TestCase):
    """Tests for the pieceBranches field on hub records."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="hub-record-test-")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_qdir(self):
        qdir = Path(self.tmpdir) / "pipeline"
        qdir.mkdir(parents=True)
        return qdir

    def test_write_hub_record_persists_piece_branches(self):
        """write_hub_record should persist pieceBranches to the hub record file."""
        qdir = self._make_qdir()
        record = {
            "id": "HUB0001",
            "hubLabel": "HUB0001",
            "pieceBranches": {"piece-1": "main", "piece-2": "develop"},
        }
        path = hub_record.write_hub_record("HUB0001", record, qdir)
        self.assertTrue(path.is_file())
        data = json.loads(path.read_text())
        self.assertEqual(data["pieceBranches"], {"piece-1": "main", "piece-2": "develop"})

    def test_write_hub_record_defaults_none_piece_branches_to_empty_dict(self):
        """When pieceBranches is None, write_hub_record should persist {}."""
        qdir = self._make_qdir()
        record = {
            "id": "HUB0002",
            "hubLabel": "HUB0002",
            "pieceBranches": None,
        }
        path = hub_record.write_hub_record("HUB0002", record, qdir)
        self.assertTrue(path.is_file())
        data = json.loads(path.read_text())
        self.assertEqual(data["pieceBranches"], {})

    def test_load_hub_record_returns_empty_dict_for_missing_piece_branches(self):
        """load_hub_record should default pieceBranches to {} when the file lacks the key."""
        qdir = self._make_qdir()
        # Write a record without pieceBranches (simulating an old hub record)
        hub_path = qdir / "coordinating" / "HUB0003.json"
        hub_path.parent.mkdir(parents=True, exist_ok=True)
        hub_path.write_text(json.dumps({
            "id": "HUB0003",
            "hubLabel": "HUB0003",
            "subTasks": [],
        }))
        data = hub_record.load_hub_record("HUB0003", qdir)
        self.assertIsNotNone(data)
        self.assertEqual(data["pieceBranches"], {})

    def test_round_trip_non_empty_piece_branches(self):
        """A non-empty pieceBranches map should survive write then load unchanged."""
        qdir = self._make_qdir()
        original = {"a-piece": "feature-a", "b-piece": "feature-b", "c-piece": "main"}
        record = {
            "id": "HUB0004",
            "hubLabel": "HUB0004",
            "pieceBranches": original,
        }
        hub_record.write_hub_record("HUB0004", record, qdir)
        loaded = hub_record.load_hub_record("HUB0004", qdir)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["pieceBranches"], original)

    def test_load_hub_record_returns_none_for_missing_file(self):
        """load_hub_record should return None when the hub record file does not exist."""
        qdir = self._make_qdir()
        result = hub_record.load_hub_record("HUB9999", qdir)
        self.assertIsNone(result)

    def test_schema_includes_piece_branches(self):
        """_HUB_RECORD_SCHEMA_FIELDS should include pieceBranches."""
        self.assertIn(
            hub_record._HubRecordSchema.pieceBranches,
            hub_record._HUB_RECORD_SCHEMA_FIELDS,
        )
        self.assertEqual(
            hub_record._HUB_RECORD_SCHEMA_FIELDS[hub_record._HubRecordSchema.pieceBranches],
            "pieceBranches",
        )


if __name__ == "__main__":
    unittest.main()
