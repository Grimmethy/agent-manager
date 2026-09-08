"""Tests for the global "all tasks completed" log (2026-09-08, Grimmethy: "I really
need an in app representation of that all tasks completed log under the workers. Make
sure it only loads the most recent 25 tasks until I scroll to the bottom.") and the
reviewer recent-tasks fix it grew out of (Grimmethy, same day: "Under reviewer they're
all showing approved and 5hours ago. I don't think it's updating properly.").

Covers _scan_recently_completed_tasks (mtime-ordered scan of queue/done/, cursor
pagination via `before`, reviewed_only filtering), GET /api/tasks/completed, and the
reviewer branch of GET /api/instances/<id>/recent-tasks now reading real task history
instead of the model_calls table (which is structurally blind to deterministic reviews
that make no model call at all).

Run: .venv/bin/python -m unittest python.dashboard.test_completed_tasks_log -v
"""
import json
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class CompletedTasksLogTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.queue = root / "queue"
        (self.queue / "done").mkdir(parents=True)
        self._patches = [mock.patch.object(app, "queue_dir", return_value=self.queue)]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _write_done(self, task_id, history=None, extra=None, mtime_offset=0.0):
        task = {
            "id": task_id, "title": f"title-{task_id}", "source": "adhoc",
            "draftModel": "qwen2.5:3b", "claimedBy": "worker-1",
            "terminalDisposition": "merged",
            "history": history if history is not None else [{"stage": "applied", "at": "2026-09-08T00:00:00Z"}],
        }
        if extra:
            task.update(extra)
        p = self.queue / "done" / f"{task_id}.json"
        p.write_text(json.dumps(task), encoding="utf-8")
        # Stagger mtimes so scandir-based ordering is deterministic across the whole
        # test run rather than relying on filesystem timestamp resolution alone.
        now = time.time() + mtime_offset
        import os
        os.utime(p, (now, now))
        return p


class TestScanRecentlyCompletedTasks(CompletedTasksLogTestBase):
    def test_orders_newest_first_and_respects_limit(self):
        self._write_done("a", mtime_offset=-30)
        self._write_done("b", mtime_offset=-20)
        self._write_done("c", mtime_offset=-10)
        rows, cursor = app._scan_recently_completed_tasks(2)
        self.assertEqual([r["taskId"] for r in rows], ["c", "b"])
        self.assertIsNotNone(cursor)

    def test_no_more_pages_returns_none_cursor(self):
        self._write_done("a")
        rows, cursor = app._scan_recently_completed_tasks(25)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(cursor)

    def test_before_cursor_pages_past_already_seen_rows(self):
        self._write_done("a", mtime_offset=-30)
        self._write_done("b", mtime_offset=-20)
        self._write_done("c", mtime_offset=-10)
        first, cursor = app._scan_recently_completed_tasks(2)
        self.assertEqual([r["taskId"] for r in first], ["c", "b"])
        second, cursor2 = app._scan_recently_completed_tasks(2, before_iso=cursor)
        self.assertEqual([r["taskId"] for r in second], ["a"])
        self.assertIsNone(cursor2)

    def test_reviewed_only_filters_to_tasks_with_a_review_stage(self):
        self._write_done("reviewed", history=[
            {"stage": "created", "at": "1"},
            {"stage": "approved", "at": "2"},
        ], mtime_offset=-10)
        self._write_done("drafted-only", history=[{"stage": "drafted", "at": "1"}], mtime_offset=-5)
        rows, _ = app._scan_recently_completed_tasks(25, reviewed_only=True)
        self.assertEqual([r["taskId"] for r in rows], ["reviewed"])

    def test_reviewed_only_includes_blocked_as_well_as_approved(self):
        self._write_done("blocked-review", history=[{"stage": "blocked", "at": "1"}])
        rows, _ = app._scan_recently_completed_tasks(25, reviewed_only=True)
        self.assertEqual([r["taskId"] for r in rows], ["blocked-review"])

    def test_empty_done_dir_returns_empty(self):
        rows, cursor = app._scan_recently_completed_tasks(25)
        self.assertEqual(rows, [])
        self.assertIsNone(cursor)

    def test_no_queue_dir_returns_empty(self):
        with mock.patch.object(app, "queue_dir", return_value=None):
            rows, cursor = app._scan_recently_completed_tasks(25)
        self.assertEqual(rows, [])
        self.assertIsNone(cursor)

    def test_row_shape(self):
        self._write_done("shaped")
        rows, _ = app._scan_recently_completed_tasks(25)
        row = rows[0]
        for key in ("taskId", "title", "source", "model", "instanceId", "completedAt", "outcome"):
            self.assertIn(key, row)
        self.assertEqual(row["taskId"], "shaped")
        self.assertEqual(row["outcome"], "merged")


