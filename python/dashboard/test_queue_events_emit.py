"""The dashboard announces verdicts and merges in the queue-events journal (ADR-0024 S1, HUB0330 piece 3).

Run: .venv/bin/python -m unittest test_queue_events_emit -v   (from python/dashboard)
Real temp pipeline directories; record_verdict and _record_merge_in_task_file are the real functions.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import branch_verdicts  # noqa: E402
import queue_events  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.pipe = tempfile.mkdtemp(prefix="qev-emit-")
        self.addCleanup(shutil.rmtree, self.pipe, True)
        self.qdir = os.path.join(self.pipe, "queue")
        os.makedirs(os.path.join(self.qdir, "done"))
        self.journal = os.path.join(self.pipe, "queue-events", "journal.jsonl")

    def events(self):
        if not os.path.exists(self.journal):
            return []
        with open(self.journal, encoding="utf-8") as f:
            return [json.loads(line) for line in f.read().split("\n") if line]


class VerdictEmit(Base):
    def test_a_written_verdict_emits_one_verdict_recorded_line(self):
        record, written = branch_verdicts.record_verdict(self.qdir, "agent/t1", "sha1", "needs-work", ["a defect"], "chat")
        self.assertTrue(written)
        evs = self.events()
        self.assertEqual(len(evs), 1)
        self.assertEqual({k: evs[0][k] for k in ("type", "branch", "sha", "verdict", "source", "taskId")},
                         {"type": "verdict_recorded", "branch": "agent/t1", "sha": "sha1", "verdict": "needs-work", "source": "chat", "taskId": None})
        self.assertEqual(evs[0]["project"], os.path.realpath(self.pipe))

    def test_a_deterministic_verdict_that_does_not_replace_a_human_one_emits_nothing(self):
        branch_verdicts.record_verdict(self.qdir, "agent/t1", "sha1", "merge", ["ok"], "manual")
        before = len(self.events())
        record, written = branch_verdicts.record_verdict(self.qdir, "agent/t1", "sha1", "discard", ["auto"], "deterministic")
        self.assertFalse(written)
        self.assertEqual(len(self.events()), before)

    def test_a_rejected_body_emits_nothing(self):
        with self.assertRaises(ValueError):
            branch_verdicts.record_verdict(self.qdir, "agent/t1", "sha1", "not-a-verdict", [], "chat")
        self.assertEqual(self.events(), [])

    def test_a_failing_journal_never_stops_the_verdict(self):
        with mock.patch.object(queue_events, "append_event", side_effect=RuntimeError("journal exploded")):
            record, written = branch_verdicts.record_verdict(self.qdir, "agent/t1", "sha1", "merge", ["ok"], "chat")
        self.assertTrue(written)
        self.assertEqual(record["verdict"], "merge")
        self.assertEqual(branch_verdicts.get_verdict(self.qdir, "agent/t1", "sha1")["verdict"], "merge")

    def test_the_off_switch_emits_nothing(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_QUEUE_EVENTS": "off"}):
            branch_verdicts.record_verdict(self.qdir, "agent/t1", "sha1", "merge", ["ok"], "chat")
        self.assertEqual(self.events(), [])


class MergeEmit(Base):
    def setUp(self):
        super().setUp()
        import app  # noqa: F401  (the route module imports from app lazily)
        from routes import pipeline_1_more
        self.mod = pipeline_1_more
        self.done = Path(self.qdir) / "done"

    def _task(self, tid):
        (self.done / f"{tid}.json").write_text(json.dumps({"id": tid, "history": []}), encoding="utf-8")

    def test_a_merge_with_a_task_record_emits_branch_merged_after_the_write(self):
        self._task("t1")
        self.mod._record_merge_in_task_file("agent/t1", "main", Path(self.qdir))
        evs = self.events()
        self.assertEqual([(e["type"], e["branch"], e["taskId"]) for e in evs], [("branch_merged", "agent/t1", "t1")])
        self.assertEqual(json.loads((self.done / "t1.json").read_text())["terminalDisposition"], "merged")

    def test_no_record_means_no_event(self):
        self.mod._record_merge_in_task_file("agent/ghost", "main", Path(self.qdir))
        self.assertEqual(self.events(), [])

    def test_a_failed_write_raises_and_emits_nothing(self):
        self._task("t2")
        with mock.patch.object(Path, "write_text", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.mod._record_merge_in_task_file("agent/t2", "main", Path(self.qdir))
        self.assertEqual(self.events(), [])

    def test_a_failing_journal_never_breaks_the_merge_bookkeeping(self):
        self._task("t3")
        with mock.patch.object(queue_events, "append_event", side_effect=RuntimeError("journal exploded")):
            self.mod._record_merge_in_task_file("agent/t3", "main", Path(self.qdir))
        self.assertEqual(json.loads((self.done / "t3.json").read_text())["terminalDisposition"], "merged")

    def test_the_off_switch_emits_nothing(self):
        self._task("t4")
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_QUEUE_EVENTS": "off"}):
            self.mod._record_merge_in_task_file("agent/t4", "main", Path(self.qdir))
        self.assertEqual(self.events(), [])


if __name__ == "__main__":
    unittest.main()
