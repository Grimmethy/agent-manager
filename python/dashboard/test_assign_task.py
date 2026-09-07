"""Tests for the Workers tab operator override: pin a specific pending task to a
specific worker lane, preempting whatever that lane is doing right now (2026-09-06,
Grimmethy: "I need to be able to select the task I want each worker to run... this
should override the automated system... whatever is being worked on should save its
current state to the task log and then cancel itself as soon as possible").

Covers `_kill_and_requeue_instance` (the generalized, unconditional version of
_preempt_pipeline_for_chat's reviewer-only legacy kill-and-requeue block) and the
POST /api/instances/<id>/assign-task route built on top of it.

Run: .venv/bin/python -m unittest python.dashboard.test_assign_task -v
"""
import json
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class AssignTaskTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.inst = root / "instances"
        self.queue = root / "queue"
        (self.inst / ".model-locks").mkdir(parents=True)
        (self.queue / "drafting" / "worker-1").mkdir(parents=True)
        (self.queue / "pending").mkdir(parents=True)
        self._patches = [
            mock.patch.object(app, "instances_dir", return_value=self.inst),
            mock.patch.object(app, "queue_dir", return_value=self.queue),
        ]
        for p in self._patches:
            p.start()
        self._procs = []
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        for pr in self._procs:
            try:
                pr.kill()
                pr.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                pass
        self._tmp.cleanup()

    def _spawn(self):
        pr = subprocess.Popen(["sleep", "120"])
        self._procs.append(pr)
        return pr

    @staticmethod
    def _was_killed(pr):
        try:
            return pr.wait(timeout=2) < 0
        except subprocess.TimeoutExpired:
            return False

    def _hb(self, lane, *, status, pass_, pid, task_id):
        (self.inst / f"{lane}.json").write_text(json.dumps({
            "instanceId": lane, "pid": pid, "status": status,
            "currentPass": pass_, "currentTaskId": task_id,
            "lastHeartbeat": "2026-01-01T00:00:00Z", "stateSince": "2026-01-01T00:00:00Z",
        }), encoding="utf-8")

    def _drafting_task(self, lane, task_id, extra=None):
        obj = {"id": task_id, "history": []}
        obj.update(extra or {})
        (self.queue / "drafting" / lane / f"{task_id}.json").write_text(
            json.dumps(obj), encoding="utf-8")

    def _pending_task(self, task_id, extra=None):
        obj = {"id": task_id, "title": f"Task {task_id}", "source": "adhoc", "history": []}
        obj.update(extra or {})
        (self.queue / "pending" / f"{task_id}.json").write_text(
            json.dumps(obj), encoding="utf-8")


class KillAndRequeueInstanceTest(AssignTaskTestBase):
    def test_kills_pid_and_requeues_the_task_with_a_history_note(self):
        pr = self._spawn()
        self._hb("worker-1", status="working", pass_="implement", pid=pr.pid, task_id="t-1")
        self._drafting_task("worker-1", "t-1")

        result = app._kill_and_requeue_instance("worker-1", "cancelled by operator -- worker reassigned to t-2")

        self.assertEqual(result, {"killed": True, "taskId": "t-1"})
        self.assertTrue(self._was_killed(pr))
        self.assertFalse((self.queue / "drafting" / "worker-1" / "t-1.json").exists())
        requeued = json.loads((self.queue / "pending" / "t-1.json").read_text())
        self.assertEqual(requeued["id"], "t-1")
        stages = [h["stage"] for h in requeued["history"]]
        self.assertIn("operator-preempted", stages)
        note = next(h["detail"] for h in requeued["history"] if h["stage"] == "operator-preempted")
        self.assertIn("t-2", note)

    def test_cleans_up_the_matching_model_lock_entry(self):
        pr = self._spawn()
        (self.inst / ".model-locks" / "worker-1.json").write_text(
            json.dumps({"instanceId": "worker-1", "pid": pr.pid, "startedAt": "2026-01-01T00:00:00Z"}),
            encoding="utf-8")
        self._hb("worker-1", status="working", pass_="implement", pid=pr.pid, task_id="t-1")
        self._drafting_task("worker-1", "t-1")

        app._kill_and_requeue_instance("worker-1", "cancelled by operator")

        self.assertFalse((self.inst / ".model-locks" / "worker-1.json").exists())

    def test_idle_lane_is_a_no_op(self):
        self._hb("worker-1", status="idle", pass_="idle", pid=None, task_id=None)

        result = app._kill_and_requeue_instance("worker-1", "cancelled by operator")

        self.assertEqual(result, {"killed": False, "taskId": None})

    def test_non_preemptable_pass_with_no_model_lock_is_a_no_op(self):
        # e.g. currentPass="claim" -- the bash daemon's own pid, not the node child;
        # _is_preemptable_child_pass() must reject it so a claim-in-progress can't kill
        # the daemon itself.
        self._hb("worker-1", status="working", pass_="claim", pid=99999, task_id="t-1")
        self._drafting_task("worker-1", "t-1")

        result = app._kill_and_requeue_instance("worker-1", "cancelled by operator")

        self.assertEqual(result, {"killed": False, "taskId": "t-1"})
        self.assertTrue((self.queue / "drafting" / "worker-1" / "t-1.json").exists())


