"""Re-review: send a review-stage-blocked task back to review with its draft intact (no redraft).

The single implementation is src/rereview-task.js; the dashboard route runs it as a subprocess, and the
task-list summary exposes `rereviewable` so the Re-review button appears exactly when the primitive would
accept the task.

Run: .venv/bin/python -m unittest python.dashboard.test_rereview_route -v
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


def _task(**kw):
    t = {"id": "t1", "source": "function_length_review", "status": "blocked",
         "implementResponse": "A prose FALSE POSITIVE verdict.", "blockedStage": "review",
         "blockedReason": "gate", "history": []}
    t.update(kw)
    return t


class TaskSummaryRereviewableTest(unittest.TestCase):
    def test_rereviewable_only_for_review_stage_block_with_a_draft(self):
        self.assertTrue(app.task_summary(_task(), "t1.json")["rereviewable"])
        self.assertFalse(app.task_summary(_task(implementResponse="  "), "t1.json")["rereviewable"])
        self.assertFalse(app.task_summary(_task(blockedStage="draft"), "t1.json")["rereviewable"])
        self.assertFalse(app.task_summary(_task(blockedStage=None), "t1.json")["rereviewable"])


class RereviewRouteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pipe = Path(self.tmp.name)
        (self.pipe / "queue" / "needs-clarification").mkdir(parents=True)
        (self.pipe / "queue" / "needs-clarification" / "t1.json").write_text(json.dumps(_task()))
        (self.pipe / "queue" / "needs-clarification" / "nodraft.json").write_text(json.dumps(_task(id="nodraft", implementResponse="")))
        self.env = {"AGENT_MANAGER_PIPELINE_DIR": str(self.pipe), "AGENT_MANAGER_REPO_ROOT": str(self.pipe)}
        p = mock.patch.dict(os.environ, self.env)
        p.start()
        self.addCleanup(p.stop)
        p2 = mock.patch.object(app, "read_env_file", return_value={})
        p2.start()
        self.addCleanup(p2.stop)
        self.client = app.app.test_client()

    def test_moves_the_task_to_review_keeping_the_draft(self):
        resp = self.client.post("/api/task/needs-clarification/t1/rereview", json={"reason": "gate fixed"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertTrue(resp.get_json()["ok"])
        moved = json.loads((self.pipe / "queue" / "review" / "t1.json").read_text())
        self.assertEqual(moved["implementResponse"], "A prose FALSE POSITIVE verdict.")
        self.assertNotIn("blockedStage", moved)
        self.assertFalse((self.pipe / "queue" / "needs-clarification" / "t1.json").exists())

    def test_a_task_with_no_draft_is_refused_with_409_and_left_alone(self):
        resp = self.client.post("/api/task/needs-clarification/nodraft/rereview")
        self.assertEqual(resp.status_code, 409)
        self.assertIn("no draft to re-review", resp.get_json()["error"])
        self.assertTrue((self.pipe / "queue" / "needs-clarification" / "nodraft.json").exists())

    def test_only_blocked_or_needs_clarification_states_are_accepted(self):
        self.assertEqual(self.client.post("/api/task/done/t1/rereview").status_code, 400)


if __name__ == "__main__":
    unittest.main()
