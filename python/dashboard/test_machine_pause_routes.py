"""Tests for the machine pause routes (routes/pause.py, nested under the instances blueprint): GET /api/pause, POST /api/pause/<scope> and
POST /api/resume/<scope> write or remove the `_pause-node` / `_pause-global` markers of src/worker-switch.js, and the in-process status read
(worker_switch.pause_status) agrees with the node rule. The marker directory is a temp dir through AGENT_MANAGER_DISABLED_WORKERS_DIR and the pipeline
start/stop/restart helpers are replaced by sentinels that fail the test if they are ever called.

Run: .venv/bin/python -m unittest python.dashboard.test_machine_pause_routes -v
"""
import json
import os
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import worker_switch  # noqa: E402


class PauseFixture(unittest.TestCase):
    """Shared setup: a temp marker directory through AGENT_MANAGER_DISABLED_WORKERS_DIR and sentinels that fail the test if a pipeline helper is called."""

    @staticmethod
    def _never_called(name):
        def fail(*args, **kwargs):
            raise AssertionError(f"{name} must not be called by the machine pause")
        return fail

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.switches = Path(self._tmp.name) / "switches"
        self._env = mock.patch.dict(os.environ, {"AGENT_MANAGER_DISABLED_WORKERS_DIR": str(self.switches)})
        self._env.start()
        self._patches = [
            mock.patch.object(app, "_restart_pipeline", self._never_called("_restart_pipeline")),
            mock.patch.object(app, "_stop_pipeline", self._never_called("_stop_pipeline")),
            mock.patch.object(app, "_start_pipeline", self._never_called("_start_pipeline")),
        ]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._env.stop()
        self._tmp.cleanup()

    def _marker(self, scope):
        return json.loads((self.switches / f"_pause-{scope}").read_text(encoding="utf-8"))


class MachinePauseRoutesTest(PauseFixture):
    """GET /api/pause, POST /api/pause/<scope> and POST /api/resume/<scope>."""

    def test_nothing_is_paused_by_default(self):
        r = self.client.get("/api/pause")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json(), {"node": None, "global": None, "workers": []})

    def test_pausing_a_machine_writes_the_marker_with_source_dashboard_reason_and_expiry_and_status_shows_it(self):
        r = self.client.post("/api/pause/node", json={"reason": "demo", "ttlMin": 15})
        self.assertEqual(r.status_code, 200)
        marker = self._marker("node")
        self.assertEqual((marker["scope"], marker["source"], marker["reason"]), ("node", "dashboard", "demo"))
        self.assertIsNotNone(marker["expiresAt"])
        got = self.client.get("/api/pause").get_json()
        self.assertEqual(got["node"], marker)
        self.assertIsNone(got["global"])
        self.assertEqual(r.get_json()["node"], marker)

    def test_a_pause_without_ttl_lasts_until_resumed_and_a_global_pause_is_separate(self):
        self.client.post("/api/pause/global", json={})
        marker = self._marker("global")
        self.assertIsNone(marker["expiresAt"])
        self.assertEqual(marker["reason"], "")
        self.assertFalse((self.switches / "_pause-node").exists())
        self.assertIsNone(self.client.get("/api/pause").get_json()["node"])

    def test_resume_removes_only_that_scope_and_is_idempotent(self):
        self.client.post("/api/pause/node", json={})
        self.client.post("/api/pause/global", json={})
        r = self.client.post("/api/resume/node")
        self.assertEqual(r.status_code, 200)
        self.assertFalse((self.switches / "_pause-node").exists())
        self.assertTrue((self.switches / "_pause-global").is_file())
        self.assertEqual(self.client.post("/api/resume/node").status_code, 200)
        self.assertIsNone(r.get_json()["node"])
        self.assertIsNotNone(r.get_json()["global"])

    def test_a_bad_scope_is_400_for_pause_and_resume_and_writes_nothing(self):
        for scope in ("everything", "NODE", "worker-1", "node.json"):
            self.assertEqual(self.client.post(f"/api/pause/{scope}", json={}).status_code, 400, scope)
            self.assertEqual(self.client.post(f"/api/resume/{scope}").status_code, 400, scope)
        self.assertFalse(self.switches.exists() and any(self.switches.iterdir()))

    def test_bad_bodies_are_400_and_write_nothing(self):
        for body in ({"ttlMin": 0}, {"ttlMin": -5}, {"ttlMin": "10"}, {"ttlMin": True}, {"ttlMin": 99999}, {"reason": 5}, {"reason": ["x"]}):
            self.assertEqual(self.client.post("/api/pause/node", json=body).status_code, 400, body)
        self.assertFalse(self.switches.exists() and any(self.switches.iterdir()))

    def test_a_long_reason_is_cut_to_200_characters(self):
        self.client.post("/api/pause/node", json={"reason": "x" * 500})
        self.assertEqual(len(self._marker("node")["reason"]), 200)


