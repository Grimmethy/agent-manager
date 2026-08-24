"""Tests for hardware_stats.get_snapshot()'s fail-open behavior -- every field must
degrade to None independently when its underlying dependency (psutil sensor support,
nvidia-smi binary, an NVIDIA GPU) is missing or errors, never raise. Mocks psutil and
subprocess.run so this runs the same on a box with no GPU/sensors as on one with both.

Run: .venv/bin/python -m unittest python.dashboard.test_hardware_stats -v
"""
import subprocess
import sys
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


if __name__ == "__main__":
    unittest.main()
