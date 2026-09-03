"""Tests for the Unmerged Branches detail enrichment -- joining a branch's commits back
to their originating tasks' real pipeline logs and to the owning coordinator hub, so the
modal shows a complete task log instead of raw `git log` output.

Run: .venv/bin/python -m unittest python.dashboard.test_unmerged_branch_task_log -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


def _mkqueue(root: Path):
    for s in ("done", "adhoc", "coordinating", "blocked", "done/_superseded", "done/_archived_no_action"):
        (root / "queue" / s).mkdir(parents=True, exist_ok=True)
    return root / "queue"


class TestBranchTaskLog(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.q = _mkqueue(self.dir)

    def _w(self, state, obj):
        (self.q / state / f"{obj['id']}.json").write_text(json.dumps(obj))

    def test_find_task_record_anywhere_covers_done_and_superseded(self):
        self._w("done", {"id": "t-done", "title": "D"})
        self._w("done/_superseded", {"id": "t-sup", "title": "S"})
        d, st = app._find_task_record_anywhere(self.q, "t-done")
        self.assertEqual(st, "done")
        d, st = app._find_task_record_anywhere(self.q, "t-sup")
        self.assertEqual(st, "superseded")
        self.assertEqual(app._find_task_record_anywhere(self.q, "nope"), (None, None))

    def test_summarize_task_record_pulls_history_and_review_votes(self):
        rec = {
            "id": "x", "title": "X", "terminalDisposition": "merged",
            "history": [
                {"stage": "created", "at": "1"},
                {"stage": "approved", "at": "2", "detail": "votes: 2/3 real"},
                {"stage": "applied", "at": "3", "detail": "agent/decompose-x"},
            ],
        }
        s = app._summarize_task_record(rec, "done")
        self.assertEqual(s["reviewVotes"], "votes: 2/3 real")
        self.assertEqual([h["stage"] for h in s["history"]], ["created", "approved", "applied"])
        self.assertEqual(s["terminalDisposition"], "merged")

    def test_hub_matched_by_branch_field_and_readiness(self):
        # stacked hub, 2/3 done, gate pending -> NOT ready to merge
        self._w("coordinating", {
            "id": "file-decompose-hub-decompose-app-py-01",
            "title": "Decompose app.py", "mode": "stacked",
            "branch": "agent/decompose-decompose-app-py-01",
            "integrationGate": {"status": "pending"},
            "subTasks": [
                {"id": "a", "title": "move a", "status": "done"},
                {"id": "b", "title": "move b", "status": "done"},
                {"id": "w", "title": "wiring", "status": "in-progress"},
            ],
        })
        hub = app._hub_for_branch(self.q, "agent/decompose-decompose-app-py-01", [])
        self.assertIsNotNone(hub)
        self.assertEqual(hub["progress"], {"done": 2, "total": 3})
        self.assertFalse(hub["readyToMerge"])

    def test_hub_ready_when_all_done_and_gate_passed(self):
        self._w("coordinating", {
            "id": "file-decompose-hub-x", "branch": "agent/decompose-x", "mode": "stacked",
            "integrationGate": {"status": "passed", "checks": [{"name": "import", "status": "pass"}]},
            "subTasks": [{"id": "a", "status": "done"}, {"id": "w", "status": "done"}],
        })
        hub = app._hub_for_branch(self.q, "agent/decompose-x", [])
        self.assertTrue(hub["readyToMerge"])
        self.assertEqual(hub["integrationGate"]["checks"][0]["name"], "import")

    def test_hub_matched_by_child_task_id(self):
        self._w("coordinating", {
            "id": "hub-1", "subTasks": [{"id": "child-42", "status": "done"}, {"id": "child-43", "status": "blocked"}],
            "integrationGate": {},
        })
        hub = app._hub_for_branch(self.q, "agent/child-42", ["child-42"])
        self.assertEqual(hub["id"], "hub-1")
        self.assertFalse(hub["readyToMerge"])  # a child is blocked

    def test_no_hub_for_an_ordinary_branch(self):
        self.assertIsNone(app._hub_for_branch(self.q, "agent/adhoc-some-normal-task", ["adhoc-some-normal-task"]))

    def test_task_trailer_regex(self):
        body = "did the thing\n\nTask: adhoc-decompose-decompose-app-py-01-02-reports-py (adhoc/manual)\n\nCo-Authored-By: x"
        m = app._TASK_TRAILER_RE.search(body)
        self.assertEqual(m.group(1), "adhoc-decompose-decompose-app-py-01-02-reports-py")


if __name__ == "__main__":
    unittest.main()
