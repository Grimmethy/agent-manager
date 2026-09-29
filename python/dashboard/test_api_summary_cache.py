"""Tests for GET /api/summary's caching (2026-09-29: the 5s nav poll json-parsed every record
in queue/done/ on every call -- 28s live on the busy media drive, polls piled up, header read
"disconnected"). Covers: identical counts, per-record mtime-keyed verdict cache, TTL cache,
and single-flight with a stale fallback.

Run: .venv/bin/python -m unittest python.dashboard.test_api_summary_cache -v
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes import shared_misc  # noqa: E402


def _ship(tid):
    return {"id": tid, "terminalDisposition": "merged", "history": [{"stage": "applied", "detail": "merged abc123"}]}


class ApiSummaryCacheTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.qdir = Path(self._tmp.name)
        for state in (*app.QUEUE_STATES, "adhoc"):
            (self.qdir / state).mkdir(exist_ok=True)
        self._put("done/ship-1.json", _ship("ship-1"))
        self._put("done/noop-1.json", {"id": "noop-1", "terminalDisposition": "noop"})
        self._put("adhoc/adhoc-a.json", {"id": "adhoc-a", "domain": "adhoc"})
        self._put("adhoc/adhoc-b.json", {"id": "adhoc-b", "domain": "default"})
        self._put("adhoc/other.json", {"id": "other", "domain": "default"})
        self._put("blocked/adhoc-c.json", {"id": "adhoc-c", "domain": "adhoc"})
        self.reads = []
        real_read = app.read_json_safe

        def counting_read(path):
            self.reads.append(Path(path).name)
            return real_read(path)

        shared_misc._summary_state["entry"] = None
        shared_misc._verdict_cache.clear()
        patches = [
            mock.patch.object(app, "queue_dir", lambda: self.qdir),
            mock.patch.object(app, "read_json_safe", counting_read),
            mock.patch.object(app, "_brain_dump_entries_with_task_status", lambda: []),
            mock.patch.object(app, "list_unmerged_branches", lambda force=False: []),
            mock.patch.object(shared_misc, "_SUMMARY_TTL_S", 0.0),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.client = app.app.test_client()

    def tearDown(self):
        self._tmp.cleanup()

    def _put(self, rel, payload):
        (self.qdir / rel).write_text(json.dumps(payload), encoding="utf-8")

    def _get(self):
        return self.client.get("/api/summary").get_json()

    def test_counts_are_correct_and_not_stale(self):
        data = self._get()
        self.assertEqual(data["doneShipped"], 1)
        self.assertEqual(data["doneNoop"], 1)
        self.assertEqual(data["adhocInProgress"], 2)  # domain "adhoc" OR an "adhoc-" id prefix
        self.assertEqual(data["adhocBlocked"], 1)
        self.assertNotIn("stale", data)

    def test_unchanged_records_are_not_reparsed_and_a_rewrite_is(self):
        first = self._get()
        self.assertGreater(len(self.reads), 0)
        self.reads.clear()
        self.assertEqual(self._get(), first)
        self.assertEqual(self.reads, [])
        self._put("done/ship-1.json", {"id": "ship-1", "terminalDisposition": "noop"})
        st = (self.qdir / "done" / "ship-1.json").stat()
        os.utime(self.qdir / "done" / "ship-1.json", ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
        data = self._get()
        self.assertEqual(self.reads, ["ship-1.json"])
        self.assertEqual((data["doneShipped"], data["doneNoop"]), (0, 2))

    def test_deleted_records_are_pruned_from_the_verdict_cache(self):
        self._get()
        (self.qdir / "done" / "noop-1.json").unlink()
        self._get()
        self.assertFalse(any(k[1].endswith("noop-1.json") for k in shared_misc._verdict_cache))

    def test_ttl_cache_skips_recompute(self):
        with mock.patch.object(shared_misc, "_SUMMARY_TTL_S", 60.0):
            self._get()
            with mock.patch.object(shared_misc, "_compute_summary_counts") as compute:
                self._get()
                compute.assert_not_called()

    def test_overlapping_poll_gets_stale_payload_instead_of_blocking(self):
        first = self._get()
        started, release = threading.Event(), threading.Event()
        real_compute = shared_misc._compute_summary_counts
        calls = []

        def slow_compute(qdir):
            calls.append(1)
            started.set()
            release.wait(10)
            return real_compute(qdir)

        with mock.patch.object(shared_misc, "_compute_summary_counts", slow_compute):
            worker = threading.Thread(target=self._get)
            worker.start()
            self.assertTrue(started.wait(5))
            overlapping = self._get()
            release.set()
            worker.join(10)
        self.assertEqual(len(calls), 1)
        self.assertIs(overlapping.get("stale"), True)
        self.assertEqual({k: v for k, v in overlapping.items() if k != "stale"}, first)


if __name__ == "__main__":
    unittest.main()
