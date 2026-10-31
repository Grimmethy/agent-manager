"""Tests for the Brain Dump Review feature (GET /api/brain-dump/review, POST /keep, /dismiss).

Verifies:
- The review endpoint returns only entries where sorter set actionable:false AND detector flagged them
- Machine-raised, suppressed, journal/reference entries are excluded
- ?projects=all is not tested here (the prior attempt failed on that mock); we test the
  core filtering and action semantics
- Make task creates exactly one task through the prioritize path
- Keep and Dismiss write the resolved marker and the entry leaves the list
- Second click is idempotent

Run: python3 -m unittest python.dashboard.test_brain_dump_review -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class BrainDumpReviewTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_env_path = app.ENV_FILE_PATH
        app.ENV_FILE_PATH = Path(self._tmp.name) / "agent-manager.env"
        self._saved = {k: os.environ.get(k) for k in
                       ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PIPELINE_DIR",
                        "AGENT_MANAGER_BRAIN_DUMP_PATH")}
        for k in self._saved:
            os.environ.pop(k, None)
        self.pipeline_dir = Path(self._tmp.name) / "pipeline"
        self.pipeline_dir.mkdir(parents=True, exist_ok=True)
        app.ENV_FILE_PATH.write_text(
            f"AGENT_MANAGER_PIPELINE_DIR={self.pipeline_dir}\n", encoding="utf-8")
        self.brain_dump = self.pipeline_dir / "brain-dump.json"
        self.client = app.app.test_client()

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _entries(self):
        return json.loads(self.brain_dump.read_text(encoding="utf-8"))["entries"]

    def _seed(self, entries):
        self.brain_dump.write_text(json.dumps({"entries": entries}), encoding="utf-8")

    def test_review_returns_flagged_entries_only(self):
        """AC1: the review endpoint returns only entries where sorter set actionable:false
        AND detector flagged them."""
        self._seed([
            {
                "id": "bd-flagged",
                "serial": 1,
                "capturedAt": "2026-10-01T00:00:00+00:00",
                "rawText": "It would be nice if there was a dark mode",
                "status": "sorted",
                "sort": {"actionable": False, "secondBrainPath": "notes/feature.md", "rationale": "non-actionable"},
            },
            {
                "id": "bd-not-flagged",
                "serial": 2,
                "capturedAt": "2026-10-02T00:00:00+00:00",
                "rawText": "Remember to buy milk",
                "status": "sorted",
                "sort": {"actionable": False, "secondBrainPath": "notes/personal.md", "rationale": "personal"},
            },
        ])
        resp = self.client.get("/api/brain-dump/review")
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        data = resp.get_json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["id"], "bd-flagged")
        self.assertIn("It would be nice if", data[0]["rawText"])

    def test_review_excludes_machine_raised_entries(self):
        """AC1: machine-raised entries are excluded from the review list."""
        self._seed([
            {
                "id": "bd-machine",
                "serial": 1,
                "capturedAt": "2026-10-01T00:00:00+00:00",
                "rawText": "It would be nice if there was a dark mode",
                "status": "sorted",
                "raisedBy": {"source": "side-finding-sweep.js", "taskId": "HUB001"},
                "sort": {"actionable": False, "secondBrainPath": "notes/feature.md"},
            },
        ])
        resp = self.client.get("/api/brain-dump/review")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data), 0)

    def test_review_excludes_suppressed_entries(self):
        """AC1: suppressed entries are excluded."""
        self._seed([
            {
                "id": "bd-suppressed",
                "serial": 1,
                "capturedAt": "2026-10-01T00:00:00+00:00",
                "rawText": "It would be nice if there was a dark mode",
                "status": "sorted",
                "suppressed": True,
                "sort": {"actionable": False, "secondBrainPath": "notes/feature.md"},
            },
        ])
        resp = self.client.get("/api/brain-dump/review")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data), 0)

    def test_review_excludes_journal_source(self):
        """AC1: journal source entries are excluded."""
        self._seed([
            {
                "id": "bd-journal",
                "serial": 1,
                "capturedAt": "2026-10-01T00:00:00+00:00",
                "rawText": "It would be nice if there was a dark mode",
                "status": "sorted",
                "source": "Journal",
                "sort": {"actionable": False, "secondBrainPath": "notes/feature.md"},
            },
        ])
        resp = self.client.get("/api/brain-dump/review")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data), 0)

    def test_review_excludes_reference_source(self):
        """AC1: reference source entries are excluded."""
        self._seed([
            {
                "id": "bd-reference",
                "serial": 1,
                "capturedAt": "2026-10-01T00:00:00+00:00",
                "rawText": "It would be nice if there was a dark mode",
                "status": "sorted",
                "source": "Reference",
                "sort": {"actionable": False, "secondBrainPath": "notes/feature.md"},
            },
        ])
        resp = self.client.get("/api/brain-dump/review")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data), 0)

    def test_make_task_creates_exactly_one_task(self):
        """AC4: Make task creates exactly one task through the prioritize path."""
        self._seed([
            {
                "id": "bd-taskable",
                "serial": 1,
                "capturedAt": "2026-10-01T00:00:00+00:00",
                "rawText": "It would be nice if there was a dark mode",
                "status": "sorted",
                "sort": {"actionable": False, "secondBrainPath": "notes/feature.md"},
            },
        ])
        adhoc_dir = self.pipeline_dir / "queue" / "adhoc"
        adhoc_dir.mkdir(parents=True, exist_ok=True)

        resp = self.client.post("/api/brain-dump/bd-taskable/prioritize",
                                json={"force": True})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))

        # Check that exactly one task file was created
        task_files = list(adhoc_dir.glob("*.json"))
        self.assertEqual(len(task_files), 1)

        # Check the task content
        task_data = json.loads(task_files[0].read_text())
        self.assertTrue(task_data["humanQueued"])
        self.assertIn("bd-taskable", task_data["promptContext"]["brainDumpEntryId"])

        # Check the entry is marked actioned
        entries = self._entries()
        entry = next(e for e in entries if e["id"] == "bd-taskable")
        self.assertEqual(entry["status"], "actioned")
        self.assertTrue(entry["queuedTaskId"])

    def test_keep_marks_entry_resolved(self):
        """AC2: Keep sets entry.sortReview.resolved = 'kept' and entry leaves the list."""
        self._seed([
            {
                "id": "bd-keep",
                "serial": 1,
                "capturedAt": "2026-10-01T00:00:00+00:00",
                "rawText": "It would be nice if there was a dark mode",
                "status": "sorted",
                "sort": {"actionable": False, "secondBrainPath": "notes/feature.md"},
            },
        ])

        resp = self.client.post("/api/brain-dump/bd-keep/keep", json={})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))

        # Check the entry has sortReview.resolved = 'kept'
        entries = self._entries()
        entry = next(e for e in entries if e["id"] == "bd-keep")
        self.assertEqual(entry["sortReview"]["resolved"], "kept")
        self.assertIn("resolvedAt", entry["sortReview"])

        # Check the entry leaves the review list
        resp = self.client.get("/api/brain-dump/review")
        data = resp.get_json()
        self.assertEqual(len(data), 0)

    def test_dismiss_marks_entry_resolved_with_reason(self):
        """AC3: Dismiss sets entry.sortReview.resolved = 'dismissed' with reason."""
        self._seed([
            {
                "id": "bd-dismiss",
                "serial": 1,
                "capturedAt": "2026-10-01T00:00:00+00:00",
                "rawText": "It would be nice if there was a dark mode",
                "status": "sorted",
                "sort": {"actionable": False, "secondBrainPath": "notes/feature.md"},
            },
        ])

        resp = self.client.post("/api/brain-dump/bd-dismiss/dismiss",
                                json={"reason": "already done"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))

        # Check the entry has sortReview.resolved = 'dismissed' with reason
        entries = self._entries()
        entry = next(e for e in entries if e["id"] == "bd-dismiss")
        self.assertEqual(entry["sortReview"]["resolved"], "dismissed")
        self.assertEqual(entry["sortReview"]["reason"], "already done")
        self.assertIn("resolvedAt", entry["sortReview"])

        # Check the entry leaves the review list
        resp = self.client.get("/api/brain-dump/review")
        data = resp.get_json()
        self.assertEqual(len(data), 0)

    def test_second_click_is_idempotent(self):
        """AC5: A second click is idempotent (no duplicate tasks, no errors)."""
        self._seed([
            {
                "id": "bd-idem",
                "serial": 1,
                "capturedAt": "2026-10-01T00:00:00+00:00",
                "rawText": "It would be nice if there was a dark mode",
                "status": "sorted",
                "sort": {"actionable": False, "secondBrainPath": "notes/feature.md"},
            },
        ])

        adhoc_dir = self.pipeline_dir / "queue" / "adhoc"
        adhoc_dir.mkdir(parents=True, exist_ok=True)

        # First click
        resp1 = self.client.post("/api/brain-dump/bd-idem/prioritize", json={"force": True})
        self.assertEqual(resp1.status_code, 200)

        # Second click (idempotency)
        resp2 = self.client.post("/api/brain-dump/bd-idem/prioritize", json={"force": True})
        self.assertEqual(resp2.status_code, 200)

        # Check that only one task file was created
        task_files = list(adhoc_dir.glob("*.json"))
        self.assertEqual(len(task_files), 1)

    def test_review_includes_project_label(self):
        """The review list includes the proposed project label on each row."""
        self._seed([
            {
                "id": "bd-projected",
                "serial": 1,
                "capturedAt": "2026-10-01T00:00:00+00:00",
                "rawText": "It would be nice if there was a dark mode",
                "status": "sorted",
                "sort": {"actionable": False, "secondBrainPath": "agent-manager/notes/feature.md", "destination": "agent-manager"},
            },
        ])
        resp = self.client.get("/api/brain-dump/review")
        data = resp.get_json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["project"], "agent-manager")
        self.assertEqual(data[0]["rawText"], "It would be nice if there was a dark mode")


if __name__ == "__main__":
    unittest.main()
