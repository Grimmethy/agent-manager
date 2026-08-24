"""Best-effort, point-in-time hardware snapshot -- CPU/RAM/disk via psutil, GPU via
nvidia-smi. Same fail-open philosophy as src/gpu-vram.js's queryVram(): any missing
dependency (no psutil sensor support, no NVIDIA GPU, no nvidia-smi binary) degrades the
one field it affects to None rather than raising, so a caller can always render whatever
did succeed. Standalone and not wired into app.py or any scheduler -- that's separate
follow-up work.

Run: .venv/bin/python -m unittest python.dashboard.test_hardware_stats -v
"""
import subprocess
from pathlib import Path

import psutil

GPU_QUERY_TIMEOUT_SECONDS = 5


def _cpu_percent() -> float | None:
    try:
        return psutil.cpu_percent(interval=0.1)
    except Exception:
        return None


def _ram() -> dict | None:
    try:
        vm = psutil.virtual_memory()
        return {"usedBytes": vm.used, "totalBytes": vm.total}
    except Exception:
        return None


def _disk() -> dict | None:
    try:
        usage = psutil.disk_usage(str(Path(__file__).resolve().parent))
        return {"usedBytes": usage.used, "totalBytes": usage.total}
    except Exception:
        return None


def _cpu_temperature_celsius() -> float | None:
    try:
        sensors = psutil.sensors_temperatures()
    except Exception:
        return None
    if not sensors:
        return None
    for label in ("coretemp", "k10temp", "cpu_thermal", "zenpower"):
        entries = sensors.get(label)
        if entries:
            return entries[0].current
    for entries in sensors.values():
        if entries:
            return entries[0].current
    return None


def _gpu() -> dict | None:
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=GPU_QUERY_TIMEOUT_SECONDS,
            check=True,
        )
        line = out.stdout.strip().splitlines()[0]
        util_str, used_str, total_str, temp_str = (p.strip() for p in line.split(","))
        return {
            "utilizationPercent": float(util_str),
            "vramUsedMiB": float(used_str),
            "vramTotalMiB": float(total_str),
            "temperatureCelsius": float(temp_str),
        }
    except Exception:
        return None


def get_snapshot() -> dict:
    """One point-in-time hardware snapshot. Every field is independently optional --
    a missing sensor, missing GPU, or missing nvidia-smi binary degrades only that
    field to None, it never raises."""
    return {
        "cpuPercent": _cpu_percent(),
        "cpuTemperatureCelsius": _cpu_temperature_celsius(),
        "ram": _ram(),
        "disk": _disk(),
        "gpu": _gpu(),
    }
