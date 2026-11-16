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

    def test_branch_pushed_line_has_identical_keys_and_order_from_node_and_python(self):
        node_dir = tempfile.mkdtemp(prefix="qev-node-")
        self.addCleanup(shutil.rmtree, node_dir, True)
        event = {"type": "branch_pushed", "branch": "agent/t9", "taskId": "t9", "sha": "abc123", "verdict": "approved", "source": "apply"}
        script = "const q=require('./src/queue-events.js');q.append(process.argv[1],JSON.parse(process.argv[2]))"
        out = subprocess.run(["node", "-e", script, node_dir, json.dumps(event)], cwd=str(REPO), capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertTrue(queue_events.append_event(self.dir, event))
        node_journal = os.path.join(node_dir, "queue-events", "journal.jsonl")
        with open(node_journal, encoding="utf-8") as f:
            node_lines = f.read().split("\n")[:-1]
        py_lines = self.lines()
        self.assertEqual(len(node_lines), 1)
        self.assertEqual(len(py_lines), 1)
        node_rec, py_rec = json.loads(node_lines[0]), json.loads(py_lines[0])
        self.assertEqual(list(node_rec.keys()), KEYS)
        self.assertEqual(list(py_rec.keys()), list(node_rec.keys()))
        self.assertEqual(node_rec["type"], "branch_pushed")
        self.assertEqual(py_rec["type"], "branch_pushed")
        for key in ("type", "branch", "taskId", "sha", "verdict", "source"):
            self.assertEqual(node_rec[key], py_rec[key])
        for line in (node_lines[0], py_lines[0]):
            self.assertLess(len((line + "\n").encode("utf-8")), queue_events.MAX_LINE_BYTES)


if __name__ == "__main__":
    unittest.main()
