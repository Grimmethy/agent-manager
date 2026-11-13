"""The dashboard's archive route also closes a task that has not been started: one sitting in adhoc/ or pending/ (2026-11-10).

Before: only a blocked, done, needs-clarification or awaiting-confirm task could be archived, so the stale ORIGINAL of a hand-carried task (its work delivered on
another branch) stayed in adhoc/ or pending/ with nothing to retire it, masked the delivered copy and risked a lane drafting the same work again. An unstarted
archive is a give-up archive like a blocked one: it stamps terminalDisposition 'abandoned' (+ manualArchive, + a history event) before the move.
A task that is IN FLIGHT (approved, review, drafting) is still refused.

Run: .venv/bin/python -m unittest test_task_archive_unstarted -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TestArchiveUnstarted(unittest.TestCase):
    def setUp(self):
        self.q = Path(tempfile.mkdtemp()) / "queue"
        self.client = app.app.test_client()
        p = mock.patch.object(app, "queue_dir", return_value=self.q)
        p.start()
        self.addCleanup(p.stop)

    def put(self, state, task_id, **extra):
        d = self.q / state
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{task_id}.json").write_text(json.dumps({"id": task_id, "status": "pending", "history": [{"stage": "created", "at": "x"}], **extra}))

    def archived(self, task_id):
        return json.loads((self.q / "done" / "_archived_no_action" / f"{task_id}.json").read_text())

    def test_adhoc_and_pending_are_archived_and_stamped_abandoned_with_the_reason(self):
        for state in ("adhoc", "pending"):
            self.put(state, f"t-{state}")
            r = self.client.post(f"/api/task/{state}/t-{state}/archive", json={"reason": "delivered by the carried copy"})
            self.assertEqual(r.status_code, 200, state)
            self.assertEqual(r.get_json(), {"id": f"t-{state}", "archived": True, "disposition": "abandoned"})
            rec = self.archived(f"t-{state}")
            self.assertEqual(rec["terminalDisposition"], "abandoned")
            self.assertEqual(rec["manualArchive"]["from"], state)
            self.assertEqual(rec["manualArchive"]["reason"], "delivered by the carried copy")
            self.assertEqual(rec["history"][-1]["stage"], "abandoned")
            self.assertFalse((self.q / state / f"t-{state}.json").exists())

    def test_an_archive_with_no_body_is_fine_and_an_existing_disposition_is_not_overwritten(self):
        self.put("adhoc", "plain")
        self.assertEqual(self.client.post("/api/task/adhoc/plain/archive").status_code, 200)
        self.assertEqual(self.archived("plain")["terminalDisposition"], "abandoned")
        self.put("pending", "kept", terminalDisposition="noop")
        r = self.client.post("/api/task/pending/kept/archive", json={"reason": "x"})
        self.assertEqual(r.get_json()["disposition"], None)
        self.assertEqual(self.archived("kept")["terminalDisposition"], "noop")

    def test_a_missing_task_is_404_and_an_existing_archived_copy_is_409(self):
        self.assertEqual(self.client.post("/api/task/adhoc/nothing/archive").status_code, 404)
        self.put("adhoc", "dup")
        (self.q / "done" / "_archived_no_action").mkdir(parents=True, exist_ok=True)
        (self.q / "done" / "_archived_no_action" / "dup.json").write_text("{}")
        r = self.client.post("/api/task/adhoc/dup/archive")
        self.assertEqual(r.status_code, 409)
        self.assertTrue((self.q / "adhoc" / "dup.json").exists(), "a refused archive leaves the task where it was")

    def test_a_task_in_flight_is_still_refused_and_stays_put(self):
        for state in ("approved", "review", "drafting", "coordinating"):
            self.put(state, f"f-{state}")
            r = self.client.post(f"/api/task/{state}/f-{state}/archive")
            self.assertEqual(r.status_code, 400, state)
            self.assertIn("adhoc or pending", r.get_json()["description"])
            self.assertTrue((self.q / state / f"f-{state}.json").exists(), state)

    def test_the_states_that_were_already_archivable_still_are(self):
        for state in ("blocked", "needs-clarification", "awaiting-confirm", "done"):
            self.put(state, f"o-{state}")
            self.assertEqual(self.client.post(f"/api/task/{state}/o-{state}/archive").status_code, 200, state)
        self.assertNotIn("terminalDisposition", self.archived("o-done"), "a done archive is housekeeping and keeps its own record")


if __name__ == "__main__":
    unittest.main()
