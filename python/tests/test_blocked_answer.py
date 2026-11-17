"""Tests for POST /api/task/blocked/<id>/answer (HUB0576 2/3).

Covers: 200 on a valid answer (record moved blocked->pending, answer appended to
promptContext.rawText, an 'answered' history event appended); 404 for an unknown id and
400 for an empty answer, both leaving the stored record unchanged; a requeue/re-block/
answer cycle that keeps both answers; and parity with the needs-clarification answer route.

Uses the same ENV_FILE_PATH-override + Flask test_client() pattern as
python/dashboard/test_requeue_preserves_history.py.

Run: .venv/bin/python -m unittest python.tests.test_blocked_answer -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "dashboard"))

import app  # noqa: E402


class BlockedAnswerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_env_path = app.ENV_FILE_PATH
        app.ENV_FILE_PATH = Path(self._tmp.name) / "agent-manager.env"
        self._saved = {k: os.environ.get(k) for k in
                       ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PIPELINE_DIR")}
        for k in self._saved:
            os.environ.pop(k, None)
        self.pipeline_dir = Path(self._tmp.name) / "pipeline"
        self.queue = self.pipeline_dir / "queue"
        for sub in ("blocked", "pending", "adhoc", "needs-clarification"):
            (self.queue / sub).mkdir(parents=True, exist_ok=True)
        app.ENV_FILE_PATH.write_text(f"AGENT_MANAGER_PIPELINE_DIR={self.pipeline_dir}\n", encoding="utf-8")
        self.client = app.app.test_client()

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    # ---- helpers ----

    def _path(self, state, task_id):
        return self.queue / state / f"{task_id}.json"

    def _write(self, state, task_id, data):
        p = self._path(state, task_id)
        p.write_text(json.dumps(data), encoding="utf-8")
        return p

    def _blocked_record(self, task_id, raw_text="Original task text"):
        return {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "T",
            "status": "blocked",
            "blockedReason": "needs a human answer",
            "promptContext": {"rawText": raw_text},
            "history": [{"stage": "blocked", "at": "2026-11-01T00:00:00Z"}],
        }

    def _answer(self, task_id, answer):
        return self.client.post(f"/api/task/blocked/{task_id}/answer", json={"answer": answer})

    # ---- 200: valid answer ----

    def test_valid_answer_returns_200_and_moves_record_to_pending(self):
        task_id = "blocked-ans-1"
        self._write("blocked", task_id, self._blocked_record(task_id))

        resp = self._answer(task_id, "Use option B")
        self.assertEqual(resp.status_code, 200)

        self.assertFalse(self._path("blocked", task_id).exists())
        pending = json.loads(self._path("pending", task_id).read_text(encoding="utf-8"))
        self.assertEqual(pending["id"], task_id)
        self.assertEqual(pending["promptContext"]["rawText"].count("Original task text"), 1)
        self.assertIn("Use option B", pending["promptContext"]["rawText"])

    def test_valid_answer_appends_answered_history_event(self):
        task_id = "blocked-ans-2"
        self._write("blocked", task_id, self._blocked_record(task_id))

        self.assertEqual(self._answer(task_id, "Proceed").status_code, 200)

        pending = json.loads(self._path("pending", task_id).read_text(encoding="utf-8"))
        stages = [h.get("stage") for h in pending["history"]]
        self.assertIn("answered", stages)
        self.assertEqual(stages[0], "blocked")

    # ---- 404 / 400: record unchanged ----

    def test_unknown_id_returns_404_and_leaves_existing_record_unchanged(self):
        real_id = "blocked-real-1"
        real_path = self._write("blocked", real_id, self._blocked_record(real_id))
        before = real_path.read_bytes()

        resp = self._answer("blocked-missing-1", "Some answer")
        self.assertEqual(resp.status_code, 404)

        self.assertEqual(real_path.read_bytes(), before)
        self.assertFalse(self._path("blocked", "blocked-missing-1").exists())
        self.assertFalse(self._path("pending", "blocked-missing-1").exists())
        self.assertFalse(self._path("pending", real_id).exists())

    def test_empty_answer_returns_400_and_leaves_record_unchanged(self):
        task_id = "blocked-empty-1"
        blocked_path = self._write("blocked", task_id, self._blocked_record(task_id))
        before = blocked_path.read_bytes()

        for empty in ("", "   \n\t "):
            resp = self._answer(task_id, empty)
            self.assertEqual(resp.status_code, 400, f"answer={empty!r}")
            self.assertEqual(blocked_path.read_bytes(), before, f"answer={empty!r}")
            self.assertFalse(self._path("pending", task_id).exists())

    # ---- requeue / re-block / answer again ----

    def test_answered_then_requeued_reblocked_and_answered_again_keeps_both_answers(self):
        task_id = "blocked-cycle-1"
        self._write("blocked", task_id, self._blocked_record(task_id))

        self.assertEqual(self._answer(task_id, "First answer").status_code, 200)

        # Simulate the pipeline re-blocking the task: move it from pending/ back to blocked/.
        pending_file = self._path("pending", task_id)
        reblocked = json.loads(pending_file.read_text(encoding="utf-8"))
        reblocked["status"] = "blocked"
        reblocked["blockedReason"] = "needs a second human answer"
        self._write("blocked", task_id, reblocked)
        pending_file.unlink()

        self.assertEqual(self._answer(task_id, "Second answer").status_code, 200)

        self.assertFalse(self._path("blocked", task_id).exists())
        final = json.loads(self._path("pending", task_id).read_text(encoding="utf-8"))
        raw = final["promptContext"]["rawText"]
        self.assertIn("First answer", raw)
        self.assertIn("Second answer", raw)
        self.assertLess(raw.index("First answer"), raw.index("Second answer"))
        answered = [h for h in final["history"] if h.get("stage") == "answered"]
        self.assertEqual(len(answered), 2)

    # ---- needs-clarification parity ----

    def test_needs_clarification_answer_matches_blocked_contract_on_success(self):
        task_id = "nc-parity-1"
        self._write("needs-clarification", task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "T",
            "status": "needs-clarification",
            "promptContext": {"rawText": "Original task text"},
            "history": [{"stage": "needs-clarification", "at": "2026-11-01T00:00:00Z"}],
        })

        resp = self.client.post(
            f"/api/task/needs-clarification/{task_id}/answer",
            json={"answer": "Go with option B"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(self._path("needs-clarification", task_id).exists())
        adhoc = json.loads(self._path("adhoc", task_id).read_text(encoding="utf-8"))
        self.assertIn("Go with option B", adhoc["promptContext"]["rawText"])

    def test_needs_clarification_empty_answer_matches_blocked_400_and_leaves_record_unchanged(self):
        task_id = "nc-parity-2"
        nc_path = self._write("needs-clarification", task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "T",
            "promptContext": {"rawText": "Original task text"},
            "history": [],
        })
        before = nc_path.read_bytes()

        resp = self.client.post(f"/api/task/needs-clarification/{task_id}/answer", json={"answer": "  "})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(nc_path.read_bytes(), before)
        self.assertFalse(self._path("adhoc", task_id).exists())


if __name__ == "__main__":
    unittest.main()
