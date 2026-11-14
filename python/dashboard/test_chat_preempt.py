"""Tests for app.py's Chat "make GPU space" preemption (brain dump #5): for a local-provider
chat turn the LOCAL-GPU worker lane's in-flight draft is killed outright (chat precludes workers,
2026-09-02) but the P40 lane is never touched (2026-09-21: "only take over the 3090"); only the reviewer is age-gated. AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING
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
import chat_preempt  # noqa: E402


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
        self.assertEqual(app._preempt_decision("reviewer", 99, self.NOW - 181, self.NOW, 180, always=False)[0], "spared")
        self.assertEqual(app._preempt_decision("reviewer", 99, self.NOW - 3600, self.NOW, 180, always=False)[0], "spared")

    def test_age_gated_lane_unknown_age_is_spared_not_killed(self):
        self.assertEqual(app._preempt_decision("reviewer", 99, None, self.NOW, 180, always=False)[0], "spared")

    def test_default_always_kills_any_gpu_lane_and_spares_the_reviewer(self):
        # `always` not passed -> every lane except the age-gated reviewer is always-kill.
        self.assertEqual(app._preempt_decision("worker-3090", 7, self.NOW - 9999, self.NOW, 180)[0], "kill")
        self.assertEqual(app._preempt_decision("worker-p40", 7, self.NOW - 9999, self.NOW, 180)[0], "kill")
        self.assertEqual(app._preempt_decision("reviewer", 7, self.NOW - 9999, self.NOW, 180)[0], "spared")

    def test_is_preemptable_child_pass(self):
        for p in ("plan", "implement", "critique", "harness-search", "local-agentic",
                  "local-agentic-write", "local-agentic-test-repo-x", "vote", "review",
                  # 2026-09-07: 'orient' (src/orient-pass.js's maybeLocked label) and
                  # 'decompose-check' (local-draft.js's preliminary decompose check)
                  # were both missing -- a task caught mid-pass in either could never
                  # actually be preempted by assign-task/chat-preempt (silently
                  # returned killed:false with no error, "I was able to select the
                  # decompose task but it still doesn't seem to set it as the queued
                  # task").
                  "orient", "decompose-check"):
            self.assertTrue(app._is_preemptable_child_pass(p), p)
        for p in (None, "", "idle", "claim", "starting"):
            self.assertFalse(app._is_preemptable_child_pass(p), repr(p))

    def test_lane_sets_are_the_local_gpu_lane_plus_age_gated_reviewer_never_the_p40(self):
        defs = [{"id": "worker-3090", "preempt": "always"}, {"id": "worker-p40", "preempt": "never"}]
        with mock.patch.object(app, "worker_lane_defs", return_value=defs):
            self.assertEqual(app._preempt_lane_sets(), (("worker-3090",), ("reviewer",)))

    def test_a_p40_only_layout_preempts_no_worker_lane(self):
        with mock.patch.object(app, "worker_lane_defs", return_value=[{"id": "worker-p40", "preempt": "never"}]):
            self.assertEqual(app._preempt_lane_sets(), ((), ("reviewer",)))

    def test_a_registry_lane_is_never_preempted_unless_it_opts_in_to_age_gating(self):
        defs = [{"id": "worker-3090", "preempt": "always"}, {"id": "worker-rx580", "preempt": "never"},
                {"id": "worker-a770", "preempt": "age-gated"}]
        with mock.patch.object(app, "worker_lane_defs", return_value=defs):
            self.assertEqual(app._preempt_lane_sets(), (("worker-3090",), ("reviewer", "worker-a770")))

    def test_unreadable_lane_definitions_fall_back_to_the_old_everything_but_the_p40_rule(self):
        with mock.patch.object(app, "worker_lane_defs", return_value=[]), \
                mock.patch.object(app, "worker_lane_ids", return_value=["worker-3090", "worker-p40", "worker-rx580"]):
            self.assertEqual(app._preempt_lane_sets(), (("worker-3090", "worker-rx580"), ("reviewer",)))


class ArbiterCancelBelowArgsTest(unittest.TestCase):
    """The dashboard must ask the arbiter for the chat's OWN endpoint (--local). A per-model key finds none of the worker tickets (they are keyed by endpoint), which
    is why the takeover silently did nothing before 2026-09-21; and it must never name the P40 endpoint."""

    def test_cancel_below_asks_the_arbiter_for_the_local_endpoint_only(self):
        seen = {}

        def fake_run(cmd, **kw):
            seen["cmd"] = cmd
            return subprocess.CompletedProcess(cmd, 0, stdout="[]", stderr="")

        with mock.patch.object(app, "read_env_file", return_value={}), mock.patch.object(chat_preempt.subprocess, "run", side_effect=fake_run):
            chat_preempt._arbiter_cancel_below("interactive")
        self.assertIn("cancel-below", seen["cmd"])
        self.assertIn("--local", seen["cmd"])
        self.assertNotIn("--model", seen["cmd"])
        self.assertFalse(any("192.168" in str(a) or "p40" in str(a).lower() for a in seen["cmd"]), "never names the P40 endpoint")


class ArbiterCancelBelowKeyTest(unittest.TestCase):
    def test_a_key_replaces_local_on_the_arbiter_command_line(self):
        seen = {}

        def fake_run(cmd, **kw):
            seen["cmd"] = cmd
            return subprocess.CompletedProcess(cmd, 0, stdout="[]", stderr="")

        with mock.patch.object(app, "read_env_file", return_value={}), mock.patch.object(chat_preempt.subprocess, "run", side_effect=fake_run):
            chat_preempt._arbiter_cancel_below("interactive", key="ollama-100.96.112.78-11434")
        cmd = seen["cmd"]
        self.assertEqual(cmd[cmd.index("--key") + 1], "ollama-100.96.112.78-11434")
        self.assertNotIn("--local", cmd)


class ArbiterBusyRowsTest(unittest.TestCase):
    """A holder that survives the preempt is reported as a 'busy' row, so the chat can say the GPU was not freed."""

    def _status(self, payload, returncode=0):
        def fake_run(cmd, **kw):
            self.cmd = cmd
            return subprocess.CompletedProcess(cmd, returncode, stdout=json.dumps(payload), stderr="")
        return mock.patch.object(chat_preempt.subprocess, "run", side_effect=fake_run)

    def _rows(self, payload, summary=()):
        with mock.patch.object(app, "read_env_file", return_value={}), self._status(payload):
            return chat_preempt._arbiter_busy_rows(list(summary))

    HOLDER = {"cls": "draft", "pid": 4242, "taskId": "t-w1", "phase": "orient", "model": "m", "startedAt": "x"}

    def test_a_surviving_holder_becomes_a_busy_row(self):
        rows = self._rows({"holder": self.HOLDER, "waiting": [], "reserved": []})
        self.assertEqual(rows, [{"lane": "draft", "action": "busy", "taskId": "t-w1", "phase": "orient", "ageSeconds": None}])
        self.assertIn("status", self.cmd)
        self.assertIn("--local", self.cmd)

    def test_a_holder_the_cancel_killed_is_not_reported(self):
        rows = self._rows({"holder": self.HOLDER}, summary=[{"lane": "draft", "action": "killed", "taskId": "t-w1"}])
        self.assertEqual(rows, [])

    def test_no_holder_or_a_failing_status_call_adds_nothing(self):
        self.assertEqual(self._rows({"holder": None, "waiting": [], "reserved": []}), [])
        with mock.patch.object(app, "read_env_file", return_value={}), \
                mock.patch.object(chat_preempt.subprocess, "run", side_effect=OSError("no node")):
            self.assertEqual(chat_preempt._arbiter_busy_rows([]), [])
        with mock.patch.object(app, "read_env_file", return_value={}), \
                mock.patch.object(chat_preempt.subprocess, "run",
                                  return_value=subprocess.CompletedProcess([], 1, stdout="not json", stderr="")):
            self.assertEqual(chat_preempt._arbiter_busy_rows([]), [])


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
            # Keep every case off the real arbiter status call; ArbiterBusyRowsTest and the busy-row cases below re-patch it.
            mock.patch.object(chat_preempt, "_arbiter_busy_rows", return_value=[]),
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
    #
    # 2026-09-15: patched on the chat_preempt module, not app -- _preempt_pipeline_for_chat
    # now lives in chat_preempt.py (extracted so it can be vendored into a standalone Chat
    # plugin repo) and its bare `_arbiter_cancel_below(...)` call resolves in that module's
    # own namespace; app.py's `from chat_preempt import _arbiter_cancel_below` is a separate
    # binding in app's namespace that patching there would not affect.

    def test_calls_the_arbiter_for_worker_lanes_and_folds_its_summary_in(self):
        with mock.patch.object(chat_preempt, "_arbiter_cancel_below",
                               return_value=[{"lane": "draft", "action": "killed", "taskId": "t-w1", "ageSeconds": None}]) as m:
            self._hb("reviewer", status="idle", pass_="idle", pid=self._spawn().pid, task_id=None)
            summary = app._preempt_pipeline_for_chat()
            m.assert_called_once_with("interactive")
            self.assertIn({"lane": "draft", "action": "killed", "taskId": "t-w1", "ageSeconds": None}, summary)

    def test_a_surviving_holder_is_appended_after_the_arbiter_and_reviewer_rows(self):
        busy = [{"lane": "draft", "action": "busy", "taskId": "t-w1", "phase": "orient", "ageSeconds": None}]
        with mock.patch.object(chat_preempt, "_arbiter_cancel_below", return_value=[]), \
                mock.patch.object(chat_preempt, "_arbiter_busy_rows", return_value=busy) as m:
            summary = app._preempt_pipeline_for_chat()
            m.assert_called_once()
            self.assertEqual(summary[-1], busy[0])

    # Chat on a chosen card (chat_card.py): the preempt follows the card the reply runs on.
    HOST_CARD = {"lane": "worker-3090", "local": True, "lockKey": "ollama-localhost-11434", "blocked": False}
    RX_CARD = {"lane": "worker-rx580", "local": False, "lockKey": "ollama-100.96.112.78-11434", "blocked": False}

    def test_a_remote_card_cancels_only_that_cards_lane_by_its_key_and_spares_the_reviewer(self):
        with mock.patch.object(chat_preempt, "_arbiter_cancel_below", return_value=[{"lane": "draft", "action": "killed"}]) as m:
            rv = self._spawn()
            self._hb("reviewer", status="working", pass_="vote", pid=rv.pid, task_id="t-rv")
            self._task("reviewer", "t-rv", claimed_epoch=time.time() - 5)
            summary = app._preempt_pipeline_for_chat(self.RX_CARD)
            m.assert_called_once_with("interactive", key="ollama-100.96.112.78-11434")
            self.assertEqual(summary, [{"lane": "draft", "action": "killed"}])
            self.assertIsNone(rv.poll())

    def test_the_host_card_takes_the_unchanged_host_path(self):
        with mock.patch.object(chat_preempt, "_arbiter_cancel_below", return_value=[]) as m:
            app._preempt_pipeline_for_chat(self.HOST_CARD)
            m.assert_called_once_with("interactive")

    def test_a_blocked_choice_or_a_remote_card_without_a_key_preempts_nothing(self):
        with mock.patch.object(chat_preempt, "_arbiter_cancel_below", return_value=[{"x": 1}]) as m:
            self.assertEqual(app._preempt_pipeline_for_chat({"lane": None, "blocked": True, "local": True}), [])
            self.assertEqual(app._preempt_pipeline_for_chat({**self.RX_CARD, "blocked": True}), [])
            self.assertEqual(app._preempt_pipeline_for_chat({"lane": "worker-rx580", "local": False, "blocked": False}), [])
            m.assert_not_called()

    def test_reviewer_still_uses_the_legacy_age_gated_kill(self):
        with mock.patch.object(chat_preempt, "_arbiter_cancel_below", return_value=[]):
            rv = self._spawn()
            self._hb("reviewer", status="working", pass_="vote", pid=rv.pid, task_id="t-rv")
            self._task("reviewer", "t-rv", claimed_epoch=time.time() - 5)  # young -> killed
            summary = app._preempt_pipeline_for_chat()
            self.assertTrue(self._was_killed(rv))
            self.assertEqual({s["lane"]: s["action"] for s in summary}.get("reviewer"), "killed")

    def test_reviewer_old_call_is_spared(self):
        with mock.patch.object(chat_preempt, "_arbiter_cancel_below", return_value=[]):
            rv = self._spawn()
            self._hb("reviewer", status="working", pass_="vote", pid=rv.pid, task_id="t-rv")
            self._task("reviewer", "t-rv", claimed_epoch=time.time() - 600)  # >180s -> spared
            summary = app._preempt_pipeline_for_chat()
            self.assertIsNone(rv.poll())
            self.assertEqual({s["lane"]: s["action"] for s in summary}.get("reviewer"), "spared")


if __name__ == "__main__":
    unittest.main()
