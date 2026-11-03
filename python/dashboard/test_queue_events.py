"""The Python writer for the queue-events journal (ADR-0024 S1, HUB0330 piece 2).

Run: .venv/bin/python -m unittest test_queue_events -v   (from python/dashboard)
The CROSS-LANGUAGE test is committed, not a manual check: Python appends, the real Node module reads, the results must be equal.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import queue_events  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
KEYS = ["at", "type", "branch", "taskId", "sha", "verdict", "source", "project"]


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="qev-py-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.journal = os.path.join(self.dir, "queue-events", "journal.jsonl")

    def lines(self):
        with open(self.journal, encoding="utf-8") as f:
            return f.read().split("\n")[:-1]


class WriterFormat(Base):
    def test_one_line_with_the_contract_keys_in_order_and_the_realpath(self):
        ok = queue_events.append_event(self.dir, {"type": "verdict_recorded", "branch": "agent/t1", "taskId": "t1", "sha": "s1", "verdict": "needs-work", "source": "chat", "at": "2026-11-03T10:00:00.000Z"})
        self.assertTrue(ok)
        raw = open(self.journal, encoding="utf-8").read()
        self.assertTrue(raw.endswith("\n"))
        rec = json.loads(raw)
        self.assertEqual(list(rec.keys()), KEYS)
        self.assertEqual(rec["project"], os.path.realpath(self.dir))
        self.assertEqual(rec["at"], "2026-11-03T10:00:00.000Z")
        self.assertNotIn(" ", raw.split('"branch"')[0], "compact separators like JSON.stringify")

    def test_missing_fields_are_null_and_at_defaults_to_an_iso_utc_stamp(self):
        queue_events.append_event(self.dir, {"type": "branch_merged", "branch": "agent/x"})
        rec = json.loads(self.lines()[0])
        self.assertIsNone(rec["sha"])
        self.assertRegex(rec["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")

    def test_two_appends_make_two_lines(self):
        queue_events.append_event(self.dir, {"type": "branch_merged", "branch": "agent/a"})
        queue_events.append_event(self.dir, {"type": "branch_merged", "branch": "agent/b"})
        self.assertEqual(len(self.lines()), 2)

    def test_rotation_replaces_journal_1_like_the_node_writer(self):
        for i in range(6):
            queue_events.append_event(self.dir, {"type": "branch_merged", "branch": "agent/t%d" % i}, rotate_bytes=300)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "queue-events", "journal.1.jsonl")))
        self.assertTrue(os.path.exists(self.journal))


class WriterErrors(Base):
    def test_unknown_type_and_oversize_raise_value_error_and_write_nothing(self):
        with self.assertRaises(ValueError):
            queue_events.append_event(self.dir, {"type": "something_else"})
        with self.assertRaises(ValueError):
            queue_events.append_event(self.dir, {"type": "branch_merged", "branch": "x" * 4000})
        self.assertFalse(os.path.exists(self.journal))

    def test_an_io_problem_returns_false_and_logs_instead_of_raising(self):
        blocker = os.path.join(self.dir, "afile")
        open(blocker, "w").close()
        with self.assertLogs("queue_events", level="WARNING") as cm:
            ok = queue_events.append_event(os.path.join(blocker, "pipeline"), {"type": "branch_merged", "branch": "agent/x"})
        self.assertFalse(ok)
        self.assertTrue(any("could not append" in m for m in cm.output))

    def test_the_kill_switch_writes_nothing(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_QUEUE_EVENTS": "off"}):
            self.assertFalse(queue_events.append_event(self.dir, {"type": "branch_merged", "branch": "agent/x"}))
        self.assertFalse(os.path.exists(self.journal))


@unittest.skipUnless(shutil.which("node"), "node is not on PATH: the cross-language check needs it")
class CrossLanguage(Base):
    def test_node_drain_reads_back_exactly_what_python_wrote(self):
        events = [
            {"type": "verdict_recorded", "branch": "agent/t1", "taskId": "t1", "sha": "s1", "verdict": "needs-work", "source": "worker", "at": "2026-11-03T10:00:00.000Z"},
            {"type": "branch_merged", "branch": "agent/caf\u00e9-\u2713", "taskId": "t2", "at": "2026-11-03T10:00:01.000Z"},
        ]
        for e in events:
            self.assertTrue(queue_events.append_event(self.dir, e))
        script = "const q=require('./src/queue-events.js');console.log(JSON.stringify(q.drain(process.argv[1],'xlang').events))"
        out = subprocess.run(["node", "-e", script, self.dir], cwd=str(REPO), capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        got = json.loads(out.stdout)
        expected = [dict({k: None for k in KEYS}, **e, project=os.path.realpath(self.dir)) for e in events]
        self.assertEqual(got, expected)


if __name__ == "__main__":
    unittest.main()
