"""Unit tests for python/dashboard/context_log_retrieval.retrieve_context_logs.

All fixtures live under tempfile directories; nothing touches a real Second Brain vault.
Run from the repo root with:
    python3 -m unittest discover -s python/tests -p 'test_context_log_retrieval.py' -v
(or `python -m pytest python/tests/test_context_log_retrieval.py` where pytest is installed).
"""

import os
import subprocess
import sys
import tempfile
import unittest

_DASHBOARD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dashboard'))
if _DASHBOARD_DIR not in sys.path:
    sys.path.insert(0, _DASHBOARD_DIR)

import context_log_retrieval as clr  # noqa: E402
from context_log_retrieval import (  # noqa: E402
    CONTEXT_LOG_CHAR_CAP,
    CONTEXT_LOG_MAX_FILES,
    retrieve_context_logs,
)

SUBDIR = os.path.join('Agent Manager Reports', 'Chat Context Logs')


def _write_note(vault, session_id, lines):
    log_dir = os.path.join(vault, SUBDIR)
    os.makedirs(log_dir, exist_ok=True)
    path = os.path.join(log_dir, f'{session_id}.md')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines) + '\n')
    return path


def _entry(iso, summary, project, task_ref):
    return f'- **{iso}** {summary} -- [[{project}]] (task `{task_ref}`)'


class RetrieveContextLogsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_matching_line_returned_with_audit_line(self):
        _write_note(self.vault, 'chat-1000-aaaa1111', [
            '',
            _entry('2026-01-01T10:00:00Z', 'Discussed the parser fix', 'proj', 'T-1'),
        ])
        text, injected = retrieve_context_logs(self.vault, 'proj', 'T-1')
        self.assertIn('Discussed the parser fix', text)
        self.assertIn('-- [[proj]] (task `T-1`)', text)
        self.assertIn(clr.AUDIT_PREFIX, text)
        self.assertIn('chat-1000-aaaa1111@2026-01-01T10:00:00Z', text)
        self.assertEqual(injected, [('chat-1000-aaaa1111', '2026-01-01T10:00:00Z')])

    def test_unlinked_and_other_project_lines_skipped(self):
        _write_note(self.vault, 'chat-2000-bbbb2222', [
            '- **2026-01-02T10:00:00Z** no suffix here',
            _entry('2026-01-02T11:00:00Z', 'belongs to other project', 'other', 'T-1'),
            _entry('2026-01-02T12:00:00Z', 'wanted line', 'proj', 'T-1'),
        ])
        text, _ = retrieve_context_logs(self.vault, 'proj', 'T-1')
        self.assertIn('wanted line', text)
        self.assertNotIn('no suffix here', text)
        self.assertNotIn('belongs to other project', text)

    def test_char_cap_truncates_output(self):
        _write_note(self.vault, 'chat-3000-cccc3333', [
            _entry('2026-01-03T10:00:00Z', 'older entry', 'proj', 'T-1'),
        ])
        _write_note(self.vault, 'chat-4000-dddd4444', [
            _entry('2026-01-04T10:00:00Z', 'newer entry', 'proj', 'T-1'),
        ])
        full, full_injected = retrieve_context_logs(self.vault, 'proj', 'T-1')
        self.assertEqual(len(full_injected), 2)
        cap = len(full) - 1
        text, injected = retrieve_context_logs(self.vault, 'proj', 'T-1', char_cap=cap)
        self.assertLessEqual(len(text), cap)
        self.assertIn('newer entry', text)
        self.assertNotIn('older entry', text)
        self.assertEqual(injected, [('chat-4000-dddd4444', '2026-01-04T10:00:00Z')])

    def test_default_cap_constant_is_positive(self):
        self.assertGreater(CONTEXT_LOG_CHAR_CAP, 0)
        self.assertGreater(CONTEXT_LOG_MAX_FILES, 0)

    def test_missing_directory_returns_empty(self):
        self.assertEqual(retrieve_context_logs(self.vault, 'proj', 'T-1'), ('', []))

    def test_module_does_not_import_llm_clients(self):
        code = (
            'import sys; sys.path.insert(0, sys.argv[1]); '
            'import context_log_retrieval; '
            'print("\\n".join(sorted(sys.modules)))'
        )
        out = subprocess.run(
            [sys.executable or 'python3', '-c', code, _DASHBOARD_DIR],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        loaded = set(out.stdout.split())
        for forbidden in ('local_client', 'ollama_client', 'claude_client'):
            self.assertNotIn(forbidden, loaded)


if __name__ == '__main__':
    unittest.main()
