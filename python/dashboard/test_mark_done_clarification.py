"""Tests for POST /api/task/needs-clarification/<id>/done (routes/task.py).

2026-09-19, [[ghost-in-the-machine]] incident (concept-ghost-in-the-machine-0dbeea):
this route used to move the file into queue/done/ without stamping `status` or
`terminalDisposition`, and appended a malformed history entry ({"status": ...} instead
of every other event's {"stage": ...} shape). Confirmed live: two real tasks sat
completely untouched for 6-9 days, waiting on a `dependsOn` edge naming exactly this
kind of manually-"done"-but-unstamped task -- isDependencySatisfied() only recognizes
`mergedAt`/`stacked.branch`, and neither was ever present, so the dependent tasks waited
for a merge that was never going to happen.

Run: .venv/bin/python -m unittest python.dashboard.test_mark_done_clarification -v
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class MarkDoneClarificationTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.queue = root / "queue"
        (self.queue / "needs-clarification").mkdir(parents=True)
        (self.queue / "done").mkdir(parents=True)
        self._patches = [mock.patch.object(app, "queue_dir", return_value=self.queue)]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _write_held_task(self, task_id, extra=None):
        task = {
            "id": task_id,
            "status": "blocked",
            "history": [{"stage": "exhausted", "at": "2026-09-13T13:15:12.955Z", "detail": "2/2 retries used"}],
            "promptContext": {"rawText": "original task text"},
            "needsClarification": {"reason": "design-decision", "openQuestions": "still relevant?"},
            **(extra or {}),
        }
        (self.queue / "needs-clarification" / f"{task_id}.json").write_text(json.dumps(task))
        return task

    def test_moves_the_file_to_done(self):
        self._write_held_task("t1")
        resp = self.client.post("/api/task/needs-clarification/t1/done")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse((self.queue / "needs-clarification" / "t1.json").exists())
        self.assertTrue((self.queue / "done" / "t1.json").is_file())

    def test_stamps_status_done_so_the_field_agrees_with_the_folder(self):
        self._write_held_task("t1")
        self.client.post("/api/task/needs-clarification/t1/done")
        data = json.loads((self.queue / "done" / "t1.json").read_text())
        self.assertEqual(data["status"], "done", "the record's own status must not still read 'blocked'")

    def test_stamps_a_real_terminal_disposition_so_isDependencySatisfied_can_recognize_it(self):
        self._write_held_task("t1")
        self.client.post("/api/task/needs-clarification/t1/done")
        data = json.loads((self.queue / "done" / "t1.json").read_text())
        self.assertEqual(data["terminalDisposition"], "noop")
        self.assertIsNone(data.get("mergedAt"), "no code was produced -- must not claim mergedAt")

    def test_history_event_uses_the_real_stage_shape_not_a_bespoke_status_key(self):
        self._write_held_task("t1")
        self.client.post("/api/task/needs-clarification/t1/done")
        data = json.loads((self.queue / "done" / "t1.json").read_text())
        last = data["history"][-1]
        self.assertEqual(last["stage"], "noop", "must use the same {stage, at, detail} shape every other history event uses")
        self.assertIn("detail", last)
        self.assertNotIn("status", last, "the old bespoke {status: 'done'} shape must be gone")

    def test_doneMarker_is_still_set_for_the_dashboards_own_display(self):
        self._write_held_task("t1")
        self.client.post("/api/task/needs-clarification/t1/done")
        data = json.loads((self.queue / "done" / "t1.json").read_text())
        self.assertIn("done", data["doneMarker"].lower())

    def test_404_when_the_task_does_not_exist(self):
        resp = self.client.post("/api/task/needs-clarification/does-not-exist/done")
        self.assertEqual(resp.status_code, 404)

    def test_409_when_a_done_record_already_exists_under_the_same_id(self):
        self._write_held_task("t1")
        (self.queue / "done" / "t1.json").write_text(json.dumps({"id": "t1", "status": "done"}))
        resp = self.client.post("/api/task/needs-clarification/t1/done")
        self.assertEqual(resp.status_code, 409)
        # The needs-clarification source is untouched on failure.
        self.assertTrue((self.queue / "needs-clarification" / "t1.json").exists())


if __name__ == "__main__":
    unittest.main()