class ApiAssignTaskRouteTest(AssignTaskTestBase):
    def _post(self, instance_id, task_id):
        return self.client.post(
            f"/api/instances/{instance_id}/assign-task",
            data=json.dumps({"taskId": task_id}),
            content_type="application/json",
        )

    def test_pins_the_task_and_stamps_history_when_the_lane_is_idle(self):
        self._hb("worker-1", status="idle", pass_="idle", pid=None, task_id=None)
        self._pending_task("t-new")

        resp = self._post("worker-1", "t-new")

        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(body, {"id": "t-new", "pinnedTo": "worker-1", "preempted": False})
        pinned = json.loads((self.queue / "pending" / "t-new.json").read_text())
        self.assertEqual(pinned["pinnedWorker"], "worker-1")
        self.assertTrue(any(h["stage"] == "operator-assigned" for h in pinned["history"]))

    def test_preempts_a_real_in_flight_task_on_that_lane(self):
        pr = self._spawn()
        self._hb("worker-1", status="working", pass_="implement", pid=pr.pid, task_id="t-old")
        self._drafting_task("worker-1", "t-old")
        self._pending_task("t-new")

        resp = self._post("worker-1", "t-new")

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["preempted"], True)
        self.assertTrue(self._was_killed(pr))
        self.assertFalse((self.queue / "drafting" / "worker-1" / "t-old.json").exists())
        requeued = json.loads((self.queue / "pending" / "t-old.json").read_text())
        self.assertTrue(any(h["stage"] == "operator-preempted" for h in requeued["history"]))
        pinned = json.loads((self.queue / "pending" / "t-new.json").read_text())
        self.assertEqual(pinned["pinnedWorker"], "worker-1")

    def test_no_op_when_the_lane_is_already_running_the_assigned_task(self):
        pr = self._spawn()
        self._hb("worker-1", status="working", pass_="implement", pid=pr.pid, task_id="t-same")
        self._drafting_task("worker-1", "t-same")
        self._pending_task("t-same")  # unusual (normally claimed tasks leave pending/), but the
        # route only reads pending/<taskId>.json to validate + pin -- exercise the
        # already-running guard specifically, independent of that.

        resp = self._post("worker-1", "t-same")

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["preempted"], False)
        self.assertIsNone(pr.poll(), "must not have been killed -- it's already running the assigned task")

    def test_404_for_an_unknown_instance(self):
        self._pending_task("t-new")
        resp = self._post("reviewer", "t-new")
        self.assertEqual(resp.status_code, 404)

        resp2 = self._post("worker-does-not-exist", "t-new")
        self.assertEqual(resp2.status_code, 404)

    def test_404_for_a_task_no_longer_in_pending(self):
        self._hb("worker-1", status="idle", pass_="idle", pid=None, task_id=None)
        resp = self._post("worker-1", "t-does-not-exist")
        self.assertEqual(resp.status_code, 404)

    def test_400_when_taskid_is_missing(self):
        resp = self.client.post(
            "/api/instances/worker-1/assign-task",
            data=json.dumps({}), content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
