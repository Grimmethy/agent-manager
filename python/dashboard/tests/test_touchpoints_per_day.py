"""Run: .venv/bin/python -m unittest python.dashboard.tests.test_touchpoints_per_day"""
import unittest
from datetime import datetime, timezone

from python.dashboard.touchpoints_per_day import touchpoints_per_day

NOW = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)


class TouchpointsPerDay(unittest.TestCase):
    def test_counts_only_operator_manual_and_zero_fills(self):
        rows = [
            ("operator-manual", "2026-11-09T01:00:00+00:00"),
            ("operator-manual", "2026-11-09T05:00:00+00:00"),
            ("operator-manual", "2026-11-07T05:00:00+00:00"),
            ("agent-session", "2026-11-09T06:00:00+00:00"),
            ("pipeline-mechanism", "2026-11-08T06:00:00+00:00"),
            (None, "2026-11-08T07:00:00+00:00"),
        ]
        out = touchpoints_per_day(rows, days=3, now=NOW)
        self.assertEqual(out["days"], [
            {"date": "2026-11-07", "requeues": 1},
            {"date": "2026-11-08", "requeues": 0},
            {"date": "2026-11-09", "requeues": 2},
        ])

    def test_rows_outside_window_and_bad_dates_ignored(self):
        rows = [("operator-manual", "2026-10-01T00:00:00"), ("operator-manual", None)]
        out = touchpoints_per_day(rows, days=2, now=NOW)
        self.assertEqual([d["requeues"] for d in out["days"]], [0, 0])

    def test_not_countable_lists_blocking_gaps(self):
        out = touchpoints_per_day([], days=1, now=NOW)
        self.assertTrue(all(n["gap"].startswith("gap ") for n in out["notCountable"]))
        self.assertEqual(len(out["days"]), 1)


if __name__ == "__main__":
    unittest.main()
