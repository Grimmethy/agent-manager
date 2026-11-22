"""The queue-events journal counter on the dashboard summary (queue_events_status.py, /api/summary `queueEvents`), ADR-0024 S1, HUB0330 piece 8.

Run: .venv/bin/python -m unittest test_queue_events_status -v   (from python/dashboard)
Real temp pipeline directories; the cross-language test uses the real Node writer and is skipped without node.
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

import app  # noqa: E402
import queue_events_status as qes  # noqa: E402
from routes import shared_misc  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
EMPTY = {"total": 0, "byConsumer": {}, "lastAt": None, "journalBytes": 0}


class Base(unittest.TestCase):
    def setUp(self):
        self.pipe = tempfile.mkdtemp(prefix="qev-status-")
        self.addCleanup(shutil.rmtree, self.pipe, True)
        self.qdir = os.path.join(self.pipe, "queue")
        os.makedirs(self.qdir)
        self.dir = os.path.join(self.pipe, "queue-events")

    def write(self, name, text):
        os.makedirs(self.dir, exist_ok=True)
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as f:
            f.write(text)


class Status(Base):
    def test_absent_files_read_as_zeros(self):
        self.assertEqual(qes.queue_events_status(self.qdir), EMPTY)

    def test_a_valid_reconcile_file_and_a_journal_are_reported(self):
        self.write("reconcile.json", json.dumps({"total": 3, "byConsumer": {"redo-supersede": 2, "defect-readmit": 1}, "lastAt": "2026-11-03T12:00:00.000Z"}))
        self.write("journal.jsonl", "x" * 1234)
        self.assertEqual(qes.queue_events_status(self.qdir), {"total": 3, "byConsumer": {"redo-supersede": 2, "defect-readmit": 1}, "lastAt": "2026-11-03T12:00:00.000Z", "journalBytes": 1234})

    def test_a_corrupt_or_odd_reconcile_file_reads_as_zeros_but_the_journal_size_still_counts(self):
        self.write("journal.jsonl", "abc")
        self.write("reconcile.json", "{not json")
        self.assertEqual(qes.queue_events_status(self.qdir), {**EMPTY, "journalBytes": 3})
        self.write("reconcile.json", json.dumps({"total": "many", "byConsumer": {"a": "x", "b": -1, "c": True, "d": 2}, "lastAt": 5}))
        self.assertEqual(qes.queue_events_status(self.qdir), {"total": 0, "byConsumer": {"d": 2}, "lastAt": None, "journalBytes": 3})
        self.write("reconcile.json", json.dumps([1, 2, 3]))
        self.assertEqual(qes.queue_events_status(self.qdir)["total"], 0)

    def test_it_never_raises_whatever_it_is_given(self):
        for bad in (None, "", 5, object()):
            self.assertEqual(qes.queue_events_status(bad)["total"], 0)

    def test_an_unexpected_error_inside_never_reaches_the_summary(self):
        with mock.patch.object(qes, "_pipeline_dir", side_effect=RuntimeError("boom")):
            self.assertEqual(qes.queue_events_status(self.qdir), EMPTY)

    @unittest.skipUnless(shutil.which("node"), "node is not on PATH: the cross-language check needs it")
    def test_it_reads_what_the_node_module_wrote(self):
        script = ("const q=require('./src/queue-events.js');const d=process.argv[1];"
                  "q.recordCorrection(d,'redo-supersede',2);q.recordCorrection(d,'conflict-readmit',1);"
                  "q.append(d,{type:'branch_merged',branch:'agent/x',taskId:'x'});")
        r = subprocess.run(["node", "-e", script, self.pipe], cwd=str(REPO), capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = qes.queue_events_status(self.qdir)
        self.assertEqual((out["total"], out["byConsumer"]), (3, {"redo-supersede": 2, "conflict-readmit": 1}))
        self.assertGreater(out["journalBytes"], 0)
        self.assertIsNotNone(out["lastAt"])


class Summary(Base):
    def test_with_memory_adds_queue_events_beside_memory_and_the_counts(self):
        self.write("reconcile.json", json.dumps({"total": 4, "byConsumer": {"defect-readmit": 4}, "lastAt": None}))
        with mock.patch("memory_status.memory_status", return_value={"state": "ok"}):
            out = shared_misc._with_memory({"blocked": 7}, Path(self.qdir))
        self.assertEqual(out["blocked"], 7)
        self.assertEqual(out["memory"], {"state": "ok"})
        self.assertEqual(out["queueEvents"]["total"], 4)

    def test_with_memory_without_a_queue_dir_still_works(self):
        with mock.patch("memory_status.memory_status", return_value={"state": "ok"}):
            out = shared_misc._with_memory({"blocked": 1})
        self.assertEqual(out["queueEvents"], EMPTY)

    def test_the_route_passes_the_queue_dir_to_the_counter_on_every_call_cached_or_not_and_recomputes_it(self):
        seen = []
        seq = iter([dict(EMPTY, total=1), dict(EMPTY, total=2)])
        client = app.app.test_client()

        def fake(q):
            seen.append(q)
            return next(seq)
        with mock.patch("app.queue_dir", return_value=Path(self.qdir)), \
             mock.patch("memory_status.memory_status", return_value={"state": "ok"}), \
             mock.patch("queue_events_status.queue_events_status", side_effect=fake):
            a = client.get("/api/summary").get_json()
            b = client.get("/api/summary").get_json()           # inside the counts' cache window: the second request is served from the cache
        self.assertEqual((a["queueEvents"]["total"], b["queueEvents"]["total"]), (1, 2))
        self.assertEqual(seen, [Path(self.qdir), Path(self.qdir)], "the counter got the active queue dir both times")
        self.assertIn("blocked", a)               # the queue counts are still there, cached or not


if __name__ == "__main__":
    unittest.main()
