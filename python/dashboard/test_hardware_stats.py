"""Tests for hardware_stats.get_snapshot()'s fail-open behavior -- every field must
degrade to None independently when its underlying dependency (psutil sensor support,
nvidia-smi binary, an NVIDIA GPU) is missing or errors, never raise. Mocks psutil and
subprocess.run so this runs the same on a box with no GPU/sensors as on one with both.

Run: .venv/bin/python -m unittest python.dashboard.test_hardware_stats -v
"""
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import hardware_stats  # noqa: E402


class GetSnapshotTest(unittest.TestCase):
    def _run_snapshot(self):
        with mock.patch.object(hardware_stats.psutil, "cpu_percent", return_value=12.5), \
             mock.patch.object(
                 hardware_stats.psutil,
                 "virtual_memory",
                 return_value=mock.Mock(used=100, total=200),
             ), \
             mock.patch.object(
                 hardware_stats.psutil,
                 "disk_usage",
                 return_value=mock.Mock(used=300, total=400),
             ), \
             mock.patch.object(
                 hardware_stats.psutil,
                 "sensors_temperatures",
                 return_value={"coretemp": [mock.Mock(current=55.0)]},
                 create=True,
             ), \
             mock.patch.object(
                 hardware_stats.subprocess,
                 "run",
                 return_value=mock.Mock(stdout="30, 1000, 8000, 65\n"),
             ):
            return hardware_stats.get_snapshot()

    def test_happy_path_all_fields_present(self):
        snapshot = self._run_snapshot()
        self.assertEqual(snapshot["cpuPercent"], 12.5)
        self.assertEqual(snapshot["cpuTemperatureCelsius"], 55.0)
        self.assertEqual(snapshot["ram"], {"usedBytes": 100, "totalBytes": 200})
        self.assertEqual(snapshot["disk"], {"usedBytes": 300, "totalBytes": 400})
        self.assertEqual(
            snapshot["gpu"],
            {
                "utilizationPercent": 30.0,
                "vramUsedMiB": 1000.0,
                "vramTotalMiB": 8000.0,
                "temperatureCelsius": 65.0,
            },
        )

    def test_cpu_percent_error_degrades_to_none(self):
        with mock.patch.object(
            hardware_stats.psutil, "cpu_percent", side_effect=RuntimeError("boom")
        ):
            self.assertIsNone(hardware_stats._cpu_percent())

    def test_ram_error_degrades_to_none(self):
        with mock.patch.object(
            hardware_stats.psutil, "virtual_memory", side_effect=RuntimeError("boom")
        ):
            self.assertIsNone(hardware_stats._ram())

    def test_disk_error_degrades_to_none(self):
        with mock.patch.object(
            hardware_stats.psutil, "disk_usage", side_effect=OSError("boom")
        ):
            self.assertIsNone(hardware_stats._disk())

    def test_no_sensor_support_degrades_to_none(self):
        with mock.patch.object(
            hardware_stats.psutil,
            "sensors_temperatures",
            side_effect=AttributeError("no attr"),
            create=True,
        ):
            self.assertIsNone(hardware_stats._cpu_temperature_celsius())

    def test_empty_sensors_degrades_to_none(self):
        with mock.patch.object(
            hardware_stats.psutil, "sensors_temperatures", return_value={}, create=True
        ):
            self.assertIsNone(hardware_stats._cpu_temperature_celsius())

    def test_unrecognized_sensor_label_falls_back_to_first_available(self):
        with mock.patch.object(
            hardware_stats.psutil,
            "sensors_temperatures",
            return_value={"some_weird_chip": [mock.Mock(current=42.0)]},
            create=True,
        ):
            self.assertEqual(hardware_stats._cpu_temperature_celsius(), 42.0)

    def test_no_nvidia_smi_binary_degrades_to_none(self):
        with mock.patch.object(
            hardware_stats.subprocess,
            "run",
            side_effect=FileNotFoundError("nvidia-smi not found"),
        ):
            self.assertIsNone(hardware_stats._gpu())

    def test_nvidia_smi_nonzero_exit_degrades_to_none(self):
        with mock.patch.object(
            hardware_stats.subprocess,
            "run",
            side_effect=subprocess.CalledProcessError(1, "nvidia-smi"),
        ):
            self.assertIsNone(hardware_stats._gpu())

    def test_nvidia_smi_timeout_degrades_to_none(self):
        with mock.patch.object(
            hardware_stats.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired("nvidia-smi", 5),
        ):
            self.assertIsNone(hardware_stats._gpu())

    def test_gpu_none_still_yields_full_snapshot_with_null_gpu(self):
        with mock.patch.object(hardware_stats.psutil, "cpu_percent", return_value=1.0), \
             mock.patch.object(
                 hardware_stats.psutil,
                 "virtual_memory",
                 return_value=mock.Mock(used=1, total=2),
             ), \
             mock.patch.object(
                 hardware_stats.psutil,
                 "disk_usage",
                 return_value=mock.Mock(used=1, total=2),
             ), \
             mock.patch.object(
                 hardware_stats.psutil,
                 "sensors_temperatures",
                 side_effect=AttributeError("no attr"),
                 create=True,
             ), \
             mock.patch.object(
                 hardware_stats.subprocess,
                 "run",
                 side_effect=FileNotFoundError("nvidia-smi not found"),
             ):
            snapshot = hardware_stats.get_snapshot()
        self.assertIsNone(snapshot["gpu"])
        self.assertIsNone(snapshot["cpuTemperatureCelsius"])
        self.assertIsNotNone(snapshot["cpuPercent"])
        self.assertIsNotNone(snapshot["ram"])
        self.assertIsNotNone(snapshot["disk"])


