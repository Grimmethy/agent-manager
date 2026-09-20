"""The dashboard's Archive button stamps what an archive of an unfinished task MEANS (2026-09-19).

Before: the button only moved the file to queue/done/_archived_no_action/, so a hand-archived blocked task had no
terminalDisposition ("unclassified" in the Hygiene tab) and silently blocked every task that dependsOn it -- how
arch-review-ac-7 stayed ineligible after arch-review-ac-6 was archived. Now a give-up archive stamps 'abandoned'
(+ manualArchive, + a history event); a Done-tab archive and any record that already has a disposition are untouched.

Run: .venv/bin/python -m unittest python.dashboard.test_task_archive_disposition -v
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TestArchiveDisposition(unittest.TestCase):
    def setUp(self):
        self.pipe = Path(tempfile.mkdtemp())
        self.q = self.pipe / "queue"
        self.client = app.app.test_client()
        p = mock.patch.object(app, "queue_dir", return_value=self.q)
        p.start()
        self.addCleanup(p.stop)

    def put(self, state, task_id, **extra):
        d = self.q / state
        d.mkdir(parents=True, exist_ok=True)
        rec = {"id": task_id, "source": "arch_review", "status": "pending", "history": [{"stage": "created", "at": "x"}], **extra}
        (d / f"{task_id}.json").write_text(json.dumps(rec))

    def archived(self, task_id):
        return json.loads((self.q / "done" / "_archived_no_action" / f"{task_id}.json").read_text())

    def test_blocked_archive_stamps_abandoned_with_history_and_reason(self):
        self.put("blocked", "arch-review-ac-6", blockedReason="x")
        r = self.client.post("/api/task/blocked/arch-review-ac-6/archive", json={"reason": "hand-implemented instead"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json(), {"id": "arch-review-ac-6", "archived": True, "disposition": "abandoned"})
        rec = self.archived("arch-review-ac-6")
        self.assertEqual(rec["terminalDisposition"], "abandoned")
        self.assertEqual(rec["manualArchive"]["from"], "blocked")
        self.assertEqual(rec["manualArchive"]["reason"], "hand-implemented instead")
        self.assertEqual(rec["history"][-1]["stage"], "abandoned")
        self.assertIn("hand-implemented instead", rec["history"][-1]["detail"])
        self.assertFalse((self.q / "blocked" / "arch-review-ac-6.json").exists())

    def test_needs_clarification_and_awaiting_confirm_also_stamp_and_no_body_is_fine(self):
        for state in ("needs-clarification", "awaiting-confirm"):
            self.put(state, f"t-{state}")
            r = self.client.post(f"/api/task/{state}/t-{state}/archive")
            self.assertEqual(r.status_code, 200)
            rec = self.archived(f"t-{state}")
            self.assertEqual(rec["terminalDisposition"], "abandoned")
            self.assertIsNone(rec["manualArchive"]["reason"])
            self.assertEqual(rec["manualArchive"]["from"], state)

    def test_done_tab_archive_is_housekeeping_and_keeps_the_record_untouched(self):
        self.put("done", "finished-1", terminalDisposition="merged", mergedAt="2026-09-01")
        r = self.client.post("/api/task/done/finished-1/archive")
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.get_json()["disposition"])
        rec = self.archived("finished-1")
        self.assertEqual(rec["terminalDisposition"], "merged")
        self.assertNotIn("manualArchive", rec)

    def test_an_existing_disposition_is_never_overwritten(self):
        self.put("blocked", "has-disp", terminalDisposition="superseded")
        self.client.post("/api/task/blocked/has-disp/archive", json={"reason": "x"})
        rec = self.archived("has-disp")
        self.assertEqual(rec["terminalDisposition"], "superseded")
        self.assertNotIn("manualArchive", rec)

    def test_unreadable_record_is_still_archived_unchanged(self):
        d = self.q / "blocked"
        d.mkdir(parents=True)
        (d / "broken.json").write_text("{not json")
        r = self.client.post("/api/task/blocked/broken/archive")
        self.assertEqual(r.status_code, 200)
        self.assertEqual((self.q / "done" / "_archived_no_action" / "broken.json").read_text(), "{not json")

    def test_existing_archive_conflict_409s_and_leaves_the_source_unstamped(self):
        self.put("blocked", "dup-1")
        (self.q / "done" / "_archived_no_action").mkdir(parents=True, exist_ok=True)
        (self.q / "done" / "_archived_no_action" / "dup-1.json").write_text("{}")
        r = self.client.post("/api/task/blocked/dup-1/archive")
        self.assertEqual(r.status_code, 409)
        src = json.loads((self.q / "blocked" / "dup-1.json").read_text())
        self.assertNotIn("terminalDisposition", src)

    def test_rejects_non_archivable_states(self):
        self.put("pending", "p-1")
        self.assertEqual(self.client.post("/api/task/pending/p-1/archive").status_code, 400)

    def test_an_archived_dependency_now_releases_its_dependent_through_the_real_gate(self):
        """The whole point: node's isDependencySatisfied agrees the archived task is resolved."""
        self.put("blocked", "arch-review-ac-6")
        self.client.post("/api/task/blocked/arch-review-ac-6/archive", json={"reason": "done by hand"})
        core = Path(app.__file__).resolve().parent.parent.parent
        script = (
            "const {isDependencySatisfied}=require('./src/task-sources.js');"
            f"process.stdout.write(String(isDependencySatisfied({json.dumps(str(self.pipe))},'arch-review-ac-6')))"
        )
        out = subprocess.run(["node", "-e", script], cwd=str(core), capture_output=True, text=True, timeout=60)
        self.assertEqual(out.stdout.strip(), "true", out.stderr[-400:])


if __name__ == "__main__":
    unittest.main()
