"""Tests for app.py's Chat "make GPU space" preemption (brain dump #5): worker-1's
in-flight draft is always killed for a local-provider chat turn; worker-reasoning's /
the reviewer's only if it started < AGENT_MANAGER_CHAT_PREEMPT_REASONING_MAX_AGE_S ago.

Run: .venv/bin/python -m unittest python.dashboard.test_chat_preempt -v
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


class PreemptDecisionTest(unittest.TestCase):
    NOW = 1_000_000.0

    def test_worker1_with_an_inflight_call_is_always_killed(self):
        self.assertEqual(app._preempt_decision("worker-1", 4242, None, self.NOW, 180)[0], "kill")
        self.assertEqual(app._preempt_decision("worker-1", 4242, self.NOW - 9999, self.NOW, 180)[0], "kill")

    def test_no_inflight_pid_is_skipped(self):
        self.assertEqual(app._preempt_decision("worker-1", None, None, self.NOW, 180)[0], "skip")
        self.assertEqual(app._preempt_decision("reviewer", 0, self.NOW, self.NOW, 180)[0], "skip")

    def test_age_gated_lane_young_task_is_killed(self):
        self.assertEqual(app._preempt_decision("worker-reasoning", 99, self.NOW - 30, self.NOW, 180)[0], "kill")
        self.assertEqual(app._preempt_decision("reviewer", 99, self.NOW - 179, self.NOW, 180)[0], "kill")

    def test_age_gated_lane_old_task_is_spared(self):
        self.assertEqual(app._preempt_decision("worker-reasoning", 99, self.NOW - 181, self.NOW, 180)[0], "spare")
        self.assertEqual(app._preempt_decision("worker-reasoning", 99, self.NOW - 3600, self.NOW, 180)[0], "spare")

    def test_age_gated_lane_unknown_age_is_spared_not_killed(self):
        # Conservative: never kill work we can't date.
        self.assertEqual(app._preempt_decision("worker-reasoning", 99, None, self.NOW, 180)[0], "spare")


class PreemptPipelineTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.inst = root / "instances"
        self.queue = root / "queue"
        (self.inst / ".model-locks").mkdir(parents=True)
        (self.queue / "drafting" / "worker-1").mkdir(parents=True)
        (self.queue / "drafting" / "worker-reasoning").mkdir(parents=True)
        (self.queue / "pending").mkdir(parents=True)
        self._patches = [
            mock.patch.object(app, "instances_dir", return_value=self.inst),
            mock.patch.object(app, "queue_dir", return_value=self.queue),
        ]
        for p in self._patches:
            p.start()
        self._procs = []

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
        # A SIGKILLed Popen child is a zombie (os.kill(pid,0) still succeeds) until the
        # parent reaps it -- reap here, then check the signal-terminated return code.
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

    def _task(self, lane, task_id, *, claimed_epoch=None):
        obj = {"id": task_id}
        if claimed_epoch is not None:
            obj["claimedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(claimed_epoch))
        (self.queue / "drafting" / lane / f"{task_id}.json").write_text(json.dumps(obj), encoding="utf-8")

    def test_worker1_draft_is_killed_and_requeued_reviewer_spared_when_old(self):
        w1 = self._spawn()
        rv = self._spawn()
        self._hb("worker-1", status="working", pass_="implement", pid=w1.pid, task_id="t-w1")
        self._task("worker-1", "t-w1")
        self._hb("reviewer", status="working", pass_="vote", pid=rv.pid, task_id="t-rv")
        # reviewer's call has no .model-locks entry and no claimedAt -> falls back to the
        # (nonexistent) drafting file mtime -> age unknown -> spared.
        summary = app._preempt_pipeline_for_chat()

        self.assertTrue(self._was_killed(w1), "worker-1 draft child was killed")
        self.assertIsNone(rv.poll(), "reviewer was spared")
        self.assertFalse((self.queue / "drafting" / "worker-1" / "t-w1.json").exists())
        self.assertTrue((self.queue / "pending" / "t-w1.json").exists(), "worker-1 task requeued to pending/")
        actions = {s["lane"]: s["action"] for s in summary}
        self.assertEqual(actions.get("worker-1"), "killed")
        self.assertEqual(actions.get("reviewer"), "spare")

    def test_worker_reasoning_young_task_killed_via_claimedAt(self):
        wr = self._spawn()
        self._hb("worker-reasoning", status="working", pass_="local-agentic", pid=wr.pid, task_id="t-wr")
        self._task("worker-reasoning", "t-wr", claimed_epoch=time.time() - 20)
        summary = app._preempt_pipeline_for_chat()
        self.assertTrue(self._was_killed(wr))
        self.assertTrue((self.queue / "pending" / "t-wr.json").exists())
        self.assertEqual({s["lane"]: s["action"] for s in summary}.get("worker-reasoning"), "killed")

    def test_worker_reasoning_old_task_spared_via_claimedAt(self):
        wr = self._spawn()
        self._hb("worker-reasoning", status="working", pass_="local-agentic", pid=wr.pid, task_id="t-old")
        self._task("worker-reasoning", "t-old", claimed_epoch=time.time() - 600)
        app._preempt_pipeline_for_chat()
        self.assertIsNone(wr.poll(), "a 10-min-old reasoning task is spared")
        self.assertTrue((self.queue / "drafting" / "worker-reasoning" / "t-old.json").exists())

    def test_idle_lane_and_claim_pass_are_left_alone(self):
        idle = self._spawn()
        claiming = self._spawn()
        self._hb("worker-1", status="idle", pass_="idle", pid=idle.pid, task_id=None)
        self._hb("worker-reasoning", status="working", pass_="claim", pid=claiming.pid, task_id="t-c")
        summary = app._preempt_pipeline_for_chat()
        self.assertEqual(summary, [])
        self.assertIsNone(idle.poll())
        self.assertIsNone(claiming.poll())


if __name__ == "__main__":
    unittest.main()
