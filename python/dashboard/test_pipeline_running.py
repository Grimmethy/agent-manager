"""Tests for app.py's pipeline liveness checks (_pipeline_running / _pipeline_stoppable /
_pid_alive), hardened 2026-08-30 after a live incident: worker-1 sat status:"queued"
blocked on the model lock for longer than OTHER_STALE_SECONDS behind a wedged
local-agentic pass. Its heartbeat legitimately stops updating while blocked, so the
fresh-heartbeat check alone reported the whole running pipeline as stopped -- and the
dashboard, which only renders its Stop button when running is true, was stuck showing
"Start Pipeline" with no way to stop the real pipeline.

Run: .venv/bin/python -m unittest python.dashboard.test_pipeline_running -v
"""
import json
import os
import sys
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


def _hb(inst_dir, name, *, status, age_seconds, pid):
    ts = (datetime.now(timezone.utc) - timedelta(seconds=age_seconds)).isoformat().replace("+00:00", "Z")
    (inst_dir / f"{name}.json").write_text(json.dumps({
        "instanceId": name, "pid": pid, "status": status,
        "lastHeartbeat": ts, "stateSince": ts,
    }), encoding="utf-8")


class PidAliveTest(unittest.TestCase):
    def test_live_pid_is_alive(self):
        self.assertTrue(app._pid_alive(os.getpid()))

    def test_missing_pid_is_not_alive(self):
        self.assertFalse(app._pid_alive(2_000_000_000))

    def test_garbage_pid_is_not_alive_rather_than_raising(self):
        self.assertFalse(app._pid_alive("not-a-pid"))
        self.assertFalse(app._pid_alive(None))


class PipelineRunningTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.inst = Path(self._tmp.name) / "instances"
        self.inst.mkdir()
        p = mock.patch.object(app, "instances_dir", return_value=self.inst)
        p.start()
        self.addCleanup(p.stop)
        # No real daemon process scan in these unit tests unless a case opts in.
        p2 = mock.patch.object(app, "_pipeline_daemon_pids", return_value=[])
        p2.start()
        self.addCleanup(p2.stop)
        self.addCleanup(self._tmp.cleanup)

    def test_fresh_worker_heartbeat_means_running(self):
        _hb(self.inst, "worker-1", status="working", age_seconds=5, pid=os.getpid())
        self.assertTrue(app._pipeline_running())

    def test_stale_queued_heartbeat_but_live_pid_still_counts_as_running(self):
        # The incident: queued > OTHER_STALE_SECONDS, but the worker process is alive.
        _hb(self.inst, "worker-1", status="queued",
            age_seconds=app.OTHER_STALE_SECONDS + 300, pid=os.getpid())
        self.assertTrue(app._pipeline_running(), "a blocked-but-alive worker is a running pipeline")
        self.assertTrue(app._pipeline_stoppable())

    def test_stale_heartbeat_with_dead_pid_and_no_daemons_is_not_running(self):
        _hb(self.inst, "worker-1", status="queued",
            age_seconds=app.OTHER_STALE_SECONDS + 300, pid=2_000_000_000)
        self.assertFalse(app._pipeline_running())
        self.assertFalse(app._pipeline_stoppable())

    def test_worker1_heartbeat_missing_but_a_sibling_pid_is_live(self):
        _hb(self.inst, "review-runner", status="idle", age_seconds=9999, pid=os.getpid())
        self.assertTrue(app._pipeline_running())

    def test_running_and_stoppable_fall_through_to_a_real_daemon_scan_with_no_heartbeats(self):
        # instances/ has no heartbeat files at all -- only the process scan can save this.
        with mock.patch.object(app, "_pipeline_daemon_pids", return_value=[os.getpid()]):
            self.assertTrue(app._pipeline_running())
            self.assertTrue(app._pipeline_stoppable())

    def test_status_endpoint_exposes_stoppable(self):
        _hb(self.inst, "worker-1", status="queued",
            age_seconds=app.OTHER_STALE_SECONDS + 300, pid=os.getpid())
        client = app.app.test_client()
        body = client.get("/api/pipeline/status").get_json()
        self.assertIn("stoppable", body)
        self.assertTrue(body["stoppable"])


if __name__ == "__main__":
    unittest.main()
