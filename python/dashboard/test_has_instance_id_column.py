"""Regression test for app_settings_helpers._has_instance_id_column.

Pins the guard to a real boolean: True when model_calls has an instance_id column,
False when it does not. An implicit None would be read by callers as 'column absent'.

Run: .venv/bin/python -I python/dashboard/test_has_instance_id_column.py
"""
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app_settings_helpers import _has_instance_id_column  # noqa: E402


class HasInstanceIdColumnTest(unittest.TestCase):
    def test_true_when_column_present(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE model_calls (id INTEGER PRIMARY KEY, instance_id TEXT)")
        self.assertIs(_has_instance_id_column(conn), True)
        conn.close()

    def test_false_when_column_absent(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE model_calls (id INTEGER PRIMARY KEY, cost_usd REAL)")
        self.assertIs(_has_instance_id_column(conn), False)
        conn.close()


if __name__ == "__main__":
    unittest.main()
