"""Tests for hub_label_lookup.resolve_hub_ref (HUB0507 2/2).

Each test builds a coordinating/ fixture in a temp directory and passes it explicitly
as base_dir, so no real queue data is read.

Run: python3 -m unittest discover -s python/dashboard -p 'test_hub_label_lookup.py' -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import hub_label_lookup as hll  # noqa: E402
from hub_label_lookup import HubRefAmbiguous, HubRefNotFound, resolve_hub_ref  # noqa: E402


def write_record(base, name, rec):
    d = base / "coordinating"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.json").write_text(json.dumps(rec), encoding="utf-8")


def snapshot(base):
    """{relative path: file bytes} for every file under base."""
    return {
        str(p.relative_to(base)): p.read_bytes()
        for p in sorted(base.rglob("*"))
        if p.is_file()
    }


class TestResolveHubRef(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_case_a_unlabeled_record_resolves_by_id(self):
        write_record(self.base, "rec-unlabeled", {"id": "rec-unlabeled", "subTasks": []})
        self.assertEqual(resolve_hub_ref("rec-unlabeled", base_dir=self.base), "rec-unlabeled")

    def test_case_b_non_hub_id_resolves_by_id(self):
        write_record(self.base, "abc-123", {"id": "abc-123", "hubLabel": "HUB0001"})
        self.assertEqual(resolve_hub_ref("abc-123", base_dir=self.base), "abc-123")

    def test_label_hub0478_resolves_when_exactly_one_record_has_it(self):
        write_record(self.base, "rec-1", {"id": "rec-1", "hubLabel": "HUB0478"})
        write_record(self.base, "rec-2", {"id": "rec-2", "hubLabel": "HUB0479"})
        self.assertEqual(resolve_hub_ref("HUB0478", base_dir=self.base), "rec-1")

    def test_zero_matches_raises_not_found_and_changes_no_files(self):
        write_record(self.base, "rec-1", {"id": "rec-1", "hubLabel": "HUB0478"})
        before = snapshot(self.base)
        with self.assertRaises(HubRefNotFound):
            resolve_hub_ref("HUB9999", base_dir=self.base)
        with self.assertRaises(HubRefNotFound):
            resolve_hub_ref("no-such-id", base_dir=self.base)
        self.assertEqual(snapshot(self.base), before)

    def test_case_c_id_and_other_records_label_is_ambiguous(self):
        # ref "HUB0478" equals record A's id and record B's hubLabel.
        write_record(self.base, "HUB0478", {"id": "HUB0478", "subTasks": []})
        write_record(self.base, "rec-b", {"id": "rec-b", "hubLabel": "HUB0478"})
        with self.assertRaises(HubRefAmbiguous) as cm:
            resolve_hub_ref("HUB0478", base_dir=self.base)
        candidates = cm.exception.candidates
        self.assertEqual(sorted(c["id"] for c in candidates), ["HUB0478", "rec-b"])
        by_id = {c["id"]: c for c in candidates}
        self.assertIsNone(by_id["HUB0478"]["label"])
        self.assertEqual(by_id["rec-b"]["label"], "HUB0478")

    def test_case_d_shared_former_id_records_are_preserved_and_resolve_independently(self):
        write_record(self.base, "rec-x", {
            "id": "rec-x", "hubLabel": "HUB0100", "formerIds": ["OLD-SHARED"],
        })
        write_record(self.base, "rec-y", {
            "id": "rec-y", "hubLabel": "HUB0101", "formerIds": ["OLD-SHARED"],
        })
        before = snapshot(self.base)
        self.assertEqual(resolve_hub_ref("rec-x", base_dir=self.base), "rec-x")
        self.assertEqual(resolve_hub_ref("rec-y", base_dir=self.base), "rec-y")
        self.assertEqual(resolve_hub_ref("HUB0100", base_dir=self.base), "rec-x")
        self.assertEqual(resolve_hub_ref("HUB0101", base_dir=self.base), "rec-y")
        # Resolution is read-only: both records are still on disk, unchanged.
        self.assertEqual(snapshot(self.base), before)
        self.assertTrue((self.base / "coordinating" / "rec-x.json").is_file())
        self.assertTrue((self.base / "coordinating" / "rec-y.json").is_file())


if __name__ == "__main__":
    unittest.main()
