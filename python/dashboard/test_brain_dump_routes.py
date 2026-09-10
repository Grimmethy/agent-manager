"""Tests for the /api/brain-dump/* write routes (routes/brain_dump.py).

Regression guard for 2026-09-10: the `cfda6720` decompose that split /api/brain-dump/*
out of app.py into routes/brain_dump.py moved the view bodies but not their
`from datetime import datetime, timezone` / `import json` imports, so every write route
that stamps a timestamp (capture, edit-on-text-change, prioritize) raised an unhandled
`NameError: name 'datetime' is not defined` -> HTTP 500. GET /api/brain-dump was
unaffected (no timestamp), which is why the break went unnoticed.

Uses the same ENV_FILE_PATH-override pattern as test_concepts_routes.py to point
get_pipeline_dir() / brain_dump_path() at an isolated tmpdir, driving the routes through
Flask's own test_client().

Run: .venv/bin/python -m unittest python.dashboard.test_brain_dump_routes -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class BrainDumpWriteRoutesTest(unittest.TestCase):
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

    def test_capture_appends_a_captured_entry(self):
        resp = self.client.post("/api/brain-dump/capture", json={"text": "a fresh idea"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        entry = resp.get_json()
        self.assertEqual(entry["status"], "captured")
        self.assertEqual(entry["rawText"], "a fresh idea")
        self.assertEqual(entry["serial"], 1)
        self.assertTrue(entry["id"].startswith("bd-"))
        self.assertIn("T", entry["capturedAt"])  # ISO timestamp actually rendered
        self.assertEqual(len(self._entries()), 1)

    def test_capture_increments_serial_over_existing_entries(self):
        self._seed([{"id": "bd-old", "serial": 7, "rawText": "x", "status": "sorted"}])
        resp = self.client.post("/api/brain-dump/capture", json={"text": "next"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertEqual(resp.get_json()["serial"], 8)

    def test_capture_rejects_empty_text(self):
        resp = self.client.post("/api/brain-dump/capture", json={"text": "   "})
        self.assertEqual(resp.status_code, 400)

    def test_edit_on_text_change_stamps_editedAt_and_resets_sorted_entry(self):
        self._seed([{"id": "bd-e", "serial": 1, "rawText": "old", "status": "sorted",
                     "sort": {"secondBrainPath": "x.md"}}])
        resp = self.client.put("/api/brain-dump/bd-e", json={"text": "new text"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        entry = resp.get_json()
        self.assertEqual(entry["rawText"], "new text")
        self.assertEqual(entry["status"], "captured")
        self.assertNotIn("sort", entry)
        self.assertIn("T", entry["editedAt"])

    def test_prioritize_queues_an_adhoc_task_and_actions_the_entry(self):
        self._seed([{"id": "bd-p", "serial": 1, "rawText": "do this now", "status": "captured"}])
        resp = self.client.post("/api/brain-dump/bd-p/prioritize")
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        entry = resp.get_json()
        self.assertEqual(entry["status"], "actioned")
        self.assertTrue(entry["queuedTaskId"].startswith("adhoc-brain-dump-"))
        self.assertIn("T", entry["queuedAt"])
        queued = list((self.pipeline_dir / "queue" / "adhoc").glob("*.json"))
        self.assertEqual(len(queued), 1)
        rec = json.loads(queued[0].read_text(encoding="utf-8"))
        self.assertEqual(rec["promptContext"]["brainDumpEntryId"], "bd-p")


if __name__ == "__main__":
    unittest.main()
