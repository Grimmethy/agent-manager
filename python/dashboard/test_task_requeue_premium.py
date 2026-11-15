"""The dashboard's Requeue button must preserve premium / human-queue fields when moving a
task from blocked/done/archived back to pending/ (2026-11-15, mirrors chat-task-requeue.js
:134-141). Without this, a manual requeue silently downgrades a task that was explicitly
marked as premium or human-queued.

Run: .venv/bin/python -m unittest python.dashboard.test_task_requeue_premium -v
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


class TestRequeuePreservesPremiumFields(unittest.TestCase):
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
            "id": task_id,
            "source": "arch_review",
            "status": "pending",
            "history": [{"stage": "created", "at": "x"}],
            **extra,
        }
        (d / f"{task_id}.json").write_text(json.dumps(rec))

    def get_pending(self, task_id):
        return json.loads((self.q / "pending" / f"{task_id}.json").read_text())

    def test_requeue_from_blocked_preserves_premium_fields(self):
        self.put(
            "blocked",
            "premium-1",
            premiumPriority=True,
            premiumSetBy="test-user",
            premiumSetAt="2026-11-15T00:00:00Z",
            humanQueued=True,
            blockedReason="needs review",
        )
        r = self.client.post("/api/task/blocked/premium-1/requeue")
        self.assertEqual(r.status_code, 200)
        rec = self.get_pending("premium-1")
        self.assertTrue(rec["premiumPriority"])
        self.assertEqual(rec["premiumSetBy"], "test-user")
        self.assertEqual(rec["premiumSetAt"], "2026-11-15T00:00:00Z")
        self.assertTrue(rec["humanQueued"])
        self.assertFalse((self.q / "blocked" / "premium-1.json").exists())

    def test_requeue_from_done_preserves_premium_fields(self):
        self.put(
            "done",
            "premium-2",
            premiumPriority=True,
            premiumSetBy="cli",
            premiumSetAt="2026-11-14T12:00:00Z",
            humanQueued=False,
        )
        r = self.client.post("/api/task/done/premium-2/requeue")
        self.assertEqual(r.status_code, 200)
        rec = self.get_pending("premium-2")
        self.assertTrue(rec["premiumPriority"])
        self.assertEqual(rec["premiumSetBy"], "cli")
        self.assertEqual(rec["premiumSetAt"], "2026-11-14T12:00:00Z")
        self.assertFalse(rec["humanQueued"])

    def test_requeue_from_archived_preserves_premium_fields(self):
        self.put(
            "done",
            "premium-3",
            premiumPriority=True,
            premiumSetBy="chat",
            premiumSetAt="2026-11-13T08:00:00Z",
            humanQueued=True,
        )
        # First archive it
        r = self.client.post("/api/task/done/premium-3/archive", json={"reason": "test"})
        self.assertEqual(r.status_code, 200)
        # Now requeue from archived
        r = self.client.post("/api/task/archived/premium-3/requeue")
        self.assertEqual(r.status_code, 200)
        rec = self.get_pending("premium-3")
        self.assertTrue(rec["premiumPriority"])
        self.assertEqual(rec["premiumSetBy"], "chat")
        self.assertEqual(rec["premiumSetAt"], "2026-11-13T08:00:00Z")
        self.assertTrue(rec["humanQueued"])

    def test_requeue_without_premium_fields_does_not_add_them(self):
        self.put("blocked", "no-premium-1", blockedReason="x")
        r = self.client.post("/api/task/blocked/no-premium-1/requeue")
        self.assertEqual(r.status_code, 200)
        rec = self.get_pending("no-premium-1")
        self.assertNotIn("premiumPriority", rec)
        self.assertNotIn("premiumSetBy", rec)
        self.assertNotIn("premiumSetAt", rec)
        self.assertNotIn("humanQueued", rec)

    def test_requeue_preserves_existing_coordination_fields(self):
        """Confirm the coordination-field allowlist still works alongside the new premium one."""
        self.put(
            "blocked",
            "coord-1",
            stacked={"branch": "feat-x", "seq": 2, "total": 5},
            dependsOn=["HUB0001"],
            atomic=True,
            noDecompose=True,
            prerequisiteHubs=["HUB0002"],
        )
        r = self.client.post("/api/task/blocked/coord-1/requeue")
        self.assertEqual(r.status_code, 200)
        rec = self.get_pending("coord-1")
        self.assertEqual(rec["stacked"], {"branch": "feat-x", "seq": 2, "total": 5})
        self.assertEqual(rec["dependsOn"], ["HUB0001"])
        self.assertTrue(rec["atomic"])
        self.assertTrue(rec["noDecompose"])
        self.assertEqual(rec["prerequisiteHubs"], ["HUB0002"])


if __name__ == "__main__":
    unittest.main()
