import tempfile
import unittest
from pathlib import Path

from chat_sessions import _read_agents_md


class TestReadAgentsMd(unittest.TestCase):
    def test_non_utf8_agents_md_returns_empty(self):
        """A non-UTF-8 AGENTS.md must not raise; the function returns '' (no section).

        Without the fix, Path.read_text(encoding='utf-8') raises UnicodeDecodeError
        (a ValueError, not an OSError), the except OSError clause does not catch it,
        and the exception propagates out of _read_agents_md, crashing the chat turn.
        """
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "AGENTS.md").write_bytes(b"\x93")
            session = {"repoRoot": tmp, "roots": [tmp]}
            result = _read_agents_md(session)
            self.assertEqual(result, "")


if __name__ == "__main__":
    unittest.main()
