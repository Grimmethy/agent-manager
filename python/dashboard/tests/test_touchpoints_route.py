"""Run: .venv/bin/python -m unittest python.dashboard.tests.test_touchpoints_route"""
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from flask import Flask  # noqa: E402

from routes.touchpoints import touchpoints_bp  # noqa: E402


class TouchpointsRoute(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "r.db")
        self._old = os.environ.get("AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH")
        os.environ["AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH"] = self.db
        app = Flask(__name__)
        app.register_blueprint(touchpoints_bp)
        self.client = app.test_client()

    def tearDown(self):
        if self._old is None:
            os.environ.pop("AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH", None)
        else:
            os.environ["AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH"] = self._old
        self.tmp.cleanup()

    def _seed(self, rows):
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE requeue_causes (id INTEGER PRIMARY KEY, actor TEXT, at TEXT)")
        conn.executemany("INSERT INTO requeue_causes (actor, at) VALUES (?, ?)", rows)
        conn.commit()
        conn.close()

    def test_counts_todays_operator_manual_requeues(self):
        today = datetime.now(timezone.utc).date().isoformat()
        self._seed([("operator-manual", today + "T01:00:00+00:00"),
                    ("agent-session", today + "T02:00:00+00:00")])
        body = self.client.get("/api/stats/touchpoints-per-day").get_json()
        self.assertEqual(len(body["days"]), 14)
        self.assertEqual(body["days"][-1], {"date": today, "requeues": 1})
        self.assertTrue(body["notCountable"])

    def test_missing_db_gives_zero_filled_days(self):
        resp = self.client.get("/api/stats/touchpoints-per-day")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(sum(d["requeues"] for d in resp.get_json()["days"]), 0)

    def test_db_without_the_table_gives_zero_filled_days(self):
        sqlite3.connect(self.db).close()
        resp = self.client.get("/api/stats/touchpoints-per-day")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(sum(d["requeues"] for d in resp.get_json()["days"]), 0)


if __name__ == "__main__":
    unittest.main()
