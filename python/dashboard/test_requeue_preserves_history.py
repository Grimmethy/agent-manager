"""Tests that /api/task/<state>/<id>/requeue APPENDS to a task's history instead of
replacing it wholesale (2026-09-12, real incident: observability-fix-ac-158 blocked, was
manually requeued, and by the time it reached done/ its full history was a single
"manually requeued from blocked/" entry -- the `blocked` history event that originally
carried the REAL blockedReason, plus every earlier stage, was gone. Root cause: this
endpoint's "fresh" rebuild stamped a brand-new one-entry `history` array instead of
appending to the existing one, even though task-history.js's whole design (see its own
header) is that history is the one append-only, complete log of a task's life -- nothing
else in the pipeline replaces it outright.

Uses the same ENV_FILE_PATH-override + Flask test_client() pattern as
test_requeue_preserves_coordination_fields.py.

Run: .venv/bin/python -m unittest python.dashboard.test_requeue_preserves_history -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class RequeuePreservesHistoryTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_env_path = app.ENV_FILE_PATH
        app.ENV_FILE_PATH = Path(self._tmp.name) / "agent-manager.env"
        self._saved = {k: os.environ.get(k) for k in
                       ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PIPELINE_DIR")}
        for k in self._saved:
            os.environ.pop(k, None)
        self.pipeline_dir = Path(self._tmp.name) / "pipeline"
        self.pipeline_dir.mkdir(parents=True, exist_ok=True)
        app.ENV_FILE_PATH.write_text(f"AGENT_MANAGER_PIPELINE_DIR={self.pipeline_dir}\n", encoding="utf-8")
        self.client = app.app.test_client()
        (self.pipeline_dir / "queue" / "blocked").mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _write_blocked(self, task_id, data):
        p = self.pipeline_dir / "queue" / "blocked" / f"{task_id}.json"
        p.write_text(json.dumps(data), encoding="utf-8")
        return p

    def test_requeue_appends_to_history_instead_of_replacing_it(self):
        task_id = "observability-fix-ac-999"
        original_history = [
            {"stage": "created", "at": "2026-09-11T20:00:00Z"},
            {"stage": "draft-started", "at": "2026-09-11T20:01:00Z"},
            {"stage": "blocked", "at": "2026-09-11T20:05:00Z", "detail": "the real reason this blocked"},
        ]
        self._write_blocked(task_id, {
            "id": task_id, "domain": "default", "source": "observability_fix",
            "title": "T", "history": original_history,
            "blockedReason": "the real reason this blocked",
        })

        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        self.assertEqual(resp.status_code, 200)

        pending_path = self.pipeline_dir / "queue" / "pending" / f"{task_id}.json"
        data = json.loads(pending_path.read_text())

        # Every original entry must still be present, in order, unmodified.
        self.assertEqual(data["history"][:3], original_history)
        # Plus exactly one new entry recording the requeue itself.
        self.assertEqual(len(data["history"]), 4)
        self.assertEqual(data["history"][3]["stage"], "requeued")
        self.assertEqual(data["history"][3]["note"], "manually requeued from blocked/")

    def test_requeue_carries_blockedReason_into_the_new_history_entry(self):
        # blockedReason itself is still dropped from the fresh working record (deliberate
        # -- a manual requeue is a clean redraft, per this endpoint's own docstring), but
        # it must not simply vanish: the new history entry it's folded into is the one
        # place it survives once the working record resets.
        task_id = "adhoc-something-1"
        self._write_blocked(task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "T",
            "history": [{"stage": "created", "at": "1"}],
            "blockedReason": "diff touches a forbidden file",
            "priorRejectionFeedback": ["earlier rejection text"],
        })

        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        self.assertEqual(resp.status_code, 200)

        data = json.loads((self.pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text())
        new_entry = data["history"][-1]
        self.assertEqual(new_entry["blockedReasonAtRequeue"], "diff touches a forbidden file")
        self.assertEqual(new_entry["priorRejectionFeedbackAtRequeue"], ["earlier rejection text"])

    def test_requeue_preserves_original_createdAt_not_the_requeue_time(self):
        task_id = "adhoc-something-2"
        self._write_blocked(task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "T",
            "createdAt": "2026-01-01T00:00:00Z",
            "history": [{"stage": "created", "at": "2026-01-01T00:00:00Z"}],
        })
        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        self.assertEqual(resp.status_code, 200)
        data = json.loads((self.pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text())
        self.assertEqual(data["createdAt"], "2026-01-01T00:00:00Z")


if __name__ == "__main__":
    unittest.main()
