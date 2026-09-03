"""Best-effort, point-in-time hardware snapshot -- CPU/RAM/disk via psutil, GPU via
nvidia-smi -- plus a rolling history of those snapshots in a small local SQLite table,
so current-vs-average comparisons and time graphs are possible later. Same fail-open
philosophy as src/gpu-vram.js's queryVram(): any missing dependency (no psutil sensor
support, no NVIDIA GPU, no nvidia-smi binary) degrades the one field it affects to None
rather than raising, so a caller can always render whatever did succeed -- recording a
sample follows the same rule: a DB write failure is swallowed, never raised, same
"stats tracking must never break the real feature" contract as model-stats-client.js.

The history table is plain stdlib sqlite3, not src/model-stats-db.js's node:sqlite --
that module shells out to Node because its schema is shared with the Node pipeline
(model-stats.db is written from both JS and this wrapper); this table has no Node
writer to share with, and app.py already uses Python's built-in sqlite3 module to read
model-stats.db read-only, so there's no noexec-mount concern (see model-stats-db.js's
own header) that would push this toward node:sqlite too.

Still standalone and not wired into app.py's request-serving thread -- start_sampler()
exists for a future caller (e.g. a startup hook in app.py) to opt into background
sampling; nothing currently calls it.

Run: .venv/bin/python -m unittest python.dashboard.test_hardware_stats -v
"""
import logging
import os
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psutil

log = logging.getLogger(__name__)

GPU_QUERY_TIMEOUT_SECONDS = 5
DEFAULT_SAMPLE_INTERVAL_SECONDS = 60
DEFAULT_RETENTION_HOURS = 24


def _cpu_percent() -> float | None:
    try:
        return psutil.cpu_percent(interval=0.1)
    except Exception as exc:
        log.warning("cpu_percent sampling failed: %s: %s", type(exc).__name__, exc)
        return None


def _ram() -> dict | None:
    try:
        vm = psutil.virtual_memory()
        return {"usedBytes": vm.used, "totalBytes": vm.total}
    except Exception:
        log.warning("Failed to read virtual memory stats via psutil", exc_info=True)
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
        log.debug("sensor read (CPU temperature) failed; returning None", exc_info=True)
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


def _db_path() -> Path:
    override = os.environ.get("AGENT_MANAGER_HARDWARE_STATS_DB_PATH")
    if override:
        return Path(override)
    pipeline_dir = os.environ.get("AGENT_MANAGER_PIPELINE_DIR") or os.environ.get(
        "AGENT_MANAGER_REPO_ROOT"
    )
    base = Path(pipeline_dir) if pipeline_dir else Path(__file__).resolve().parent
    return base / "hardware-stats.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()))
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS hardware_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sampled_at TEXT NOT NULL,
            cpu_percent REAL,
            cpu_temperature_celsius REAL,
            ram_used_bytes INTEGER,
            ram_total_bytes INTEGER,
            disk_used_bytes INTEGER,
            disk_total_bytes INTEGER,
            gpu_utilization_percent REAL,
            gpu_vram_used_mib REAL,
            gpu_vram_total_mib REAL,
            gpu_temperature_celsius REAL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_hardware_samples_sampled_at "
        "ON hardware_samples(sampled_at)"
    )
    return conn


def _row_to_history_entry(row) -> dict:
    (
        sampled_at, cpu_percent, cpu_temp, ram_used, ram_total, disk_used, disk_total,
        gpu_util, gpu_vram_used, gpu_vram_total, gpu_temp,
    ) = row
    ram = {"usedBytes": ram_used, "totalBytes": ram_total} if ram_used is not None else None
    disk = {"usedBytes": disk_used, "totalBytes": disk_total} if disk_used is not None else None
    gpu = None
    if gpu_util is not None:
        gpu = {
            "utilizationPercent": gpu_util,
            "vramUsedMiB": gpu_vram_used,
            "vramTotalMiB": gpu_vram_total,
            "temperatureCelsius": gpu_temp,
        }
    return {
        "sampledAt": sampled_at,
        "cpuPercent": cpu_percent,
        "cpuTemperatureCelsius": cpu_temp,
        "ram": ram,
        "disk": disk,
        "gpu": gpu,
    }


