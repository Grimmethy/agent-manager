"""Tests for the 'feedback' body key on /api/task/<state>/<id>/requeue.

Covers the contract the requeue route establishes around operator feedback on a
manual requeue (2026-11-20):

  * A feedback string is stored in two places -- the 'requeued' history event
    under `requeueFeedback`, and the pending task's `priorRejectionFeedback`
    list (appended alongside any prior entries).
  * A requeue with no feedback leaves `requeueFeedback` absent from the history
    event and does NOT create a `priorRejectionFeedback` on the pending task.
  * The feedback is cleaned: control characters (C0 + DEL) are stripped, the
    result is trimmed, and the length is capped at REQUEUE_FEEDBACK_MAX_CHARS
    (2000).
  * A non-string feedback value is rejected with HTTP 400.

These tests must FAIL if the `priorRejectionFeedback` assignment is removed
from routes/task.py -- that is the load-bearing line the second and third
scenarios verify are present.

Uses the same ENV_FILE_PATH-override + Flask test_client() pattern as
test_requeue_circuit_breaker.py and test_requeue_preserves_history.py.

Run: python3 -m unittest python.dashboard.test_requeue_feedback -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class RequeueFeedbackTest(unittest.TestCase):
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
        app.ENV_FILE_PATH.write_text(
            f"AGENT_MANAGER_PIPELINE_DIR={self.pipeline_dir}\n",
            encoding="utf-8",
        )
        self.client = app.app.test_client()
        for state in ("blocked", "needs-clarification", "done"):
            (self.pipeline_dir / "queue" / state).mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _write_task(self, state, task_id, data):
        p = self.pipeline_dir / "queue" / state / f"{task_id}.json"
        p.write_text(json.dumps(data), encoding="utf-8")
        return p

    def _read_pending(self, task_id):
        return json.loads(
            (self.pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text()
        )

    def _requeue(self, state, task_id, body=None):
        return self.client.post(
            f"/api/task/{state}/{task_id}/requeue",
            data=json.dumps(body or {}),
            content_type="application/json",
        )

    # ------------------------------------------------------------------ scenarios

    def test_requeue_with_feedback_stores_it_in_history_and_prior_feedback(self):
        """A feedback string lands in BOTH the 'requeued' history event
        (as `requeueFeedback`) and the pending task's `priorRejectionFeedback`
        list (appended)."""
        task_id = "adhoc-requeue-feedback-test-1"
        self._write_task("blocked", task_id, {
            "id": task_id,
            "domain": "adhoc",
            "source": "manual",
            "title": "T",
            "history": [{"stage": "created", "at": "1"},
                        {"stage": "blocked", "at": "2", "detail": "bad diff"}],
            "blockedReason": "bad diff",
        })

        resp = self._requeue("blocked", task_id, {"feedback": "try a different approach"})
        self.assertEqual(resp.status_code, 200, resp.get_json())

        pending = self._read_pending(task_id)

        # priorRejectionFeedback: list, containing exactly the feedback we posted.
        self.assertIsInstance(pending.get("priorRejectionFeedback"), list)
        self.assertIn("try a different approach", pending["priorRejectionFeedback"])

        # The 'requeued' history event carries the same string as requeueFeedback.
        requeued_event = None
        for ev in pending["history"]:
            if isinstance(ev, dict) and ev.get("stage") == "requeued":
                requeued_event = ev
                break
        self.assertIsNotNone(requeued_event, "must have a 'requeued' history event")
        self.assertEqual(requeued_event.get("requeueFeedback"), "try a different approach")

    def test_requeue_with_feedback_appends_to_existing_prior_feedback(self):
        """If the task already has priorRejectionFeedback entries, the new
        feedback is APPENDED (not replaced)."""
        task_id = "adhoc-requeue-feedback-test-2"
        self._write_task("blocked", task_id, {
            "id": task_id,
            "domain": "adhoc",
            "source": "manual",
            "title": "T",
            "history": [{"stage": "created", "at": "1"}],
            "priorRejectionFeedback": ["earlier rejection 1", "earlier rejection 2"],
        })

        resp = self._requeue("blocked", task_id, {"feedback": "new feedback"})
        self.assertEqual(resp.status_code, 200, resp.get_json())

        pending = self._read_pending(task_id)
        prior = pending.get("priorRejectionFeedback", [])
        self.assertEqual(prior, ["earlier rejection 1", "earlier rejection 2", "new feedback"])

    def test_requeue_without_feedback_stores_nothing(self):
        """A requeue with NO feedback body key must NOT create priorRejectionFeedback
        on the pending task and must NOT add requeueFeedback to the history event.

        This test is the load-bearing check that the priorRejectionFeedback
        assignment in routes/task.py is actually doing work -- removing that
        assignment would make this test pass vacuously (no priorRejectionFeedback
        is created either way), so it is paired with the scenarios below that
        check the *presence* of the field when feedback IS posted."""
        task_id = "adhoc-requeue-feedback-test-3"
        self._write_task("blocked", task_id, {
            "id": task_id,
            "domain": "adhoc",
            "source": "manual",
            "title": "T",
            "history": [{"stage": "created", "at": "1"}],
        })

        resp = self._requeue("blocked", task_id)
        self.assertEqual(resp.status_code, 200, resp.get_json())

        pending = self._read_pending(task_id)

        # No priorRejectionFeedback key at all on the pending task.
        self.assertNotIn("priorRejectionFeedback", pending)

        # No requeueFeedback on the 'requeued' history event.
        requeued_event = None
        for ev in pending["history"]:
            if isinstance(ev, dict) and ev.get("stage") == "requeued":
                requeued_event = ev
                break
        self.assertIsNotNone(requeued_event)
        self.assertNotIn("requeueFeedback", requeued_event)

    def test_requeue_with_existing_prior_feedback_but_no_new_feedback_does_not_add(self):
        """A requeue without feedback must NOT add a new entry to
        priorRejectionFeedback -- the field is left absent on the fresh task."""
        task_id = "adhoc-requeue-feedback-test-4"
        self._write_task("blocked", task_id, {
            "id": task_id,
            "domain": "adhoc",
            "source": "manual",
            "title": "T",
            "history": [{"stage": "created", "at": "1"}],
            "priorRejectionFeedback": ["kept entry"],
        })

        resp = self._requeue("blocked", task_id)
        self.assertEqual(resp.status_code, 200, resp.get_json())

        pending = self._read_pending(task_id)
        # The route does NOT carry priorRejectionFeedback forward when there
        # is no new feedback -- the field is absent on the fresh task.
        self.assertNotIn("priorRejectionFeedback", pending)

    def test_requeue_with_long_feedback_strips_control_chars_and_caps_length(self):
        """5000 characters containing \\x00 and \\x07 must be stored as at most
        the cap length (2000) with NO control characters remaining. This is the
        load-bearing check for the cleaning function -- removing the cleaning
        line would let control characters through and exceed the cap."""
        task_id = "adhoc-requeue-feedback-test-5"
        # Build a 5000-char payload with embedded control chars at regular intervals.
        chunks = []
        for i in range(5000):
            if i % 100 == 0:
                chunks.append("\x00")  # NUL
            elif i % 100 == 1:
                chunks.append("\x07")  # BEL
            else:
                chunks.append("a")
        long_feedback = "".join(chunks)
        self.assertEqual(len(long_feedback), 5000)

        self._write_task("blocked", task_id, {
            "id": task_id,
            "domain": "adhoc",
            "source": "manual",
            "title": "T",
            "history": [{"stage": "created", "at": "1"}],
        })

        resp = self._requeue("blocked", task_id, {"feedback": long_feedback})
        self.assertEqual(resp.status_code, 200, resp.get_json())

        pending = self._read_pending(task_id)
        prior = pending.get("priorRejectionFeedback", [])
        self.assertTrue(prior, "priorRejectionFeedback must be non-empty after cleaning")
        stored = prior[-1]

        # Length cap enforced.
        self.assertLessEqual(len(stored), 2000)

        # No control characters (C0: \\x00-\\x1f, DEL: \\x7f) anywhere in the stored value.
        for ch in stored:
            code = ord(ch)
            self.assertNotIn(code, list(range(0x00, 0x20)) + [0x7f],
                             f"control character U+{code:04X} must be stripped")

    def test_requeue_with_non_string_feedback_returns_400(self):
        """A non-string feedback value must be rejected with HTTP 400 and must
        leave the source task where it is (nothing moved to pending/)."""
        task_id = "adhoc-requeue-feedback-test-6"
        self._write_task("blocked", task_id, {
            "id": task_id,
            "domain": "adhoc",
            "source": "manual",
            "title": "T",
            "history": [{"stage": "created", "at": "1"}],
        })
        blocked_path = self.pipeline_dir / "queue" / "blocked" / f"{task_id}.json"

        for bad_value in (42, True, ["list"], None, {}):
            resp = self._requeue("blocked", task_id, {"feedback": bad_value})
            self.assertEqual(resp.status_code, 400,
                             f"expected 400 for feedback={bad_value!r}, got {resp.status_code}: {resp.get_json()}")
            # The task must stay where it was -- no side effect on a rejected request.
            self.assertTrue(blocked_path.is_file(),
                            f"blocked task must remain for feedback={bad_value!r}")
            pending_path = self.pipeline_dir / "queue" / "pending" / f"{task_id}.json"
            self.assertFalse(pending_path.exists(),
                             f"nothing may be written to pending/ for feedback={bad_value!r}")

    def test_requeue_feedback_from_needs_clarification_state(self):
        """Feedback works the same way from needs-clarification/ as from blocked/
        (only non-adhoc, non-manual, non-derived_task tasks are requeueable from
        needs-clarification -- the route 400s adhoc-shaped ones)."""
        task_id = "adhoc-requeue-feedback-test-7"
        self._write_task("needs-clarification", task_id, {
            "id": task_id,
            "domain": "default",
            "source": "observability_fix",
            "title": "T",
            "history": [{"stage": "created", "at": "1"},
                        {"stage": "needs-clarification", "at": "2"}],
        })

        resp = self._requeue("needs-clarification", task_id, {"feedback": "clarified"})
        self.assertEqual(resp.status_code, 200, resp.get_json())

        pending = self._read_pending(task_id)
        self.assertIn("clarified", pending.get("priorRejectionFeedback", []))
        requeued_event = next(
            (ev for ev in pending["history"] if isinstance(ev, dict) and ev.get("stage") == "requeued"),
            None,
        )
        self.assertIsNotNone(requeued_event)
        self.assertEqual(requeued_event.get("requeueFeedback"), "clarified")


if __name__ == "__main__":
    unittest.main()
