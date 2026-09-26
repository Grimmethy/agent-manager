"""Tests for app.read_job_type_counters when job-type-counters.json holds valid JSON that
is not an object (change_review AC-62): a list or scalar used to flow straight into
/api/job-types (`counters.get(...)`) and /api/job-types/reset (`counters[name] = 0`) and
500 both routes.

Run: .venv/bin/python -m unittest python.dashboard.test_read_job_type_counters -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class ReadJobTypeCountersTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._prev = os.environ.get("AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH")
        self.path = Path(self._tmp.name) / "job-type-counters.json"
        os.environ["AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH"] = str(self.path)

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH", None)
        else:
            os.environ["AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH"] = self._prev
        self._tmp.cleanup()

    def test_a_json_list_yields_an_empty_dict(self):
        self.path.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
        self.assertEqual(app.read_job_type_counters(), {})

    def test_a_bare_json_string_yields_an_empty_dict(self):
        self.path.write_text('"hello"', encoding="utf-8")
        self.assertEqual(app.read_job_type_counters(), {})

    def test_a_valid_object_is_returned_unchanged(self):
        data = {"trouble_log": 5, "arch_review": 2}
        self.path.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(app.read_job_type_counters(), data)

    def test_job_types_route_survives_a_list_valued_counters_file(self):
        self.path.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
        resp = app.app.test_client().get("/api/job-types")
        self.assertEqual(resp.status_code, 200)


if __name__ == "__main__":
    unittest.main()
