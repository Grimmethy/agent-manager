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
        (self.queue / "drafting" / "reviewer").mkdir(parents=True)
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

    # Worker draft lanes moved onto the GPU arbiter (2026-09-02): _preempt_pipeline_for_chat
    # cancels them via _arbiter_cancel_below (mocked here); only the reviewer stays on this
    # legacy heartbeat path. The arbiter cancel path is covered by test_gpu_arbiter_cli.py.

    def test_calls_the_arbiter_for_worker_lanes_and_folds_its_summary_in(self):
        with mock.patch.object(app, "_arbiter_cancel_below",
                               return_value=[{"lane": "draft", "action": "killed", "taskId": "t-w1", "ageSeconds": None}]) as m:
            self._hb("reviewer", status="idle", pass_="idle", pid=self._spawn().pid, task_id=None)
            summary = app._preempt_pipeline_for_chat()
            m.assert_called_once_with("interactive")
            self.assertIn({"lane": "draft", "action": "killed", "taskId": "t-w1", "ageSeconds": None}, summary)

    def test_reviewer_still_uses_the_legacy_age_gated_kill(self):
        with mock.patch.object(app, "_arbiter_cancel_below", return_value=[]):
            rv = self._spawn()
            self._hb("reviewer", status="working", pass_="vote", pid=rv.pid, task_id="t-rv")
            self._task("reviewer", "t-rv", claimed_epoch=time.time() - 5)  # young -> killed
            summary = app._preempt_pipeline_for_chat()
            self.assertTrue(self._was_killed(rv))
            self.assertEqual({s["lane"]: s["action"] for s in summary}.get("reviewer"), "killed")

    def test_reviewer_old_call_is_spared(self):
        with mock.patch.object(app, "_arbiter_cancel_below", return_value=[]):
            rv = self._spawn()
            self._hb("reviewer", status="working", pass_="vote", pid=rv.pid, task_id="t-rv")
            self._task("reviewer", "t-rv", claimed_epoch=time.time() - 600)  # >180s -> spared
            summary = app._preempt_pipeline_for_chat()
            self.assertIsNone(rv.poll())
            self.assertEqual({s["lane"]: s["action"] for s in summary}.get("reviewer"), "spare")


if __name__ == "__main__":
    unittest.main()