class MachinePauseStatusTest(PauseFixture):
    """The in-process status read and its agreement with the node rule."""

    def test_an_expired_pause_reads_as_not_paused(self):
        self.switches.mkdir(parents=True)
        past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        (self.switches / "_pause-node").write_text(json.dumps({"scope": "node", "reason": "", "source": "x", "setAt": past, "expiresAt": past}), encoding="utf-8")
        self.assertIsNone(self.client.get("/api/pause").get_json()["node"])

    def test_the_status_read_never_starts_node_and_a_broken_switch_gives_500_on_write_but_a_readable_status(self):
        self.client.post("/api/pause/node", json={})
        with mock.patch.object(worker_switch, "_run", self._never_called("node (worker_switch._run)")):
            self.assertIsNotNone(self.client.get("/api/pause").get_json()["node"])
        with mock.patch.object(worker_switch, "_run", side_effect=OSError("node missing")):
            self.assertEqual(self.client.post("/api/pause/global", json={}).status_code, 500)
            self.assertEqual(self.client.post("/api/resume/node").status_code, 500)
            self.assertIsNotNone(self.client.get("/api/pause").get_json()["node"])

    def test_the_pause_routes_never_touch_the_pipeline(self):
        self.client.post("/api/pause/node", json={})
        self.client.post("/api/resume/node")

    def test_in_process_status_agrees_with_the_node_rule_for_every_marker_state(self):
        node = lambda *a: subprocess.run(["node", str(worker_switch.SWITCH_JS), *a], capture_output=True, text=True, env=os.environ.copy())
        self.switches.mkdir(parents=True)
        future = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
        past = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
        cases = {
            "active no expiry": json.dumps({"scope": "node", "expiresAt": None}),
            "active future": json.dumps({"scope": "node", "expiresAt": future}),
            "expired": json.dumps({"scope": "node", "expiresAt": past}),
            "bad expiry": json.dumps({"scope": "node", "expiresAt": "never"}),
            "not json": "{oops",
            "array": "[1]",
            "null": "null",
            "string": '"x"',
            "empty": "",
            "naive future local": json.dumps({"scope": "node", "expiresAt": (datetime.now() + timedelta(minutes=30)).isoformat()}),
            "naive past local": json.dumps({"scope": "node", "expiresAt": (datetime.now() - timedelta(minutes=30)).isoformat()}),
            "date only past": json.dumps({"scope": "node", "expiresAt": "2000-01-01"}),
        }
        for name, body in cases.items():
            (self.switches / "_pause-node").write_text(body, encoding="utf-8")
            (self.switches / "_pause-global").write_text(body, encoding="utf-8")
            mine = worker_switch.pause_status()
            theirs = json.loads(node("pause-status").stdout)
            self.assertEqual(mine, theirs, name)
        (self.switches / "_pause-node").unlink()
        (self.switches / "worker-cloud").write_text("{}", encoding="utf-8")
        self.assertEqual(worker_switch.pause_status(), json.loads(node("pause-status").stdout))

    def test_read_pause_unknown_scope_and_missing_file_are_none(self):
        self.assertIsNone(worker_switch.read_pause("everything"))
        self.assertIsNone(worker_switch.read_pause("node"))
        self.assertEqual(worker_switch.PAUSE_SCOPES, ("node", "global"))


class MachinePauseWriterTest(PauseFixture):
    """worker_switch.read_pause / set_pause / clear_pause edge cases."""

    def test_read_pause_is_exactly_not_paused_at_the_expiry_instant_and_paused_a_moment_before(self):
        self.switches.mkdir(parents=True)
        at = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
        (self.switches / "_pause-node").write_text(json.dumps({"scope": "node", "expiresAt": at.isoformat().replace("+00:00", "Z")}), encoding="utf-8")
        self.assertIsNone(worker_switch.read_pause("node", now=at))
        self.assertIsNotNone(worker_switch.read_pause("node", now=at - timedelta(seconds=1)))

    def test_a_scope_that_climbs_out_of_the_directory_reads_as_none(self):
        self.switches.mkdir(parents=True)
        (self.switches / "_pause-node").mkdir()
        (self.switches.parent / "x").write_text(json.dumps({"scope": "node", "expiresAt": None}), encoding="utf-8")
        self.assertIsNone(worker_switch.read_pause("node/../../x"))

    def test_set_and_clear_refuse_an_unknown_scope_without_starting_node(self):
        with mock.patch.object(worker_switch, "_run", self._never_called("node (worker_switch._run)")):
            ok, error = worker_switch.set_pause("everything", "r", 5)
            self.assertFalse(ok)
            self.assertIn("not a pause scope", error)
            ok, error = worker_switch.clear_pause("everything")
            self.assertFalse(ok)
            self.assertIn("not a pause scope", error)

    def test_a_failing_cli_is_reported_and_the_routes_answer_500_with_its_message(self):
        failed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="disk full")
        with mock.patch.object(worker_switch, "_run", return_value=failed):
            self.assertEqual(worker_switch.set_pause("node"), (False, "disk full"))
            self.assertEqual(worker_switch.clear_pause("node"), (False, "disk full"))
            client = app.app.test_client()
            for r in (client.post("/api/pause/node", json={}), client.post("/api/resume/node")):
                self.assertEqual(r.status_code, 500)
                self.assertIn("disk full", r.get_json().get("description", r.get_data(as_text=True)))


if __name__ == "__main__":
    unittest.main()