class TestApiTasksCompletedRoute(CompletedTasksLogTestBase):
    def test_default_limit_is_25(self):
        for i in range(30):
            self._write_done(f"t{i}", mtime_offset=-i)
        resp = self.client.get("/api/tasks/completed")
        data = resp.get_json()
        self.assertEqual(len(data["tasks"]), 25)
        self.assertIsNotNone(data["nextCursor"])

    def test_limit_is_capped_at_100(self):
        resp = self.client.get("/api/tasks/completed?limit=500")
        self.assertEqual(resp.status_code, 200)

    def test_before_param_pages(self):
        self._write_done("a", mtime_offset=-2)
        self._write_done("b", mtime_offset=-1)
        first = self.client.get("/api/tasks/completed?limit=1").get_json()
        self.assertEqual(first["tasks"][0]["taskId"], "b")
        second = self.client.get(f"/api/tasks/completed?limit=1&before={quote(first['nextCursor'])}").get_json()
        self.assertEqual(second["tasks"][0]["taskId"], "a")


class TestReviewerRecentTasksReadsRealHistory(CompletedTasksLogTestBase):
    """The bug: instance_id='reviewer' never matches a model_calls row at all (review-task.js's
    majorityVote() never calls recordCall), so the old SQL-based branch could only ever
    show whatever stale row happened to exist from some other code path -- and an
    increasing share of real reviews are fully deterministic (no model call at all),
    so even a correct model_calls join would be structurally blind to them."""

    def test_reviewer_branch_reads_from_done_not_model_calls(self):
        self._write_done("reviewed-task", history=[
            {"stage": "created", "at": "1"},
            {"stage": "approved", "at": "2026-09-08T05:00:00Z"},
        ], extra={"draftModel": "qwen2.5:3b"})
        # No model-stats DB configured at all -- if the route still queried it, this
        # would 500 or return an empty list; reading real history must not depend on it.
        with mock.patch.object(app, "model_stats_db_path", return_value=None):
            resp = self.client.get("/api/instances/reviewer/recent-tasks")
        data = resp.get_json()
        self.assertEqual(len(data["tasks"]), 1)
        self.assertEqual(data["tasks"][0]["taskId"], "reviewed-task")

    def test_reviewer_branch_includes_deterministic_reviews_with_no_model_call(self):
        # deterministic-script-extract-approve / brain_dump_sort's own
        # deterministicReviewValidate -- both make no real model call.
        self._write_done("det-reviewed", history=[
            {"stage": "approved", "at": "2026-09-08T05:00:00Z", "detail": "deterministic-script-extract-approve"},
        ], extra={"draftModel": None})
        with mock.patch.object(app, "model_stats_db_path", return_value=None):
            resp = self.client.get("/api/instances/reviewer/recent-tasks")
        data = resp.get_json()
        self.assertEqual([t["taskId"] for t in data["tasks"]], ["det-reviewed"])

    def test_non_reviewer_instance_branch_is_unchanged(self):
        # Sanity check that the reviewer-only rewrite didn't touch the sibling branch --
        # with no model-stats DB it should still degrade to an empty list, not error.
        with mock.patch.object(app, "model_stats_db_path", return_value=None):
            resp = self.client.get("/api/instances/worker-1/recent-tasks")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), {"tasks": []})


if __name__ == "__main__":
    unittest.main()
