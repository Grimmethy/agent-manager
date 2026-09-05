"""Tests for chat_sessions.py reading AGENTS.md as the Chat panel's de facto starting
point (2026-09-05, Grimmethy: "Have it read agents.md for sure... set that up as the de
facto starting point"). Confirmed live beforehand: neither provider ever read it -- the
local system prompt only announced accessible repos, and the Claude CLI's own auto-read
only covers CLAUDE.md, a different file.

Run: .venv/bin/python -m unittest python.dashboard.test_agents_md_in_chat -v
"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import chat_sessions  # noqa: E402


def _session(root, roots=None):
    return {
        "id": "chat-test", "provider": "local", "model": None, "effort": None,
        "roots": roots or [root], "repoRoot": root, "claudeSessionId": None,
        "transcript": [],
    }


class TestReadAgentsMd(unittest.TestCase):
    def test_reads_real_content_from_primary_root(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "AGENTS.md").write_text("# AGENTS\n\nDo the mechanism thing.", encoding="utf-8")
            self.assertIn("mechanism thing", chat_sessions._read_agents_md(_session(d)))

    def test_missing_file_returns_empty_string_not_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(chat_sessions._read_agents_md(_session(d)), "")

    def test_empty_file_returns_empty_string(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "AGENTS.md").write_text("   \n\n  ", encoding="utf-8")
            self.assertEqual(chat_sessions._read_agents_md(_session(d)), "")

    def test_reads_from_the_primary_root_only_not_a_secondary_one(self):
        with tempfile.TemporaryDirectory() as primary, tempfile.TemporaryDirectory() as secondary:
            (Path(secondary) / "AGENTS.md").write_text("secondary content", encoding="utf-8")
            self.assertEqual(chat_sessions._read_agents_md(_session(primary, roots=[primary, secondary])), "")

    def test_oversized_file_is_truncated(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "AGENTS.md").write_text("x" * (chat_sessions.AGENTS_MD_MAX_CHARS + 500), encoding="utf-8")
            result = chat_sessions._read_agents_md(_session(d))
            self.assertLessEqual(len(result), chat_sessions.AGENTS_MD_MAX_CHARS + len("\n...[truncated]"))
            self.assertTrue(result.endswith("...[truncated]"))


class TestLocalSystemPromptIncludesAgentsMd(unittest.TestCase):
    def test_present_file_is_folded_into_every_system_prompt(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "AGENTS.md").write_text("build the mechanism, not the instance", encoding="utf-8")
            prompt = chat_sessions._local_system_prompt(_session(d))
            self.assertIn("build the mechanism, not the instance", prompt)
            self.assertIn("de facto starting point", prompt)

    def test_missing_file_leaves_the_prompt_unchanged_no_error(self):
        with tempfile.TemporaryDirectory() as d:
            prompt = chat_sessions._local_system_prompt(_session(d))
            self.assertNotIn("AGENTS.md", prompt)


class TestClaudePreambleIncludesAgentsMd(unittest.TestCase):
    def test_first_turn_preamble_carries_agents_md(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "AGENTS.md").write_text("never hand-edit queue/", encoding="utf-8")
            session = _session(d)
            session["provider"] = "claude"
            captured = {}

            def fake_generate(message, **kwargs):
                captured["message"] = message
                return {"response": "ok", "model": "claude:sonnet", "sessionId": "sess-1"}

            with patch.object(chat_sessions.claude_client, "generate", side_effect=fake_generate), \
                 patch.object(chat_sessions.model_stats_client, "record_call"):
                chat_sessions._send_claude(session, "hello")

            self.assertIn("never hand-edit queue/", captured["message"])
            self.assertIn("de facto starting point", captured["message"])
            self.assertTrue(captured["message"].endswith("hello"))

    def test_second_turn_does_not_repeat_the_preamble(self):
        # --resume carries the CLI's own session state forward -- re-sending AGENTS.md
        # every turn would be pure waste once a real claudeSessionId exists.
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "AGENTS.md").write_text("never hand-edit queue/", encoding="utf-8")
            session = _session(d)
            session["provider"] = "claude"
            session["claudeSessionId"] = "sess-1"
            captured = {}

            def fake_generate(message, **kwargs):
                captured["message"] = message
                return {"response": "ok", "model": "claude:sonnet", "sessionId": "sess-1"}

            with patch.object(chat_sessions.claude_client, "generate", side_effect=fake_generate), \
                 patch.object(chat_sessions.model_stats_client, "record_call"):
                chat_sessions._send_claude(session, "hello again")

            self.assertEqual(captured["message"], "hello again")


if __name__ == "__main__":
    unittest.main()
