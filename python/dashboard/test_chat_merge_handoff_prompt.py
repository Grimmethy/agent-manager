"""Tests for the git-merge/push hand-off warning in chat_sessions.py's local system
prompt (2026-09-06). Closes Design option A from the "Chat-driven task completion
reliability" concept: confirmed live that Chat, asked to review unmerged branches,
correctly diagnosed which had real work but recommended merging one without ever
checking a known merge conflict the dashboard's own API already had. run_bash now
refuses git merge/push (see local-tool-client.js's RISKY_GIT_COMMAND_RE); this prompt
addition tells the model why.

REVISED 2026-09-19: the original version told Chat to hand merges/pushes to queue_reviewed_task. The
pipeline cannot perform git operations (a drafting sandbox mounts the shared git dir read-only), so
Chat queued a premium-priority "commit it and merge to master" task that held a GPU lane for an hour
and survived every restart. There is now NO git hand-off: Chat recommends, and the user merges from the
dashboard's Unmerged Branches tab (which checks for conflicts). queue_reviewed_task is for code CHANGES
only, and refuses git-operation requests (see local-tool-client.js).

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

    def test_points_merges_at_the_unmerged_branches_tab_not_at_a_task(self):
        self.assertIn("Unmerged Branches tab", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("The pipeline does not perform git operations either", chat_sessions._LOCAL_SYSTEM_PROMPT)

    def test_clarifies_read_only_git_commands_are_unaffected(self):
        self.assertIn("Read-only git commands", chat_sessions._LOCAL_SYSTEM_PROMPT)
        self.assertIn("completely unaffected", chat_sessions._LOCAL_SYSTEM_PROMPT)

    def test_forbids_queueing_a_git_operation_and_the_old_handoff_is_gone(self):
        prompt = chat_sessions._LOCAL_SYSTEM_PROMPT
        self.assertIn("NEVER queue a task whose deliverable is a git operation", prompt)
        self.assertIn("queue_reviewed_task is only for describing a code CHANGE", prompt)
        self.assertNotIn("YOU MUST ACTUALLY CALL THE", prompt)
        self.assertNotIn("A text description of the plan is not the hand-off", prompt)

    def test_present_in_every_real_local_system_prompt_built_for_a_session(self):
        with tempfile.TemporaryDirectory() as d:
            prompt = chat_sessions._local_system_prompt(_session(d))
            self.assertIn("NEVER queue a task whose deliverable is a git operation", prompt)
            self.assertIn("run_bash will refuse any `git merge` or `git push`", prompt)


if __name__ == "__main__":
    unittest.main()
