"""Tests for chat_card.py and the Chat paths that use it (card choice per message, env override for the node child, move/blocked notes).
Every node/model call is mocked: nothing here reads the real lease or reaches an Ollama.

Run: .venv/bin/python -m unittest test_chat_card -v   (from python/dashboard)
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import chat_card  # noqa: E402
import chat_sessions  # noqa: E402
import local_tool_client  # noqa: E402

REAL_STREAM = local_tool_client.stream_plan_with_tools

FREE = {"lane": "worker-3090", "env": {}, "moved": False, "from": None, "blocked": False, "note": ""}
MOVED = {"lane": "worker-rx580", "env": {"OLLAMA_URL": "http://100.96.112.78:11434", "LOCAL_MODEL": "qwen3-vl:8b-instruct"},
         "moved": True, "from": "worker-3090", "blocked": False, "note": "The Forge is using 3090, so this reply runs on rx580."}
BLOCKED = {"lane": None, "env": {}, "moved": False, "from": "worker-3090", "blocked": True, "note": "Every GPU card is held by the Forge family right now."}


class SafeCase(unittest.TestCase):
    """Anything that would reach a real process or model raises unless the test re-patches it."""

    def setUp(self):
        for target in ("subprocess.run", "subprocess.Popen", "local_tool_client.stream_plan_with_tools"):
            p = mock.patch(target, side_effect=AssertionError(f"unexpected real call: {target}"))
            p.start()
            self.addCleanup(p.stop)


class ResolveChatCardTest(SafeCase):
    def _run(self, stdout="", returncode=0):
        return mock.patch("subprocess.run", return_value=subprocess.CompletedProcess([], returncode, stdout, ""))

    def test_passes_the_card_flag_and_returns_the_parsed_choice(self):
        with self._run(json.dumps(MOVED)) as run:
            out = chat_card.resolve_chat_card("worker-3090")
        self.assertEqual(out, MOVED)
        self.assertEqual(run.call_args.args[0][-2:], ["--card", "worker-3090"])

    def test_no_preference_sends_no_flag(self):
        with self._run(json.dumps(FREE)) as run:
            chat_card.resolve_chat_card(None)
        self.assertNotIn("--card", run.call_args.args[0])

    def test_unreadable_picker_falls_back_to_unblocked_inherited_env(self):
        for bad in ("", "not json", "[]", '{"x":1}'):
            with self._run(bad):
                out = chat_card.resolve_chat_card("")
            self.assertFalse(out["blocked"])
            self.assertEqual(out["env"], {})

    def test_node_missing_or_timing_out_falls_back_too(self):
        for exc in (OSError("no node"), subprocess.TimeoutExpired("node", 5)):
            with mock.patch("subprocess.run", side_effect=exc):
                self.assertFalse(chat_card.resolve_chat_card("")["blocked"])


class ChildEnvTest(SafeCase):
    def test_without_a_card_the_env_is_unchanged_apart_from_priority(self):
        env = local_tool_client._child_env(None)
        self.assertEqual(env["AGENT_MANAGER_PRIORITY_HOLDER"], "1")
        self.assertNotIn("AGENT_MANAGER_CHAT_CARD_GUARD", env)

    def test_card_env_overrides_and_turns_the_guard_on(self):
        with mock.patch.dict("os.environ", {"OLLAMA_URL": "http://localhost:11434", "LOCAL_MODEL": "big"}):
            env = local_tool_client._child_env({"OLLAMA_URL": "http://100.96.112.78:11434", "LOCAL_MODEL": "small"})
        self.assertEqual(env["OLLAMA_URL"], "http://100.96.112.78:11434")
        self.assertEqual(env["LOCAL_MODEL"], "small")
        self.assertEqual(env["AGENT_MANAGER_CHAT_CARD_GUARD"], "1")

    def test_stream_plan_with_tools_hands_the_card_env_to_the_child(self):
        proc = mock.MagicMock()
        proc.stdout = iter([json.dumps({"type": "final", "response": "ok"}) + "\n"])
        proc.wait.return_value = 0
        proc.returncode = 0
        proc.stderr.read.return_value = ""
        with mock.patch("subprocess.Popen", return_value=proc) as popen:
            events = list(REAL_STREAM(prompt="hi", card_env={"OLLAMA_URL": "http://x:1"}))
        self.assertEqual(events[-1]["type"], "final")
        env = popen.call_args.kwargs["env"]
        self.assertEqual(env["OLLAMA_URL"], "http://x:1")
        self.assertEqual(env["AGENT_MANAGER_CHAT_CARD_GUARD"], "1")


class StreamLocalTest(SafeCase):
    def _session(self, card=None):
        return {"id": "s1", "repoRoot": "/r", "roots": ["/r"], "transcript": [], "card": card}

    def _run(self, card_result, final=None):
        seen = {}

        def fake_stream(**kw):
            seen.update(kw)
            yield {"type": "chunk", "text": "hello"}
            yield {"type": "final", "response": "hello", "turnsUsed": 1}

        with mock.patch("chat_card.resolve_chat_card", return_value=card_result) as resolve, \
                mock.patch("local_tool_client.stream_plan_with_tools", side_effect=fake_stream), \
                mock.patch("chat_sessions._build_local_messages", return_value=[{"role": "user", "content": "hi"}]), \
                mock.patch("chat_sessions.model_stats_client.record_call") as record:
            out = list(chat_sessions._stream_local(self._session("worker-rx580"), "hi"))
        return out, seen, resolve, record

    def test_session_card_is_resolved_and_its_env_reaches_the_tool_client(self):
        out, seen, resolve, record = self._run(FREE)
        resolve.assert_called_once_with("worker-rx580")
        self.assertEqual(out, ["hello"])
        self.assertEqual(seen["card_env"], {})

    def test_a_move_is_announced_before_the_reply_and_uses_the_card_model_for_stats(self):
        out, seen, _, record = self._run(MOVED)
        self.assertEqual(out[0], "*(The Forge is using 3090, so this reply runs on rx580.)*\n\n")
        self.assertEqual(out[1], "hello")
        self.assertEqual(seen["card_env"]["OLLAMA_URL"], "http://100.96.112.78:11434")
        self.assertEqual(record.call_args.args[1], "qwen3-vl:8b-instruct")

    def test_every_card_held_says_so_and_starts_no_model_call(self):
        out, seen, _, record = self._run(BLOCKED)
        self.assertEqual(out, ["Every GPU card is held by the Forge family right now."])
        self.assertEqual(seen, {})
        record.assert_not_called()


class InternalLocalTurnTest(SafeCase):
    def setUp(self):
        super().setUp()
        import app
        self.client = app.app.test_client()
        env = mock.patch.dict("os.environ", {"AGENT_MANAGER_INTERNAL_TOKEN": "t"})
        env.start()
        self.addCleanup(env.stop)

    def _turn(self, card_result, body):
        seen = {}

        def fake_stream(**kw):
            seen.update(kw)
            yield {"type": "final", "response": "ok"}

        with mock.patch("chat_card.resolve_chat_card", return_value=card_result) as resolve, \
                mock.patch("local_tool_client.stream_plan_with_tools", side_effect=fake_stream):
            res = self.client.post("/api/internal/chat/local-turn", json=body, headers={"X-Internal-Token": "t"})
            text = res.get_data(as_text=True)
        return text, seen, resolve

    def test_body_card_is_resolved_and_its_env_passed_with_a_note_chunk(self):
        text, seen, resolve = self._turn(MOVED, {"prompt": "hi", "card": "worker-3090"})
        resolve.assert_called_once_with("worker-3090")
        self.assertEqual(seen["card_env"]["LOCAL_MODEL"], "qwen3-vl:8b-instruct")
        self.assertIn("runs on rx580", text)

    def test_blocked_is_an_error_event_and_no_model_call(self):
        text, seen, _ = self._turn(BLOCKED, {"prompt": "hi"})
        self.assertIn('"type": "error"', text)
        self.assertIn("Every GPU card is held", text)
        self.assertEqual(seen, {})


class InternalPreemptTest(SafeCase):
    def setUp(self):
        super().setUp()
        import app
        self.client = app.app.test_client()
        env = mock.patch.dict("os.environ", {"AGENT_MANAGER_INTERNAL_TOKEN": "t"})
        env.start()
        self.addCleanup(env.stop)
        gate = mock.patch("app._chat_preempt_enabled", return_value=True)
        gate.start()
        self.addCleanup(gate.stop)

    def test_the_route_resolves_the_body_card_and_preempts_for_that_choice(self):
        with mock.patch("chat_card.resolve_chat_card", return_value=MOVED) as resolve, \
                mock.patch("app._preempt_pipeline_for_chat", return_value=[{"lane": "draft"}]) as preempt:
            res = self.client.post("/api/internal/chat/preempt", json={"card": "worker-3090"}, headers={"X-Internal-Token": "t"})
        resolve.assert_called_once_with("worker-3090")
        preempt.assert_called_once_with(MOVED)
        self.assertEqual(res.get_json(), {"preempted": [{"lane": "draft"}]})


class SetCardTest(SafeCase):
    def test_set_card_persists_and_clears(self):
        with tempfile.TemporaryDirectory() as d:
            storage = Path(d)
            session = chat_sessions._new_session(["/r"], None, chat_sessions.PROVIDER_LOCAL, None, None)
            self.assertIsNone(session["card"])
            chat_sessions._write_sessions(storage, {session["id"]: session})
            self.assertEqual(chat_sessions.set_card(storage, session["id"], " worker-rx580 ")["card"], "worker-rx580")
            self.assertEqual(chat_sessions._read_sessions(storage)[session["id"]]["card"], "worker-rx580")
            self.assertIsNone(chat_sessions.set_card(storage, session["id"], "")["card"])
            self.assertIsNone(chat_sessions.set_card(storage, "missing", "x"))


if __name__ == "__main__":
    unittest.main()
