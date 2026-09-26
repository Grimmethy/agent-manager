"""Tests for app._pipeline_live_counts / _resolve_source_name when a queue file holds valid
JSON that is not an object (change_review AC-77): `[1,2,3]` in queue/pending/ used to raise
AttributeError inside _resolve_source_name (the Pipeline Map tab's live counts), violating the
function's own contract to bucket such files under "(unknown)".

Run: .venv/bin/python -m unittest python.dashboard.test_pipeline_live_counts -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class PipelineLiveCountsNonDictTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.qdir = Path(self._tmp.name)
        for state in ("pending", "drafting"):
            (self.qdir / state).mkdir()
        (self.qdir / "drafting" / "worker-a").mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _put(self, rel, payload):
        (self.qdir / rel).write_text(payload if isinstance(payload, str) else json.dumps(payload), encoding="utf-8")

    def test_resolve_source_name_returns_none_for_non_object_json(self):
        self.assertIsNone(app._resolve_source_name([1, 2, 3]))
        self.assertIsNone(app._resolve_source_name("hello"))
        self.assertIsNone(app._resolve_source_name(None))

    def test_resolve_source_name_still_resolves_an_object(self):
        self.assertEqual(app._resolve_source_name({"domain": "adhoc"}), "adhoc")
        self.assertEqual(app._resolve_source_name({"source": "arch_review"}), "arch_review")

    def test_non_dict_files_are_bucketed_under_unknown_in_every_state_dir(self):
        self._put("pending/good.json", {"source": "arch_review"})
        self._put("pending/list.json", [1, 2, 3])
        self._put("pending/scalar.json", '"hello"')
        self._put("drafting/worker-a/list.json", [4, 5])
        counts = app._pipeline_live_counts(self.qdir)
        self.assertEqual(counts["arch_review"], {"pending": 1})
        self.assertEqual(counts["(unknown)"], {"pending": 2, "drafting": 1})


if __name__ == "__main__":
    unittest.main()
