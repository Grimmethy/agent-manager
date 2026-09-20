"""POST /api/task/needs-clarification/<id>/requeue (2026-09-20).

A candidate-fulfillment task (PF function-length-fix-ac-3) exhausted its retries and landed in needs-clarification; the Requeue button only
covered blocked/done/archived, so the only way back was moving the file to blocked/ by hand. Non-adhoc NC tasks can now be requeued directly.
Adhoc-shaped ones cannot: pending/ would strand them (nextAdhocTask only scans queue/adhoc/) -- they keep /resolve and /answer.

Run: .venv/bin/python -m unittest python.dashboard.test_requeue_needs_clarification -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TestRequeueNeedsClarification(unittest.TestCase):
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
        rec = {
            "id": task_id, "domain": "default", "source": "function_length_fix", "title": "AC-3", "status": "pending",
            "promptContext": {"candidateId": "AC-3"}, "history": [{"stage": "exhausted", "at": "x"}],
            "planResponse": "stale", "implementResponse": "stale", "blockedReason": "stale", **extra,
        }
        (d / f"{task_id}.json").write_text(json.dumps(rec))

    def test_non_adhoc_needs_clarification_task_goes_back_to_pending_fresh_with_coordination_fields(self):
        self.put("needs-clarification", "function-length-fix-ac-3", stacked={"branch": "agent/x", "seq": 2, "total": 3}, dependsOn=["p1"], atomic=True)
        r = self.client.post("/api/task/needs-clarification/function-length-fix-ac-3/requeue", json={"force": True})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertFalse((self.q / "needs-clarification" / "function-length-fix-ac-3.json").exists())
        fresh = json.loads((self.q / "pending" / "function-length-fix-ac-3.json").read_text())
        self.assertEqual(fresh["status"], "pending")
        self.assertNotIn("planResponse", fresh)
        self.assertNotIn("blockedReason", fresh)
        self.assertEqual(fresh["stacked"], {"branch": "agent/x", "seq": 2, "total": 3})
        self.assertEqual(fresh["dependsOn"], ["p1"])
        self.assertTrue(fresh["atomic"])
        self.assertEqual(fresh["history"][0]["stage"], "exhausted", "the log is appended to, never replaced")
        self.assertEqual(fresh["history"][-1]["note"], "manually requeued from needs-clarification/")

    def test_adhoc_shaped_needs_clarification_tasks_are_refused_and_left_where_they_are(self):
        for i, (domain, source) in enumerate([("adhoc", "manual"), ("default", "manual"), ("default", "derived_task")]):
            tid = f"adhoc-{i}"
            self.put("needs-clarification", tid, domain=domain, source=source)
            r = self.client.post(f"/api/task/needs-clarification/{tid}/requeue", json={"force": True})
            self.assertEqual(r.status_code, 400, (domain, source))
            self.assertIn("/resolve", r.get_json()["description"])
            self.assertTrue((self.q / "needs-clarification" / f"{tid}.json").exists())
            self.assertFalse((self.q / "pending" / f"{tid}.json").exists())

    def test_the_repeated_cause_guard_applies_to_needs_clarification_too(self):
        """Same 'diagnose first, then requeue again' checkpoint blocked/ has; force=true proceeds."""
        blocked = "Deterministic gate: implementResponse is a bare tool-call request or meta-commentary, not a real implementation attempt"
        self.put("needs-clarification", "t", priorRejectionFeedback=[blocked, blocked], blockedReason=blocked)
        first = self.client.post("/api/task/needs-clarification/t/requeue")
        if first.status_code == 409:
            self.assertTrue((self.q / "needs-clarification" / "t.json").exists(), "a refused requeue leaves the task in place")
            self.assertEqual(self.client.post("/api/task/needs-clarification/t/requeue", json={"force": True}).status_code, 200)
        else:  # the detector did not consider this a repeat -- the requeue simply went through
            self.assertEqual(first.status_code, 200)
        self.assertTrue((self.q / "pending" / "t.json").exists())

    def test_blocked_requeue_is_unchanged_and_unknown_states_are_still_rejected(self):
        self.put("blocked", "b1")
        self.assertEqual(self.client.post("/api/task/blocked/b1/requeue", json={"force": True}).status_code, 200)
        self.assertTrue((self.q / "pending" / "b1.json").exists())
        self.put("pending", "p1")
        self.assertEqual(self.client.post("/api/task/pending/p1/requeue").status_code, 400)
        self.assertEqual(self.client.post("/api/task/needs-clarification/nope/requeue").status_code, 404)


if __name__ == "__main__":
    unittest.main()
