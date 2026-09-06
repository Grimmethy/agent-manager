"""Tests for model_stats_client.record_call's real-usage extraction (2026-09-06,
Grimmethy: "you know how much I love being able to audit the work" -- found while
investigating a real Chat done_reason:"length" incident that model_calls rows for
"chat-session" had prompt_eval_count/eval_count/eval_duration_ns permanently NULL, even
though local-tool-client.js's own runPlanWithTools() result already carries the real
Ollama usage numbers. record_call() had these three fields hardcoded to None instead of
ever reading them off `result`.

Run: .venv/bin/python -m unittest python.dashboard.test_model_stats_client -v
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import model_stats_client  # noqa: E402


class RecordCallUsageExtractionTest(unittest.TestCase):
    def _payload_for(self, result):
        with mock.patch.object(model_stats_client, "_run_event") as m:
            model_stats_client.record_call("chat-session", "qwen3.8:27b-q4_K_M", 1234,
                                            stage="chat", result=result, source="chat")
            self.assertEqual(m.call_count, 1)
            event, payload = m.call_args.args
            self.assertEqual(event, "record-call")
            return payload

    def test_extracts_real_prompt_eval_count_eval_count_eval_duration_from_a_local_result(self):
        payload = self._payload_for({
            "prompt_eval_count": 16319, "eval_count": 65, "eval_duration": 987654321,
            "turnsUsed": 24,
        })
        self.assertEqual(payload["promptEvalCount"], 16319)
        self.assertEqual(payload["evalCount"], 65)
        self.assertEqual(payload["evalDurationNs"], 987654321)
        self.assertEqual(payload["turnsUsed"], 24)

    def test_leaves_the_three_fields_none_for_a_claude_backed_result_with_no_such_fields(self):
        payload = self._payload_for({"sessionId": "abc", "model": "claude-sonnet-5"})
        self.assertIsNone(payload["promptEvalCount"])
        self.assertIsNone(payload["evalCount"])
        self.assertIsNone(payload["evalDurationNs"])

    def test_leaves_the_three_fields_none_when_result_is_none_entirely(self):
        payload = self._payload_for(None)
        self.assertIsNone(payload["promptEvalCount"])
        self.assertIsNone(payload["evalCount"])
        self.assertIsNone(payload["evalDurationNs"])

    def test_zero_is_a_real_value_not_coerced_to_none(self):
        # A degenerate/empty completion can legitimately report eval_count: 0 -- must be
        # preserved as the real 0, not silently collapsed into "no data" the way a naive
        # `result.get(...) or None` would.
        payload = self._payload_for({"prompt_eval_count": 500, "eval_count": 0, "eval_duration": 0})
        self.assertEqual(payload["promptEvalCount"], 500)
        self.assertEqual(payload["evalCount"], 0)
        self.assertEqual(payload["evalDurationNs"], 0)

    def test_still_carries_degenerate_and_turns_used_unchanged_regression_guard(self):
        payload = self._payload_for({"degenerate": "empty", "turnsUsed": 5, "prompt_eval_count": 100})
        self.assertEqual(payload["degenerate"], "empty")
        self.assertEqual(payload["turnsUsed"], 5)


if __name__ == "__main__":
    unittest.main()
