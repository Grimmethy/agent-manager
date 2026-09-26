"""Tests for /api/models/usage when the model-stats db exists but cannot be queried
(change_review AC-79): an empty db file with no model_calls table, or a corrupt one, used to
raise an uncaught sqlite3 error and 500 the Models tab instead of reporting no usage.

Run: .venv/bin/python -m unittest python.dashboard.test_models_usage_route -v
"""
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class ModelsUsageUnqueryableDbTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._prev = os.environ.get("AGENT_MANAGER_MODEL_STATS_DB_PATH")
        self.db_path = Path(self._tmp.name) / "model-stats.db"
        os.environ["AGENT_MANAGER_MODEL_STATS_DB_PATH"] = str(self.db_path)
        self.client = app.app.test_client()

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("AGENT_MANAGER_MODEL_STATS_DB_PATH", None)
        else:
            os.environ["AGENT_MANAGER_MODEL_STATS_DB_PATH"] = self._prev
        self._tmp.cleanup()

    def test_db_file_without_model_calls_table_returns_empty_list(self):
        sqlite3.connect(self.db_path).close()  # a valid, empty sqlite file: is_file() true, no table
        resp = self.client.get("/api/models/usage")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), [])

    def test_corrupt_zeroed_db_file_returns_empty_list(self):
        self.db_path.write_bytes(b"\x00" * 16)
        resp = self.client.get("/api/models/usage")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), [])

    def test_real_rows_are_still_reported(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE model_calls (model TEXT, stage TEXT, latency_ms REAL, started_at TEXT)")
        conn.execute("INSERT INTO model_calls VALUES ('m1', 'implement', 100, '2026-09-25T00:00:00Z')")
        conn.commit()
        conn.close()
        resp = self.client.get("/api/models/usage")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), [{"model": "m1", "stage": "implement", "callCount": 1, "avgLatencyMs": 100.0, "lastUsedAt": "2026-09-25T00:00:00Z"}])


if __name__ == "__main__":
    unittest.main()
