"""Tests that /api/task/<state>/<id>/requeue carries promptContext.priorVerdict over to the rebuilt pending task.

branch_verdicts.write_task_log stamps a chat/manual needs-work verdict there precisely because the requeue's
"fresh" rebuild drops every drafting artifact (including priorRejectionFeedback) but keeps promptContext verbatim;
src/lib/prompt-blocks.js priorVerdictBlock then shows it to the redraft. Same ENV_FILE_PATH-override + Flask
test_client() pattern as test_requeue_preserves_history.py.

Run: .venv/bin/python -m unittest python.dashboard.test_requeue_preserves_prior_verdict -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class RequeuePreservesPriorVerdictTest(unittest.TestCase):
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

    def _write(self, state, task_id, data):
        d = self.pipeline_dir / "queue" / state
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{task_id}.json").write_text(json.dumps(data), encoding="utf-8")

    def test_requeue_from_done_keeps_prior_verdict_while_dropping_prior_rejection_feedback(self):
        task_id = "arch-review-ac-50"
        pv = {"verdict": "needs-work", "reasons": ["keep the return type `any`"], "sha": "c62aa839", "source": "chat", "branch": "agent/arch-review-ac-50"}
        self._write("done", task_id, {
            "id": task_id, "domain": "default", "source": "arch_review", "title": "T",
            "promptContext": {"candidateId": "AC-50", "body": "the body", "priorVerdict": pv},
            "priorRejectionFeedback": ["a pipeline rejection"], "implementResponse": "old draft",
            "history": [{"stage": "branch-verdict", "at": "1", "detail": "branch verdict: needs-work (chat) -- cut"}],
            "terminalDisposition": "merged",
        })
        resp = self.client.post(f"/api/task/done/{task_id}/requeue")
        self.assertEqual(resp.status_code, 200)
        data = json.loads((self.pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text())
        self.assertEqual(data["promptContext"]["priorVerdict"], pv)
        self.assertEqual(data["promptContext"]["candidateId"], "AC-50")
        self.assertNotIn("priorRejectionFeedback", data)
        self.assertNotIn("implementResponse", data)

    def test_requeue_of_a_task_with_no_prior_verdict_does_not_invent_one(self):
        task_id = "adhoc-plain-1"
        self._write("blocked", task_id, {"id": task_id, "domain": "adhoc", "source": "manual", "title": "T",
                                         "promptContext": {"rawText": "ask"}, "history": []})
        self.assertEqual(self.client.post(f"/api/task/blocked/{task_id}/requeue").status_code, 200)
        data = json.loads((self.pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text())
        self.assertNotIn("priorVerdict", data["promptContext"])


if __name__ == "__main__":
    unittest.main()
