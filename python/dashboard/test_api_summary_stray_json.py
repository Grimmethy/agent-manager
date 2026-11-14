"""GET /api/summary must survive a stray non-record JSON file in a queue state directory (2026-11-10: queue/needs-clarification/clarification-history.json, a JSON list written by
src/scoped-clarification.js, made count_adhoc_in call .get on a list: HTTP 500 and the header read 'disconnected' for hours).

Run from python/dashboard: .venv/bin/python -B -m unittest test_api_summary_stray_json
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes import shared_misc  # noqa: E402

STRAY = {"list.json": "[1, 2]", "string.json": '"text"', "null.json": "null", "number.json": "7", "broken.json": "{not json"}


class Stray(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.qdir = Path(self._tmp.name)
        for state in (*app.QUEUE_STATES, "adhoc", "drafting/lane-a"):
            (self.qdir / state).mkdir(parents=True, exist_ok=True)
        for rel, rec in (
            ("done/ship-1.json", {"id": "ship-1", "terminalDisposition": "merged", "history": [{"stage": "applied", "detail": "merged abc123"}]}),
            ("adhoc/adhoc-a.json", {"id": "adhoc-a", "domain": "adhoc"}),
            ("pending/adhoc-p.json", {"id": "adhoc-p", "domain": "adhoc"}),
            ("blocked/adhoc-c.json", {"id": "adhoc-c", "domain": "adhoc"}),
            ("needs-clarification/adhoc-n.json", {"id": "adhoc-n", "domain": "adhoc"}),
            ("drafting/lane-a/adhoc-d.json", {"id": "adhoc-d", "domain": "adhoc"}),
        ):
            (self.qdir / rel).write_text(json.dumps(rec), encoding="utf-8")
        for p in (mock.patch.object(app, "queue_dir", lambda: self.qdir), mock.patch.object(app, "_brain_dump_entries_with_task_status", lambda: []),
                  mock.patch.object(app, "list_unmerged_branches", lambda force=False: []), mock.patch.object(shared_misc, "_SUMMARY_TTL_S", 0.0)):
            p.start()
            self.addCleanup(p.stop)
        self.client = app.app.test_client()

    def summary(self):
        shared_misc._summary_state["entry"] = None
        shared_misc._verdict_cache.clear()
        resp = self.client.get("/api/summary")
        return resp.status_code, resp.get_json()

    def add_stray(self, *dirs):
        for d in dirs:
            for name, text in STRAY.items():
                (self.qdir / d / name).write_text(text, encoding="utf-8")

    def test_stray_files_in_every_glob_site_do_not_change_the_answer_or_fail_it(self):
        code, clean = self.summary()
        self.assertEqual(code, 200)
        self.add_stray("needs-clarification", "blocked", "pending", "adhoc", "drafting/lane-a")
        code, dirty = self.summary()
        self.assertEqual(code, 200)
        for key in ("adhocBlocked", "adhocInProgress", "doneShipped", "doneNoop"):
            self.assertEqual(dirty[key], clean[key], key)
        self.assertEqual((dirty["adhocBlocked"], dirty["adhocInProgress"]), (2, 3))

    def test_a_stray_file_in_done_counts_as_noop_not_shipped(self):
        _, clean = self.summary()
        self.add_stray("done")
        code, dirty = self.summary()
        self.assertEqual(code, 200)
        self.assertEqual(dirty["doneShipped"], clean["doneShipped"])
        self.assertEqual(dirty["doneNoop"], clean["doneNoop"] + len(STRAY))


if __name__ == "__main__":
    unittest.main()
