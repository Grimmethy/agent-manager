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

    def test_summarize_task_record_shows_note_text_when_detail_is_absent(self):
        # The pre-task-history.js {"status": "pending", "note": ...} shape, and the
        # requeued event api_task_requeue's history-append fix now writes -- both carry
        # their text in `note`, not `detail`. Root-caused live 2026-09-12:
        # observability-fix-ac-158's requeue entry rendered as a bare "pending" label with
        # nothing visible beneath it before this fix.
        rec = {
            "id": "x", "history": [
                {"status": "pending", "at": "1", "note": "manually requeued from blocked/"},
            ],
        }
        s = app._summarize_task_record(rec, "done")
        self.assertEqual(s["history"][0]["detail"], "manually requeued from blocked/")

    def test_summarize_task_record_surfaces_blockedReasonAtRequeue_and_prior_feedback(self):
        rec = {
            "id": "x", "history": [
                {
                    "stage": "requeued", "at": "1", "note": "manually requeued from blocked/",
                    "blockedReasonAtRequeue": "diff touches a forbidden file",
                    "priorRejectionFeedbackAtRequeue": ["earlier rejection"],
                },
            ],
        }
        s = app._summarize_task_record(rec, "done")
        detail = s["history"][0]["detail"]
        self.assertIn("manually requeued from blocked/", detail)
        self.assertIn("diff touches a forbidden file", detail)
        self.assertIn("earlier rejection", detail)

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

    def test_shipped_count_excludes_noop(self):
        # 2026-08-25: 24 of 25 "shipped" tasks produced zero code. A done-queue mix of
        # 1 real merge + 1 no-op must tally as shipped==1, noop==1 -- not 2/2.
        self._w("done", {
            "id": "real-1", "title": "Real", "terminalDisposition": "merged",
            "history": [
                {"stage": "created", "at": "1"},
                {"stage": "approved", "at": "2", "detail": "votes: 3/3 real"},
                {"stage": "applied", "at": "3", "detail": "agent/real-1"},
            ],
        })
        self._w("done", {
            "id": "noop-1", "title": "Noop", "terminalDisposition": "noop",
            "history": [
                {"stage": "created", "at": "1"},
                {"stage": "applied", "at": "3", "detail": "no candidates in implement response -- nothing to apply"},
            ],
        })
        shipped = noop = 0
        for tid in ("real-1", "noop-1"):
            rec = json.loads((self.q / "done" / f"{tid}.json").read_text())
            if app._is_real_ship(rec):
                shipped += 1
            else:
                noop += 1
        self.assertEqual(shipped, 1)
        self.assertEqual(noop, 1)
        # No applied stage at all -- or an applied stage with an empty detail -- is also
        # a no-op, never a ship.
        self.assertFalse(app._is_real_ship({"id": "x", "terminalDisposition": "merged", "history": [{"stage": "created"}]}))
        self.assertFalse(app._is_real_ship({"id": "y", "terminalDisposition": "merged", "history": [{"stage": "applied", "detail": ""}]}))


class TestDescribeChange(unittest.TestCase):
    def test_strips_diff_after_resolution_line(self):
        # The real shape agentic-draft-common.js produces: a short plain-English summary
        # ending right at the RESOLUTION line, then `${summary}\n\n=== DIFF ===\n${rawDiff}`.
        # Before the fix, everything after the RESOLUTION match (including the whole diff)
        # was returned verbatim as the "What this changes" description.
        implement = (
            "RESOLUTION: implemented\ndone\n\n"
            "=== DIFF ===\n"
            "diff --git a/src/x.js b/src/x.js\n"
            "index 111..222 100644\n"
            "--- a/src/x.js\n"
            "+++ b/src/x.js\n"
        )
        desc = app._describe_change({"implementResponse": implement})
        self.assertEqual(desc, "done")
        self.assertNotIn("diff --git", desc)
        self.assertNotIn("=== DIFF ===", desc)

    def test_no_diff_marker_still_returns_full_text(self):
        desc = app._describe_change({"implementResponse": "RESOLUTION: no-changes-needed\nalready covered by existing tests"})
        self.assertEqual(desc, "already covered by existing tests")

    def test_fallback_strategy_also_excludes_diff(self):
        # No RESOLUTION line at all (e.g. a verdict-only source) -- strategy 3 falls back
        # to implementResponse directly, which must still have the diff stripped.
        implement = "Plain prose verdict write-up.\n\n=== DIFF ===\ndiff --git a/y.js b/y.js\n"
        desc = app._describe_change({"implementResponse": implement})
        self.assertEqual(desc, "Plain prose verdict write-up.")


if __name__ == "__main__":
    unittest.main()
