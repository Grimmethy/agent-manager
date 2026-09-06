"""Tests for the git-merge/push hand-off warning in chat_sessions.py's local system
prompt (2026-09-06). Closes Design option A from the "Chat-driven task completion
reliability" concept: confirmed live that Chat, asked to review unmerged branches,
correctly diagnosed which had real work but recommended merging one without ever
checking a known merge conflict the dashboard's own API already had. run_bash now
refuses git merge/push (see local-tool-client.js's RISKY_GIT_COMMAND_RE); this prompt
addition tells the model why, and what to do instead (queue_reviewed_task).

Run: .venv/bin/python -m unittest python.dashboard.test_chat_merge_handoff_prompt -v
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


class ChatMergeHandoffPromptTest(unittest.TestCase):
    def test_warns_that_run_bash_refuses_git_merge_and_push(self):
        self.assertIn("run_bash will refuse any `git merge` or `git push`", chat_sessions._LOCAL_SYSTEM_PROMPT)

    def test_names_the_real_incident_and_the_missed_conflict_check(self):
        self.assertIn("recommended merging one without ever checking", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("/api/git/unmerged-branches", chat_sessions._LOCAL_SYSTEM_PROMPT)

    def test_points_at_queue_reviewed_task_as_the_correct_next_step(self):
        self.assertIn("queue_reviewed_task", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("implement/critique/review/majority-vote", chat_sessions._LOCAL_SYSTEM_PROMPT)

    def test_clarifies_read_only_git_commands_are_unaffected(self):
        self.assertIn("Read-only git commands", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("completely unaffected", chat_sessions._LOCAL_SYSTEM_PROMPT)

    def test_is_imperative_about_actually_calling_the_tool_not_just_describing_it(self):
        # Strengthened 2026-09-06 after a real live test: asked to merge a branch, Chat
        # correctly explained that run_bash refuses git merge and that the action should
        # be queued -- then stopped there, never actually calling queue_reviewed_task, so
        # nothing landed in queue/adhoc/. The prompt must be unambiguous that narrating
        # the correct behavior is not the same as performing it.
        self.assertIn("YOU MUST ACTUALLY CALL THE", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("do not just describe, promise, or narrate", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("A text description of the plan is not the hand-off", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("queuedTaskId", chat_sessions._LOCAL_SYSTEM_PROMPT)

    def test_present_in_every_real_local_system_prompt_built_for_a_session(self):
        with tempfile.TemporaryDirectory() as d:
            prompt = chat_sessions._local_system_prompt(_session(d))
            self.assertIn("queue_reviewed_task", prompt)
            self.assertIn("run_bash will refuse any `git merge` or `git push`", prompt)


if __name__ == "__main__":
    unittest.main()