class HistoryTest(unittest.TestCase):
    """record_sample()/get_history() against a throwaway DB file so these never touch a
    real hardware-stats.db, and never depend on real psutil/nvidia-smi output."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self._db_path = Path(self._tmpdir.name) / "hardware-stats.db"
        self._env_patch = mock.patch.dict(
            hardware_stats.os.environ,
            {"AGENT_MANAGER_HARDWARE_STATS_DB_PATH": str(self._db_path)},
        )
        self._env_patch.start()

    def tearDown(self):
        self._env_patch.stop()
        self._tmpdir.cleanup()

    def _mock_snapshot(self):
        return mock.patch.object(
            hardware_stats,
            "get_snapshot",
            return_value={
                "cpuPercent": 10.0,
                "cpuTemperatureCelsius": 40.0,
                "ram": {"usedBytes": 1, "totalBytes": 2},
                "disk": {"usedBytes": 3, "totalBytes": 4},
                "gpu": {
                    "utilizationPercent": 5.0,
                    "vramUsedMiB": 6.0,
                    "vramTotalMiB": 7.0,
                    "temperatureCelsius": 8.0,
                },
            },
        )

    def test_record_then_get_history_round_trips(self):
        with self._mock_snapshot():
            hardware_stats.record_sample()
        history = hardware_stats.get_history()
        self.assertEqual(len(history), 1)
        entry = history[0]
        self.assertEqual(entry["cpuPercent"], 10.0)
        self.assertEqual(entry["ram"], {"usedBytes": 1, "totalBytes": 2})
        self.assertEqual(entry["gpu"]["vramUsedMiB"], 6.0)
        self.assertIn("sampledAt", entry)

    def test_get_history_empty_when_no_samples_yet(self):
        self.assertEqual(hardware_stats.get_history(), [])

    def test_get_history_prunes_samples_outside_the_window(self):
        with self._mock_snapshot():
            hardware_stats.record_sample()
        stale_cutoff = "2000-01-01T00:00:00+00:00"
        conn = hardware_stats._connect()
        conn.execute("UPDATE hardware_samples SET sampled_at = ?", (stale_cutoff,))
        conn.commit()
        conn.close()
        self.assertEqual(hardware_stats.get_history(hours=24), [])

    def test_get_snapshot_with_history_combines_both(self):
        with self._mock_snapshot():
            hardware_stats.record_sample()
            combined = hardware_stats.get_snapshot_with_history()
        self.assertEqual(combined["current"]["cpuPercent"], 10.0)
        self.assertEqual(len(combined["history"]), 1)

    def test_record_sample_swallows_db_errors(self):
        with self._mock_snapshot(), mock.patch.object(
            hardware_stats, "_connect", side_effect=sqlite3.OperationalError("locked")
        ):
            hardware_stats.record_sample()  # must not raise

    def test_get_history_swallows_db_errors(self):
        with mock.patch.object(
            hardware_stats, "_connect", side_effect=sqlite3.OperationalError("locked")
        ):
            self.assertEqual(hardware_stats.get_history(), [])


if __name__ == "__main__":
    unittest.main()
