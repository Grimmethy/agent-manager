"""Tests for app.py core helpers: _find_task_record_anywhere hub-label resolution,
regex boundary, and no-regression for exact task-id lookups.

Run: .venv/bin/python -m unittest python.dashboard.test_app -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


def _mkqueue(root: Path):
    for s in ("done", "adhoc", "coordinating", "blocked", "pending", "drafting", "done/_superseded", "done/_archived_no_action"):
        (root / "queue" / s).mkdir(parents=True, exist_ok=True)
    return root / "queue"


def _write(qdir, sub, obj):
    p = qdir / sub / f"{obj['id']}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj))


class TestFindTaskRecordAnywhereHubLabel(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.q = _mkqueue(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_hub_label_resolution_returns_the_hub_record(self):
        _write(self.q, "coordinating", {
            "id": "HUB0251", "hubLabel": "HUB0251", "formerIds": [],
            "subTasks": [{"id": "sub-a"}, {"id": "sub-b"}],
        })
        data, state = app._find_task_record_anywhere(self.q, "HUB0251")
        self.assertEqual(state, "coordinating")
        self.assertEqual(data["id"], "HUB0251")
        self.assertEqual(data["hubLabel"], "HUB0251")

    def test_hub_label_ambiguity_raises_value_error_listing_both_ids(self):
        _write(self.q, "coordinating", {
            "id": "HUB0251-A", "hubLabel": "HUB0251", "formerIds": [],
            "subTasks": [],
        })
        _write(self.q, "coordinating", {
            "id": "HUB0251-B", "hubLabel": "HUB0251", "formerIds": [],
            "subTasks": [],
        })
        with self.assertRaises(ValueError) as ctx:
            app._find_task_record_anywhere(self.q, "HUB0251")
        self.assertIn("HUB0251-A", str(ctx.exception))
        self.assertIn("HUB0251-B", str(ctx.exception))

    def test_unknown_hub_label_returns_none_like_task_not_found(self):
        _write(self.q, "coordinating", {
            "id": "HUB0001", "hubLabel": "HUB0001", "formerIds": [],
            "subTasks": [],
        })
        data, state = app._find_task_record_anywhere(self.q, "HUB9999")
        self.assertIsNone(data)
        self.assertIsNone(state)

    def test_regex_boundary_exactly_four_digits(self):
        """HUB0251 (4 digits) matches; HUB123 (3 digits) and HUB12345 (5 digits) do not."""
        _write(self.q, "coordinating", {
            "id": "HUB0251", "hubLabel": "HUB0251", "formerIds": [],
            "subTasks": [],
        })
        # 4 digits: resolves via hub label path
        data, _ = app._find_task_record_anywhere(self.q, "HUB0251")
        self.assertIsNotNone(data)
        # 3 digits: falls through to normal task lookup, not found in queue
        data, state = app._find_task_record_anywhere(self.q, "HUB123")
        self.assertIsNone(data)
        self.assertIsNone(state)
        # 5 digits: same, no hub label resolution
        data, state = app._find_task_record_anywhere(self.q, "HUB12345")
        self.assertIsNone(data)
        self.assertIsNone(state)

    def test_exact_task_id_no_regression_for_non_hub_ids(self):
        _write(self.q, "pending", {"id": "ac-100", "title": "Implement X"})
        _write(self.q, "coordinating", {
            "id": "HUB0001", "hubLabel": "HUB0001", "formerIds": [],
            "subTasks": [],
        })
        data, state = app._find_task_record_anywhere(self.q, "ac-100")
        self.assertEqual(state, "pending")
        self.assertEqual(data["id"], "ac-100")

    def test_no_qdir_returns_none(self):
        data, state = app._find_task_record_anywhere(None, "HUB0251")
        self.assertIsNone(data)
        self.assertIsNone(state)

    def test_empty_task_id_returns_none(self):
        data, state = app._find_task_record_anywhere(self.q, "")
        self.assertIsNone(data)
        self.assertIsNone(state)

    def test_hub_label_from_former_id_resolves(self):
        _write(self.q, "coordinating", {
            "id": "HUB0251", "hubLabel": "HUB0251", "formerIds": ["old-hub-0251"],
            "subTasks": [],
        })
        # The label itself resolves by hubLabel
        data, state = app._find_task_record_anywhere(self.q, "HUB0251")
        self.assertEqual(state, "coordinating")
        self.assertEqual(data["id"], "HUB0251")


class TestHubLabelRegex(unittest.TestCase):
    def test_pattern_matches_exactly_hub_plus_four_digits(self):
        import re
        pat = app._HUB_LABEL_RE
        self.assertIsNotNone(pat.match("HUB0251"))
        self.assertIsNotNone(pat.match("HUB0000"))
        self.assertIsNotNone(pat.match("HUB9999"))
        self.assertIsNone(pat.match("HUB123"))       # 3 digits
        self.assertIsNone(pat.match("HUB12345"))      # 5 digits
        self.assertIsNone(pat.match("hub0251"))       # lowercase
        self.assertIsNone(pat.match("HUB-0251"))      # with dash
        self.assertIsNone(pat.match("XHUB0251"))      # prefix
        self.assertIsNone(pat.match("HUB0251X"))      # suffix

    def test_pattern_does_not_match_partial_or_related_shapes(self):
        import re
        pat = app._HUB_LABEL_RE
        self.assertIsNone(pat.match("HUB"))
        self.assertIsNone(pat.match("HUB0"))
        self.assertIsNone(pat.match("0251"))
        self.assertIsNone(pat.match(""))


class TestFindTaskRecordAnywhereNoRegression(unittest.TestCase):
    """Verify the original task-id resolution path still works unchanged."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.q = _mkqueue(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_pending_task_resolved(self):
        _write(self.q, "pending", {"id": "ac-1", "title": "A"})
        data, state = app._find_task_record_anywhere(self.q, "ac-1")
        self.assertEqual(state, "pending")
        self.assertEqual(data["title"], "A")

    def test_archived_task_resolved(self):
        _write(self.q, "done/_archived_no_action", {"id": "ac-2", "title": "B"})
        data, state = app._find_task_record_anywhere(self.q, "ac-2")
        self.assertEqual(state, "archived")

    def test_superseded_task_resolved(self):
        _write(self.q, "done/_superseded", {"id": "ac-3", "title": "C"})
        data, state = app._find_task_record_anywhere(self.q, "ac-3")
        self.assertEqual(state, "superseded")

    def test_drafting_subfolder_resolved(self):
        _write(self.q, "drafting/worker-1", {"id": "ac-4", "title": "D"})
        data, state = app._find_task_record_anywhere(self.q, "ac-4")
        self.assertEqual(state, "drafting")
        self.assertEqual(data["title"], "D")

    def test_missing_task_returns_none(self):
        data, state = app._find_task_record_anywhere(self.q, "does-not-exist")
        self.assertIsNone(data)
        self.assertIsNone(state)


if __name__ == "__main__":
    unittest.main()
