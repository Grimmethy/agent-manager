import os
import re
import sys
from pathlib import Path
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import drain_process as dp  # noqa: E402
import plugin_process_manager as ppm  # noqa: E402


class StopDrainTests(unittest.TestCase):
    def test_mismatched_start_time_sends_no_signal(self):
        with mock.patch.object(dp.os, "kill") as kill:
            result = dp.stop_drain(100, 200, expected_start=5, process_list={100: 9})
        self.assertEqual(kill.call_count, 0)
        self.assertFalse(result["signalled"])

    def test_absent_pid_sends_no_signal(self):
        with mock.patch.object(dp.os, "kill") as kill:
            result = dp.stop_drain(100, 200, expected_start=5, process_list={})
        self.assertEqual(kill.call_count, 0)
        self.assertFalse(result["signalled"])

    def test_matching_start_time_sends_exactly_one_signal(self):
        with mock.patch.object(dp.os, "kill") as kill:
            result = dp.stop_drain(100, 200, expected_start=5, process_list={100: 5})
        self.assertEqual(kill.call_count, 1)
        self.assertEqual(kill.call_args[0][0], 100)
        self.assertTrue(result["signalled"])


class StateFileTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._patch = mock.patch.object(ppm, "PID_DIR", Path(self._tmp.name))
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def test_write_then_read_round_trip(self):
        record = {"worker": "w1", "pid": 42, "flock_pid": 43, "start_time": 1234, "status": "running"}
        dp.write_drain_state("w1", record)
        self.assertEqual(dp.read_drain_state("w1"), record)

    def test_read_missing_returns_none(self):
        self.assertIsNone(dp.read_drain_state("nope"))

    def test_invalid_status_rejected(self):
        record = {"worker": "w1", "pid": 42, "flock_pid": 43, "start_time": 1, "status": "stopped"}
        with self.assertRaises(ValueError):
            dp.write_drain_state("w1", record)

    def test_state_filename_does_not_match_pid_pattern(self):
        name = dp._state_file("w1").name
        self.assertIsNone(re.match(r"^drain-(.+)\.pid$", name))


if __name__ == "__main__":
    unittest.main()
