"""Tests for the clean-slate fix on /resolve and /answer (routes/task.py).

Root-caused live 2026-09-17: both routes move a held task from
queue/needs-clarification/ into queue/adhoc/ "for a fresh draft pass", but neither
cleared the STALE blockedReason/blockedStage/status/localRejectCount fields the task
already carried from BEFORE it was escalated -- landing back in adhoc/ still reading
status:'blocked', blockedStage:'review', localRejectCount already at the retry cap made
the task indistinguishable from an already-exhausted blocked task, so it sat
permanently inert instead of ever getting the promised fresh attempt.

Run: .venv/bin/python -m unittest python.dashboard.test_needs_clarification_clean_slate -v
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes.task import _clean_slate_for_fresh_adhoc_attempt  # noqa: E402


class CleanSlateHelperTest(unittest.TestCase):
    def test_strips_every_stale_blocked_field_and_resets_status(self):
        data = {
            "id": "t1",
            "status": "blocked",
            "blockedReason": "old review rejection",
            "blockedStage": "review",
            "localRejectCount": 2,
            "priorRejectionFeedback": ["stale feedback"],
            "rawDiff": "stale diff",
            "needsClarification": {"reason": "design-decision"},
            "promptContext": {"rawText": "do the thing"},
        }
        _clean_slate_for_fresh_adhoc_attempt(data)
        for field in ("blockedReason", "blockedStage", "localRejectCount",
                      "priorRejectionFeedback", "rawDiff", "needsClarification"):
            self.assertNotIn(field, data, f"{field} must be stripped")
        self.assertEqual(data["status"], "pending")
        # Unrelated fields survive untouched.
        self.assertEqual(data["id"], "t1")
        self.assertEqual(data["promptContext"]["rawText"], "do the thing")

    def test_leaves_a_non_blocked_status_alone(self):
        data = {"id": "t1", "status": "coordinating"}
        _clean_slate_for_fresh_adhoc_attempt(data)
        self.assertEqual(data["status"], "coordinating")

    def test_no_op_on_a_task_with_none_of_the_stale_fields(self):
        data = {"id": "t1", "promptContext": {"rawText": "x"}}
        _clean_slate_for_fresh_adhoc_attempt(data)
        self.assertEqual(data, {"id": "t1", "promptContext": {"rawText": "x"}})


class RouteIntegrationTestBase(unittest.TestCase):
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

    def _write_held_task(self, task_id, extra):
        task = {
            "id": task_id,
            "status": "blocked",
            "blockedStage": "review",
            "blockedReason": "old rejection from before this was ever escalated",
            "localRejectCount": 2,
            "history": [],
            "promptContext": {"rawText": "original task text"},
            "needsClarification": {"reason": "design-decision", "openQuestions": "which approach?"},
            **extra,
        }
        (self.queue / "needs-clarification" / f"{task_id}.json").write_text(json.dumps(task))
        return task


class AnswerClearsCleanSlateTest(RouteIntegrationTestBase):
    def test_answer_clears_stale_blocked_fields_so_the_task_is_actually_fresh(self):
        self._write_held_task("t1", {})
        resp = self.client.post("/api/task/needs-clarification/t1/answer", json={"answer": "use option A"})
        self.assertEqual(resp.status_code, 200)

        dest = self.queue / "adhoc" / "t1.json"
        self.assertTrue(dest.is_file(), "must land in adhoc/ for a fresh draft pass")
        data = json.loads(dest.read_text())
        self.assertNotIn("blockedReason", data)
        self.assertNotIn("blockedStage", data)
        self.assertNotIn("localRejectCount", data)
        self.assertNotIn("needsClarification", data)
        self.assertEqual(data["status"], "pending", "must not still read as blocked")
        self.assertIn("use option A", data["promptContext"]["rawText"])


class ResolveClearsCleanSlateTest(RouteIntegrationTestBase):
    def test_resolve_clears_stale_blocked_fields_so_the_task_is_actually_fresh(self):
        self._write_held_task("t2", {})
        resp = self.client.post("/api/task/needs-clarification/t2/resolve", json={"paths": ["src/foo.js"]})
        self.assertEqual(resp.status_code, 200)

        dest = self.queue / "adhoc" / "t2.json"
        self.assertTrue(dest.is_file())
        data = json.loads(dest.read_text())
        self.assertNotIn("blockedReason", data)
        self.assertNotIn("blockedStage", data)
        self.assertNotIn("localRejectCount", data)
        self.assertNotIn("needsClarification", data)
        self.assertEqual(data["status"], "pending")
        self.assertEqual(data["promptContext"]["prefetchedPaths"], ["src/foo.js"])


if __name__ == "__main__":
    unittest.main()
