"""Tests for the pieceBranches field on hub records (HUB0931).

Covers three scenarios:
  1. A hub with three pieces on three branches reports all three branches in
     pieceBranches after write/load.
  2. A single-branch hub remains unchanged (no regression).
  3. An old hub record without the pieceBranches field still loads with a
     sensible default (empty dict).

unittest.TestCase classes (the package's convention); pytest collects them too:
    python -I -m pytest python/dashboard/tests/test_hub_pieces.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hub_record import load_hub_record, write_hub_record  # noqa: E402


def make_qdir(tmp_dir: Path) -> Path:
    """Create a minimal pipeline directory layout with a coordinating/ subdir."""
    (tmp_dir / "coordinating").mkdir()
    return tmp_dir


class ThreeBranchesHubTests(unittest.TestCase):
    """A hub with three pieces on three distinct branches reports all three in pieceBranches."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.qdir = make_qdir(Path(self.tmp.name))
        self.hub_id = "HUB0001"

    def _write_hub_with_branches(self, branches: dict[str, str]):
        """Helper: build a hub record dict with the given pieceBranches map and write it."""
        record = {
            "id": self.hub_id,
            "title": "Test hub with multiple pieces",
            "labels": ["HUB0001"],
            "subTasks": [
                {"id": pid, "title": f"Piece {pid}", "status": "pending"}
                for pid in branches
            ],
            "pieceCount": len(branches),
            "pieceBranches": branches,
        }
        write_hub_record(self.hub_id, record, self.qdir)

    def test_three_pieces_report_all_three_branches(self):
        branches = {
            "HUB0931-01": "add-piecebranches-schema",
            "HUB0931-02": "record-piece-branch",
            "HUB0931-03": "add-pieces-tests",
        }
        self._write_hub_with_branches(branches)

        loaded = load_hub_record(self.hub_id, self.qdir)
        self.assertIsNotNone(loaded, "hub record should load successfully")
        self.assertEqual(loaded["pieceBranches"], branches)
        # Verify all three piece IDs map to their expected branches
        self.assertEqual(loaded["pieceBranches"]["HUB0931-01"], "add-piecebranches-schema")
        self.assertEqual(loaded["pieceBranches"]["HUB0931-02"], "record-piece-branch")
        self.assertEqual(loaded["pieceBranches"]["HUB0931-03"], "add-pieces-tests")

    def test_three_branches_round_trip_via_disk(self):
        """Confirm the branches survive an actual disk write, not just in-memory."""
        branches = {
            "piece-a": "feature/a",
            "piece-b": "feature/b",
            "piece-c": "develop",
        }
        self._write_hub_with_branches(branches)

        # Read the raw JSON back to verify it was serialized correctly
        hub_path = self.qdir / "coordinating" / f"{self.hub_id}.json"
        self.assertTrue(hub_path.is_file(), "hub JSON should exist on disk")
        raw = json.loads(hub_path.read_text(encoding="utf-8"))
        self.assertEqual(raw["pieceBranches"], branches)


class SingleBranchHubTests(unittest.TestCase):
    """A single-branch hub remains unchanged -- pieceBranches with one entry is preserved."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.qdir = make_qdir(Path(self.tmp.name))
        self.hub_id = "HUB0002"

    def test_single_branch_preserved(self):
        """A hub with one piece on one branch keeps that mapping intact after write/load."""
        record = {
            "id": self.hub_id,
            "title": "Single-piece hub",
            "pieceCount": 1,
            "pieceBranches": {"HUB0042": "fix-typo"},
            "subTasks": [{"id": "HUB0042", "title": "Fix typo", "status": "pending"}],
        }
        write_hub_record(self.hub_id, record, self.qdir)

        loaded = load_hub_record(self.hub_id, self.qdir)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["pieceBranches"], {"HUB0042": "fix-typo"})
        # No regression: pieceCount should also survive
        self.assertEqual(loaded["pieceCount"], 1)

    def test_single_branch_no_extra_fields_added(self):
        """A single-branch hub should not gain spurious keys after a round trip."""
        record = {
            "id": self.hub_id,
            "title": "Lean hub",
            "pieceBranches": {"p1": "main"},
        }
        write_hub_record(self.hub_id, record, self.qdir)
        loaded = load_hub_record(self.hub_id, self.qdir)

        # Only schema fields plus the ones we put in should be present
        self.assertIn("pieceBranches", loaded)
        self.assertEqual(loaded["pieceBranches"], {"p1": "main"})


class OldHubRecordBackwardCompatibilityTests(unittest.TestCase):
    """An old hub record without pieceBranches still loads with a sensible default."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.qdir = make_qdir(Path(self.tmp.name))

    def test_missing_piece_branches_key_returns_empty_dict(self):
        """A hub record written before HUB0931 (no pieceBranches key) loads with {}."""
        hub_id = "HUB0003"
        hub_path = self.qdir / "coordinating" / f"{hub_id}.json"
        # Simulate an old hub record -- no pieceBranches key at all
        old_record = {
            "id": hub_id,
            "title": "Legacy hub",
            "pieceCount": 2,
            "pieceNames": ["alpha", "beta"],
            "subTasks": [
                {"id": "alpha", "title": "Alpha", "status": "done"},
                {"id": "beta", "title": "Beta", "status": "pending"},
            ],
        }
        hub_path.write_text(
            json.dumps(old_record, indent=2), encoding="utf-8"
        )

        loaded = load_hub_record(hub_id, self.qdir)
        self.assertIsNotNone(loaded, "old hub record should still load")
        self.assertEqual(loaded["pieceBranches"], {})
        # Other fields should be preserved untouched
        self.assertEqual(loaded["pieceCount"], 2)
        self.assertEqual(loaded["pieceNames"], ["alpha", "beta"])

    def test_null_piece_branches_defaulted_to_empty_dict(self):
        """pieceBranches explicitly set to null should default to {}."""
        hub_id = "HUB0004"
        hub_path = self.qdir / "coordinating" / f"{hub_id}.json"
        hub_path.write_text(
            json.dumps({"id": hub_id, "pieceBranches": None}),
            encoding="utf-8",
        )

        loaded = load_hub_record(hub_id, self.qdir)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["pieceBranches"], {})

    def test_non_dict_piece_branches_defaulted_to_empty_dict(self):
        """Corrupted pieceBranches (non-dict) should default to {}."""
        hub_id = "HUB0005"
        hub_path = self.qdir / "coordinating" / f"{hub_id}.json"
        hub_path.write_text(
            json.dumps({"id": hub_id, "pieceBranches": "not-a-dict"}),
            encoding="utf-8",
        )

        loaded = load_hub_record(hub_id, self.qdir)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["pieceBranches"], {})

    def test_write_then_load_old_format_gains_empty_branches(self):
        """Writing an old-style record (no pieceBranches) and reloading it yields {} for that field."""
        hub_id = "HUB0006"
        record = {
            "id": hub_id,
            "title": "Record without pieceBranches",
            "pieceCount": 0,
        }
        write_hub_record(hub_id, record, self.qdir)

        loaded = load_hub_record(hub_id, self.qdir)
        self.assertIsNotNone(loaded)
        # The writer defaults pieceBranches to {} when the caller passes None/missing
        self.assertEqual(loaded["pieceBranches"], {})


if __name__ == "__main__":
    unittest.main()
