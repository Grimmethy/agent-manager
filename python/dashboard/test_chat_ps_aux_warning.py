"""Tests for the run_bash/ps-aux sandbox-blindness warning in chat_sessions.py's local
system prompt (2026-09-06). Confirmed live: a real Chat investigation ran `ps aux` via
run_bash, found nothing (bwrap's --unshare-pid gives the sandboxed process its own,
otherwise-empty PID namespace -- see src/sandbox.js's buildBwrapArgs), and concluded with
full confidence "the pipeline itself is down, no live processes" while 5 real worker/
reviewer processes were genuinely running on the host the whole time. The model built its
final RESOLUTION recommendation on that false premise. Fixed by telling the model directly
what run_bash can and cannot see, and pointing it at the real liveness signal (instance
heartbeat files) this codebase already treats as its sole source of truth everywhere else.

Run: .venv/bin/python -m unittest python.dashboard.test_chat_ps_aux_warning -v
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import chat_sessions  # noqa: E402


def _session(root, roots=None):
    return {
        "id": "chat-test", "provider": "local", "model": None, "effort": None,
        "roots": roots or [root], "repoRoot": root, "claudeSessionId": None,
        "transcript": [],
    }


class RunBashPsAuxWarningTest(unittest.TestCase):
    def test_warns_that_run_bash_cannot_see_real_host_processes(self):
        self.assertIn("cannot see real host processes", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("--unshare-pid", chat_sessions._LOCAL_SYSTEM_PROMPT)

    def test_explicitly_forbids_using_ps_output_as_liveness_evidence(self):
        self.assertIn("NEVER use run_bash's", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("ps", chat_sessions._LOCAL_SYSTEM_PROMPT.lower())

    def test_points_at_the_real_liveness_signal_instance_heartbeat_files(self):
        self.assertIn("instances/<instanceId>.json", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("lastHeartbeat", chat_sessions._LOCAL_SYSTEM_PROMPT)

    def test_present_in_every_real_local_system_prompt_built_for_a_session(self):
        with tempfile.TemporaryDirectory() as d:
            prompt = chat_sessions._local_system_prompt(_session(d))
            self.assertIn("cannot see real host processes", prompt)
            self.assertIn("lastHeartbeat", prompt)

    def test_clarifies_watchdog_sweeps_are_one_shot_subprocesses_not_daemons(self):
        # 2026-09-06 follow-up: the real incident was narrower than "the whole pipeline is
        # down" -- watchdog itself (and every OTHER worker/reviewer) was genuinely alive;
        # the model was specifically confused about decompose-loop-autoroute/coordinator-
        # sweep, which never appear in `ps aux` between ticks even when working correctly.
        self.assertIn("decompose-loop-autoroute.js", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("one-shot", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("coordinator-sweep.log", chat_sessions._LOCAL_SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
