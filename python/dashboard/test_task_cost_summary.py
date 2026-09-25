"""Tests for app._task_cost_summary's handling of a corrupt/zeroed model-stats db file
(AC-61, 2026-09-25): model_stats_db_path().is_file() only confirms the path exists --
SQLite doesn't validate the header until first real access, so a zeroed-out or otherwise
corrupt file passes that check and then raises sqlite3.DatabaseError on the first real
query, uncaught, turning api_task_detail/api_task_anywhere into a 500 for any task whose
detail view is opened while the db is in that state.

Run: .venv/bin/python -m unittest python.dashboard.test_task_cost_summary -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TaskCostSummaryCorruptDbTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._prev = os.environ.get("AGENT_MANAGER_MODEL_STATS_DB_PATH")

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("AGENT_MANAGER_MODEL_STATS_DB_PATH", None)
        else:
            os.environ["AGENT_MANAGER_MODEL_STATS_DB_PATH"] = self._prev
        self._tmp.cleanup()

    # Test A (fails on the pre-fix code, passes after): the exact failure scenario named
    # in the task -- a 16-byte zeroed file at the db path. Before the fix, the uncaught
    # sqlite3.DatabaseError from _has_cost_usd_column's query propagates straight out of
    # _task_cost_summary; after the fix, it's caught and this returns None (the function's
    # own "no cost data available" contract), never raising.
    def test_a_corrupt_zeroed_db_file_returns_none_instead_of_raising(self):
        db_path = Path(self._tmp.name) / "model-stats.db"
        db_path.write_bytes(b"\x00" * 16)  # passes is_file(), fails SQLite's header check
        os.environ["AGENT_MANAGER_MODEL_STATS_DB_PATH"] = str(db_path)

        result = app._task_cost_summary("some-task-id")
        self.assertIsNone(result)

    # Test B (must still pass after the fix): a missing db file is the pre-existing
    # "no data yet" path this fix must not change.
    def test_b_missing_db_file_still_returns_none_as_before(self):
        os.environ["AGENT_MANAGER_MODEL_STATS_DB_PATH"] = str(Path(self._tmp.name) / "does-not-exist.db")
        result = app._task_cost_summary("some-task-id")
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
