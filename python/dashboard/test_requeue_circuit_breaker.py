"""Tests for the circuit_breaker 409 guard on /api/task/<state>/<id>/requeue.

A blocked task with circuitBreaker: true must be refused with HTTP 409 and
{"error": "circuit_breaker"}, must stay in queue/blocked/, and must create nothing
under queue/pending/. A circuitBreaker value that is not exactly True must not trip the guard.

Uses the same ENV_FILE_PATH-override + Flask test_client() pattern as
test_requeue_preserves_coordination_fields.py.

Run: python3 -m unittest python.dashboard.test_requeue_circuit_breaker -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class RequeueCircuitBreakerTest(unittest.TestCase):
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

    def test_circuit_breaker_true_refuses_requeue_and_keeps_file_blocked(self):
        task_id = "adhoc-circuit-breaker-guard-test-1"
        blocked_path = self._write_blocked(task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "tripped task",
            "promptContext": {"rawText": "fix it"},
            "circuitBreaker": True,
            "factCheckRejections": 3,
            "blockedReason": "CIRCUIT BREAKER: fact-check rejected this draft 3 times",
        })

        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.get_json(), {"error": "circuit_breaker"})
        self.assertTrue(blocked_path.is_file(), "the task must stay in queue/blocked/")
        pending_path = self.pipeline_dir / "queue" / "pending" / f"{task_id}.json"
        self.assertFalse(pending_path.exists(), "nothing may be written to queue/pending/")

    def test_non_true_circuit_breaker_value_does_not_trip_guard(self):
        task_id = "adhoc-circuit-breaker-guard-test-2"
        self._write_blocked(task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "not tripped",
            "promptContext": {"rawText": "fix it"},
            "circuitBreaker": "yes",
            "blockedReason": "Plan pass degenerate: empty",
        })

        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        body = resp.get_json(silent=True) or {}
        self.assertNotEqual(body.get("error"), "circuit_breaker",
                            "a non-bool circuitBreaker value must not trip the guard")


if __name__ == "__main__":
    unittest.main()