def record_sample(retention_hours: float = DEFAULT_RETENTION_HOURS) -> None:
    """Take one snapshot and persist it, pruning anything older than retention_hours.
    Best-effort like every other write in this module: a DB error (locked file, missing
    directory, disk full) is swallowed, never raised -- recording history must never be
    able to break whatever feature ends up calling this on a timer."""
    snapshot = get_snapshot()
    ram = snapshot["ram"] or {}
    disk = snapshot["disk"] or {}
    gpu = snapshot["gpu"] or {}
    sampled_at = datetime.now(timezone.utc).isoformat()
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=retention_hours)).isoformat()
    try:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO hardware_samples (
                    sampled_at, cpu_percent, cpu_temperature_celsius,
                    ram_used_bytes, ram_total_bytes, disk_used_bytes, disk_total_bytes,
                    gpu_utilization_percent, gpu_vram_used_mib, gpu_vram_total_mib,
                    gpu_temperature_celsius
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    sampled_at,
                    snapshot["cpuPercent"],
                    snapshot["cpuTemperatureCelsius"],
                    ram.get("usedBytes"),
                    ram.get("totalBytes"),
                    disk.get("usedBytes"),
                    disk.get("totalBytes"),
                    gpu.get("utilizationPercent"),
                    gpu.get("vramUsedMiB"),
                    gpu.get("vramTotalMiB"),
                    gpu.get("temperatureCelsius"),
                ),
            )
            conn.execute("DELETE FROM hardware_samples WHERE sampled_at < ?", (cutoff,))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        log.warning(
            "Failed to persist hardware stats (sampled_at=%s)",
            sampled_at,
            exc_info=True,
        )


def get_history(hours: float = DEFAULT_RETENTION_HOURS) -> list:
    """Rolling history, oldest first. Empty list (never raises) if the DB doesn't exist
    yet or can't be read -- same fail-open contract as get_snapshot()'s fields."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    try:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT sampled_at, cpu_percent, cpu_temperature_celsius,
                       ram_used_bytes, ram_total_bytes, disk_used_bytes, disk_total_bytes,
                       gpu_utilization_percent, gpu_vram_used_mib, gpu_vram_total_mib,
                       gpu_temperature_celsius
                FROM hardware_samples
                WHERE sampled_at >= ?
                ORDER BY sampled_at ASC
                """,
                (cutoff,),
            ).fetchall()
        finally:
            conn.close()
    except Exception:
        return []
    return [_row_to_history_entry(row) for row in rows]


def get_snapshot_with_history(hours: float = DEFAULT_RETENTION_HOURS) -> dict:
    """Plain dict combining a fresh point-in-time snapshot with the persisted rolling
    history, for a caller (e.g. a future dashboard endpoint) that wants both a current
    reading and enough recent samples to plot a trend or compare current-vs-average."""
    return {"current": get_snapshot(), "history": get_history(hours=hours)}


def start_sampler(
    interval_seconds: float = DEFAULT_SAMPLE_INTERVAL_SECONDS,
    retention_hours: float = DEFAULT_RETENTION_HOURS,
) -> threading.Thread:
    """Start a daemon thread that calls record_sample() on a fixed interval. Not called
    anywhere yet (see module docstring) -- exposed for a future caller, same
    daemon=True fire-and-forget shape as app.py's _chat_reservation_watchdog."""

    def _loop():
        while True:
            try:
                record_sample(retention_hours=retention_hours)
            except Exception:
                log.exception(
                    "hardware_stats sampler tick failed "
                    "(interval=%.1fs, retention=%.1fh)",
                    interval_seconds,
                    retention_hours,
                )
            time.sleep(interval_seconds)

    thread = threading.Thread(target=_loop, daemon=True)
    thread.start()
    return thread
