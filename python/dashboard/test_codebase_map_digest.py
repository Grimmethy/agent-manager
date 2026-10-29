"""Tests for codebase_map_digest.py and its injection into the Chat panel + the Claude Code
SessionStart hook (2026-10-02: CLAUDE.md's "check codebase-map.md first" was advisory only).

Run: .venv/bin/python -m unittest python.dashboard.test_codebase_map_digest -v
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import chat_sessions  # noqa: E402
import codebase_map_digest  # noqa: E402

MAP = """# Codebase Map

intro prose that must not leak into the digest.

## Section 1 — Dashboard tabs

| Tab | Frontend | Backend |
|---|---|---|
| Workers | `core-ui.js` | `/api/instances` |
| Job List | `joblist.js` | `/api/queue` |

## Section 3 — Core pipeline mechanisms

**Task sources & plugin boundary**
- `src/task-sources.js` — registry

## Recurring work processes

| Process | Doc |
|---|---|
| Reviewing an unmerged branch | `docs/agents/unmerged-branch-review.md` |

## Known gaps

nothing to label here
"""


def _repo(map_text=MAP):
    d = tempfile.TemporaryDirectory()
    p = Path(d.name) / codebase_map_digest.MAP_RELPATH
    p.parent.mkdir(parents=True)
    if map_text is not None:
        p.write_text(map_text, encoding="utf-8")
    return d


def _session(root, provider="local"):
    return {"id": "t", "provider": provider, "model": None, "effort": None, "roots": [root],
            "repoRoot": root, "claudeSessionId": None, "transcript": []}


class TestBuildDigest(unittest.TestCase):
    def test_has_rule_row_labels_and_recurring_table_but_not_prose(self):
        with _repo() as d:
            out = codebase_map_digest.build_digest(d)
        self.assertIn("docs/agents/codebase-map.md", out)
        self.assertIn("Workers; Job List", out)
        self.assertIn("Task sources & plugin boundary", out)
        self.assertIn("unmerged-branch-review.md", out)  # recurring table kept in full
        self.assertNotIn("intro prose", out)
        self.assertNotIn("/api/instances", out)  # details stay in the file

    def test_missing_or_empty_map_is_empty_string_not_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(codebase_map_digest.build_digest(d), "")
        with _repo("  \n") as d:
            self.assertEqual(codebase_map_digest.build_digest(d), "")

    def test_oversized_digest_is_truncated(self):
        big = "## Section 1\n\n" + "".join(f"| row{i} | x |\n" for i in range(2000))
        with _repo(big) as d:
            out = codebase_map_digest.build_digest(d)
        self.assertTrue(out.endswith("...[truncated]"))

    def test_real_repo_map_yields_a_digest(self):
        root = Path(__file__).resolve().parents[2]
        out = codebase_map_digest.build_digest(root)
        self.assertIn("Workers", out)
        self.assertIn("Recurring work processes", out)
        self.assertLess(len(out), 6100)


class TestHook(unittest.TestCase):
    def _run(self, cwd):
        buf = io.StringIO()
        old = os.getcwd()
        os.chdir(cwd)
        try:
            with redirect_stdout(buf):
                rc = codebase_map_digest.main()
        finally:
            os.chdir(old)
        return rc, buf.getvalue()

    def test_emits_session_start_json_from_a_subdirectory(self):
        with _repo() as d:
            sub = Path(d) / "src" / "deep"
            sub.mkdir(parents=True)
            rc, out = self._run(sub)
        self.assertEqual(rc, 0)
        payload = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(payload["hookEventName"], "SessionStart")
        self.assertIn("CODEBASE MAP", payload["additionalContext"])

    def test_silent_noop_outside_a_repo_with_a_map(self):
        with tempfile.TemporaryDirectory() as d:
            rc, out = self._run(d)
        self.assertEqual((rc, out), (0, ""))


class TestChatInjection(unittest.TestCase):
    def test_local_system_prompt_includes_digest(self):
        with _repo() as d:
            self.assertIn("CODEBASE MAP", chat_sessions._local_system_prompt(_session(d)))

    def test_local_system_prompt_unchanged_without_a_map(self):
        with _repo(None) as d:
            self.assertNotIn("CODEBASE MAP", chat_sessions._local_system_prompt(_session(d)))

    def test_claude_first_turn_preamble_includes_digest_and_resume_does_not_repeat_it(self):
        sent = []

        def fake_generate(message, **kw):
            sent.append(message)
            return {"response": "ok", "model": "m", "sessionId": "sid"}

        with _repo() as d, patch.object(chat_sessions.claude_client, "generate", fake_generate), \
                patch.object(chat_sessions.model_stats_client, "record_call"):
            s = _session(d, "claude")
            chat_sessions._send_claude(s, "hello")
            chat_sessions._send_claude(s, "again")
        self.assertIn("CODEBASE MAP", sent[0])
        self.assertNotIn("CODEBASE MAP", sent[1])


if __name__ == "__main__":
    unittest.main()
