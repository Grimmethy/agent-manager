"""Regression test: subprocess.TimeoutExpired does NOT inherit from TimeoutError, so a
hang past claude_client.py's/local_tool_client.py's own SUBPROCESS_TIMEOUT_S fell straight
through every layer of error handling (including app.py's _call_discuss/_call_chat,
which only catch ClaudeClientError/LocalToolClientError plus the builtin
TimeoutError/ConnectionError/OSError trio) as a raw, unhandled 500 -- caught live via the
Chat panel's first real message, queued a long time behind a stuck worker-lane task.
Both client modules now catch it at the source and normalize it into their own exception
type, same as every other subprocess failure mode they already handle.

Mocks subprocess.run to raise TimeoutExpired synchronously -- no real 270s+ wait needed
to exercise this. Matches test_build_graph.py's own zero-extra-dependency stdlib-unittest
convention.

Run: .venv/bin/python -m unittest python.dashboard.test_client_timeout_handling -v
"""
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import claude_client  # noqa: E402
import local_tool_client  # noqa: E402


class ClaudeClientTimeoutTest(unittest.TestCase):
    def test_generate_raises_ClaudeClientError_not_a_raw_TimeoutExpired(self):
        with patch("claude_client.subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="claude", timeout=330)):
            with self.assertRaises(claude_client.ClaudeClientError) as ctx:
                claude_client.generate("hi")
            self.assertIn("did not respond within", str(ctx.exception))


class LocalToolClientTimeoutTest(unittest.TestCase):
    def test_run_plan_with_tools_raises_LocalToolClientError_not_a_raw_TimeoutExpired(self):
        with patch("local_tool_client.subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="node", timeout=270)):
            with self.assertRaises(local_tool_client.LocalToolClientError) as ctx:
                local_tool_client.run_plan_with_tools("hi")
            self.assertIn("did not respond within", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
