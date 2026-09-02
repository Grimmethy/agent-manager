"""Tests for app.py's Chat "make GPU space" preemption (brain dump #5): for a local-provider
chat turn BOTH worker lanes' in-flight draft are killed outright (chat precludes workers,
2026-09-02); only the reviewer is age-gated. AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING
opts worker-reasoning back into age-gating.

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

    def test_a_lane_marked_always_is_killed_regardless_of_age(self):
        for age in (None, self.NOW - 30, self.NOW - 9999):
            self.assertEqual(app._preempt_decision("worker-1", 4242, age, self.NOW, 180, always=True)[0], "kill")
            self.assertEqual(app._preempt_decision("worker-reasoning", 4242, age, self.NOW, 180, always=True)[0], "kill")

    def test_no_inflight_pid_is_skipped(self):
        self.assertEqual(app._preempt_decision("worker-1", None, None, self.NOW, 180, always=True)[0], "skip")
        self.assertEqual(app._preempt_decision("reviewer", 0, self.NOW, self.NOW, 180, always=False)[0], "skip")

    def test_age_gated_lane_young_call_is_killed(self):
        self.assertEqual(app._preempt_decision("reviewer", 99, self.NOW - 30, self.NOW, 180, always=False)[0], "kill")
        self.assertEqual(app._preempt_decision("reviewer", 99, self.NOW - 179, self.NOW, 180, always=False)[0], "kill")

    def test_age_gated_lane_old_call_is_spared(self):
        self.assertEqual(app._preempt_decision("reviewer", 99, self.NOW - 181, self.NOW, 180, always=False)[0], "spare")
        self.assertEqual(app._preempt_decision("reviewer", 99, self.NOW - 3600, self.NOW, 180, always=False)[0], "spare")

    def test_age_gated_lane_unknown_age_is_spared_not_killed(self):
        self.assertEqual(app._preempt_decision("reviewer", 99, None, self.NOW, 180, always=False)[0], "spare")

    def test_default_always_set_now_includes_worker_reasoning(self):
        # `always` not passed -> derived from the static _PREEMPT_LANES_ALWAYS.
        self.assertEqual(app._preempt_decision("worker-reasoning", 7, self.NOW - 9999, self.NOW, 180)[0], "kill")
        self.assertEqual(app._preempt_decision("worker-1", 7, self.NOW - 9999, self.NOW, 180)[0], "kill")
        self.assertEqual(app._preempt_decision("reviewer", 7, self.NOW - 9999, self.NOW, 180)[0], "spare")

    def test_is_preemptable_child_pass(self):
        for p in ("plan", "implement", "critique", "harness-search", "local-agentic",
                  "local-agentic-write", "local-agentic-test-repo-x", "vote", "review"):
            self.assertTrue(app._is_preemptable_child_pass(p), p)
        for p in (None, "", "idle", "claim", "starting"):
            self.assertFalse(app._is_preemptable_child_pass(p), repr(p))

    def test_lane_sets_flip_with_the_spare_long_reasoning_env(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING": ""}, clear=False):
            os.environ.pop("AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING", None)
            self.assertEqual(app._preempt_lane_sets(), (("worker-1", "worker-reasoning"), ("reviewer",)))
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING": "true"}):
            self.assertEqual(app._preempt_lane_sets(), (("worker-1",), ("worker-reasoning", "reviewer")))


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
        os.environ.pop("AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING", None)
        self._patches = [
            mock.patch.object(app, "instances_dir", return_value=self.inst),
            mock.patch.object(app, "queue_dir", return_value=self.queue),
            mock.patch.object(app, "read_env_file", return_value={}),
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
        summary = app._preempt_pipeline_for_chat()

        self.assertTrue(self._was_killed(w1), "worker-1 draft child was killed")
        self.assertIsNone(rv.poll(), "reviewer was spared (age unknown)")
        self.assertTrue((self.queue / "pending" / "t-w1.json").exists(), "worker-1 task requeued to pending/")
        actions = {s["lane"]: s["action"] for s in summary}
        self.assertEqual(actions.get("worker-1"), "killed")
        self.assertEqual(actions.get("reviewer"), "spare")

    def test_worker_reasoning_is_killed_regardless_of_age_and_agentic_tier(self):
        # local-agentic-write (tier 3) used to be MISSING from the child-pass set, so a
        # worker-reasoning draft in it was skipped entirely -- the live bug.
        for pass_name in ("local-agentic", "local-agentic-write"):
            for age_min in (0.3, 90):  # 18s and 90min -- both killed now
                with self.subTest(pass_name=pass_name, age_min=age_min):
                    wr = self._spawn()
                    tid = f"t-{pass_name}-{age_min}"
                    self._hb("worker-reasoning", status="working", pass_=pass_name, pid=wr.pid, task_id=tid)
                    self._task("worker-reasoning", tid, claimed_epoch=time.time() - age_min * 60)
                    summary = app._preempt_pipeline_for_chat()
                    self.assertTrue(self._was_killed(wr), f"{pass_name} {age_min}min draft must be killed")
                    self.assertTrue((self.queue / "pending" / f"{tid}.json").exists())
                    self.assertEqual({s["lane"]: s["action"] for s in summary}.get("worker-reasoning"), "killed")

    def test_spare_long_reasoning_env_restores_the_age_gate(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING": "true"}):
            wr = self._spawn()
            self._hb("worker-reasoning", status="working", pass_="local-agentic", pid=wr.pid, task_id="t-old")
            self._task("worker-reasoning", "t-old", claimed_epoch=time.time() - 600)
            app._preempt_pipeline_for_chat()
            self.assertIsNone(wr.poll(), "with the opt-in env, a 10-min-old reasoning draft is spared again")
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
