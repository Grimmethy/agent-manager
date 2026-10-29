"""Tests for the Workers tab on/off switch routes: GET /api/instances carries `switchable` and `disabled` for worker lanes, and POST /api/instances/<id>/enabled
writes or removes the marker file (src/worker-switch.js). The marker directory is a temp dir through AGENT_MANAGER_DISABLED_WORKERS_DIR, and the pipeline
start/stop/restart helpers are replaced by sentinels that fail the test if they are ever called: this route must only touch a marker file.

Run: .venv/bin/python -m unittest python.dashboard.test_worker_switch_routes -v
"""
import json
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import worker_switch  # noqa: E402


def _never_called(name):
    def fail(*args, **kwargs):
        raise AssertionError(f"{name} must not be called by the worker switch")
    return fail


class WorkerSwitchRoutesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.inst = root / "instances"
        self.inst.mkdir()
        self.switches = root / "switches"
        now = datetime.now(timezone.utc).isoformat()
        for iid, status in (("worker-3090", "idle"), ("worker-cloud", "working"), ("reviewer", "idle")):
            (self.inst / f"{iid}.json").write_text(json.dumps({"instanceId": iid, "status": status, "lastHeartbeat": now}), encoding="utf-8")
        self._env = mock.patch.dict(os.environ, {"AGENT_MANAGER_DISABLED_WORKERS_DIR": str(self.switches)})
        self._env.start()
        self._patches = [
            mock.patch.object(app, "instances_dir", return_value=self.inst),
            mock.patch.object(app, "queue_dir", return_value=root / "queue"),
            mock.patch.object(app, "_active_project_label", return_value="p"),
            mock.patch.object(app, "_expected_instance_ids", return_value=["worker-3090", "worker-cloud", "worker-p40", "reviewer"]),
            mock.patch.object(app, "worker_lane_ids", return_value=["worker-3090", "worker-cloud", "worker-p40"]),
            mock.patch.object(app, "_restart_pipeline", _never_called("_restart_pipeline")),
            mock.patch.object(app, "_stop_pipeline", _never_called("_stop_pipeline")),
            mock.patch.object(app, "_start_pipeline", _never_called("_start_pipeline")),
        ]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._env.stop()
        self._tmp.cleanup()

    def _instances(self):
        return {i["instanceId"]: i for i in self.client.get("/api/instances").get_json()}

    def _set(self, iid, body):
        return self.client.post(f"/api/instances/{iid}/enabled", json=body)

    def test_worker_lanes_are_switchable_and_on_by_default_and_other_daemons_carry_no_switch(self):
        got = self._instances()
        for iid in ("worker-3090", "worker-cloud", "worker-p40"):
            self.assertIs(got[iid]["switchable"], True, iid)
            self.assertIs(got[iid]["disabled"], False, iid)
        self.assertNotIn("switchable", got["reviewer"])
        self.assertNotIn("disabled", got["reviewer"])

    def test_switching_off_sets_only_that_worker_creates_the_marker_and_survives_a_second_poll(self):
        r = self._set("worker-cloud", {"enabled": False})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json(), {"instanceId": "worker-cloud", "enabled": False, "disabled": True})
        self.assertTrue((self.switches / "worker-cloud").is_file())
        for _ in range(2):
            got = self._instances()
            self.assertIs(got["worker-cloud"]["disabled"], True)
            self.assertIs(got["worker-3090"]["disabled"], False)
        self.assertEqual(got["worker-cloud"]["status"], "working", "a worker still finishing a task keeps its real status; the UI reads disabled plus working as 'turning off'")

    def test_the_flag_also_shows_on_the_offline_placeholder_of_a_lane_with_no_heartbeat(self):
        self._set("worker-p40", {"enabled": False})
        got = self._instances()
        self.assertEqual(got["worker-p40"]["status"], "offline")
        self.assertIs(got["worker-p40"]["disabled"], True)

    def test_switching_on_removes_the_marker_and_is_idempotent_even_for_a_stale_or_unknown_id(self):
        self._set("worker-cloud", {"enabled": False})
        r = self._set("worker-cloud", {"enabled": True})
        self.assertEqual(r.get_json(), {"instanceId": "worker-cloud", "enabled": True, "disabled": False})
        self.assertFalse((self.switches / "worker-cloud").exists())
        self.assertEqual(self._set("worker-cloud", {"enabled": True}).status_code, 200)
        worker_switch.set_worker_enabled("worker-gone", False)
        self.assertEqual(self._set("worker-gone", {"enabled": True}).status_code, 200, "a stale marker for a lane that no longer exists can always be cleared")
        self.assertFalse((self.switches / "worker-gone").exists())

    def test_bad_bodies_are_400_and_write_nothing(self):
        for body in ({}, {"enabled": "false"}, {"enabled": 0}, {"enabled": None}, {"on": True}):
            self.assertEqual(self._set("worker-cloud", body).status_code, 400, body)
        self.assertEqual(self.client.post("/api/instances/worker-cloud/enabled", data="not json", content_type="text/plain").status_code, 400)
        self.assertFalse(self.switches.exists() and any(self.switches.iterdir()))

    def test_only_worker_lanes_can_be_switched_and_only_defined_lanes_can_be_switched_off(self):
        for iid in ("reviewer", "watchdog", "worker-3090.json", "WORKER-1"):
            self.assertEqual(self._set(iid, {"enabled": False}).status_code, 400, iid)
        self.assertEqual(self._set("worker-typo", {"enabled": False}).status_code, 404)
        self.assertFalse((self.switches / "worker-typo").exists())

    def test_when_the_lane_list_is_unknown_a_valid_worker_id_can_still_be_switched_off(self):
        with mock.patch.object(app, "worker_lane_ids", return_value=[]):
            self.assertEqual(self._set("worker-cloud", {"enabled": False}).status_code, 200)

    def test_a_broken_switch_never_hides_the_workers_tab(self):
        with mock.patch.object(worker_switch, "_run", side_effect=OSError("node missing")):
            got = self._instances()
        self.assertIs(got["worker-cloud"]["disabled"], False)
        self.assertEqual(got["worker-cloud"]["status"], "working")
        with mock.patch.object(worker_switch, "_run", side_effect=OSError("node missing")):
            self.assertEqual(self._set("worker-cloud", {"enabled": False}).status_code, 500)

    def test_the_switch_agrees_with_the_node_rule_the_worker_reads(self):
        import subprocess
        self._set("worker-cloud", {"enabled": False})
        node = lambda *a: subprocess.run(["node", str(worker_switch.SWITCH_JS), *a], capture_output=True, text=True, env=os.environ.copy())
        self.assertEqual(node("is-disabled", "worker-cloud").returncode, 0)
        self.assertEqual(json.loads(node("list").stdout), ["worker-cloud"])


if __name__ == "__main__":
    unittest.main()
