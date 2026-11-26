"""Tests for the needs-clarification answer flow (routes/task.py).

Covers the three cases called out by HUB0920:
  1. A fixture task answered through /api/task/needs-clarification/<id>/answer
     is moved out of needs-clarification with the answer in its history.
  2. A wrong project name returns an error naming the registered projects.
  3. A route answer that cannot be applied returns an error rather than
     answered:true.

Run: python -m unittest python.dashboard.routes.test_task -v
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent))

import app  # noqa: E402


class AnswerClarificationTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.queue = root / "queue"
        (self.queue / "needs-clarification").mkdir(parents=True)
        (self.queue / "adhoc").mkdir(parents=True)
        self._patches = [
            mock.patch.object(app, "queue_dir", return_value=self.queue),
            mock.patch.object(app, "_record_manual_requeue", return_value=None),
        ]
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

    # --- Case 1: answer moves the task out of needs-clarification with the answer in history ---

    def test_answered_task_is_moved_out_of_needs_clarification(self):
        self._write_held_task("t1")
        resp = self.client.post(
            "/api/task/needs-clarification/t1/answer",
            json={"answer": "use option A"},
        )
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertFalse(
            (self.queue / "needs-clarification" / "t1.json").exists(),
            "the source file must be removed",
        )
        self.assertTrue(
            (self.queue / "adhoc" / "t1.json").is_file(),
            "the task must land in adhoc/ for a fresh draft pass",
        )

    def test_answered_task_carries_the_answer_in_prompt_context_raw_text(self):
        self._write_held_task("t1")
        self.client.post(
            "/api/task/needs-clarification/t1/answer",
            json={"answer": "use option A"},
        )
        data = json.loads((self.queue / "adhoc" / "t1.json").read_text())
        self.assertIn(
            "use option A",
            data["promptContext"]["rawText"],
            "the answer must be folded into promptContext.rawText",
        )
        self.assertIn(
            "HUMAN DESIGN DECISION",
            data["promptContext"]["rawText"],
            "the answer block must be tagged with the human-decision header",
        )

    def test_answered_task_has_a_needs_clarification_resolved_history_event(self):
        self._write_held_task("t1")
        self.client.post(
            "/api/task/needs-clarification/t1/answer",
            json={"answer": "use option A"},
        )
        data = json.loads((self.queue / "adhoc" / "t1.json").read_text())
        stages = [h.get("stage") for h in data.get("history") or []]
        self.assertIn(
            "needs-clarification-resolved",
            stages,
            "history must record that the clarification was answered",
        )

    # --- Case 2: wrong project name returns an error naming the registered projects ---

    def test_wrong_project_name_returns_400_naming_registered_projects(self):
        self._write_held_task("t1")
        resp = self.client.post(
            "/api/task/needs-clarification/t1/answer",
            json={"answer": "use option A", "project": "no-such-project"},
        )
        self.assertEqual(resp.status_code, 400, resp.get_data(as_text=True))
        body = json.loads(resp.get_data(as_text=True))
        self.assertIn(
            "valid projects",
            body.get("description", "").lower(),
            "the error must name the registered projects so the caller can pick one",
        )
        # The source file is untouched on a validation failure.
        self.assertTrue(
            (self.queue / "needs-clarification" / "t1.json").exists(),
            "nothing must change when the project is invalid",
        )

    # --- Case 3: a route answer that cannot be applied returns an error rather than answered:true ---

    def test_answer_on_a_task_that_does_not_exist_returns_404_not_answered_true(self):
        resp = self.client.post(
            "/api/task/needs-clarification/does-not-exist/answer",
            json={"answer": "use option A"},
        )
        self.assertEqual(resp.status_code, 404)
        body = json.loads(resp.get_data(as_text=True))
        self.assertNotIn("answered", body, "must not report answered:true for a missing task")

    def test_answer_with_empty_body_returns_400_not_answered_true(self):
        self._write_held_task("t1")
        resp = self.client.post(
            "/api/task/needs-clarification/t1/answer",
            json={"answer": ""},
        )
        self.assertEqual(resp.status_code, 400, resp.get_data(as_text=True))
        body = json.loads(resp.get_data(as_text=True))
        self.assertNotIn("answered", body, "must not report answered:true for a rejected answer")


if __name__ == "__main__":
    unittest.main()
