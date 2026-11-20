"""Pure helpers for a detached drain process: per-worker JSON state file and a pid-checked stop.

stop_drain() only signals the pid when its live kernel start time still equals the start time
recorded when the drain was launched, so a recycled pid is never signalled. Stdlib only.
"""
import json
import os
import signal
import tempfile
from pathlib import Path

import plugin_process_manager as ppm

VALID_STATUSES = ("running", "restarting")
REQUIRED_FIELDS = ("worker", "pid", "flock_pid", "start_time", "status")


def _state_file(worker: str) -> Path:
    # Ends in .json, so it never matches drain_registry's ^drain-(.+)\.pid$ pattern.
    return ppm.PID_DIR / f"drain-{worker}.json"


def read_drain_state(worker: str) -> dict | None:
    """Return the saved state record for a worker, or None when no state file exists."""
    try:
        return json.loads(_state_file(worker).read_text())
    except FileNotFoundError:
        return None


def write_drain_state(worker: str, record: dict) -> None:
    """Validate and atomically write the state record for a worker."""
    for field in REQUIRED_FIELDS:
        if field not in record:
            raise ValueError(f"drain state missing field: {field}")
    if record["status"] not in VALID_STATUSES:
        raise ValueError(f"invalid drain status: {record['status']!r}")
    path = _state_file(worker)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".drain-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(record, fh)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def process_start_time(pid: int) -> int | None:
    """Kernel start time (clock ticks since boot, /proc/<pid>/stat field 22), or None if the pid is gone."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        # Split after the last ')' so a command name containing spaces or ')' cannot shift fields.
        # Remaining fields start at field 3 (state), so starttime (field 22) is index 19.
        return int(raw.rsplit(")", 1)[1].split()[19])
    except (OSError, IndexError, ValueError):
        return None


def stop_drain(pid: int, flock_pid: int, expected_start: int, process_list=None) -> dict:
    """Send SIGTERM to pid only if its live start time equals expected_start.

    process_list, when given, is a mapping {pid: start_time} used instead of /proc (for tests).
    flock_pid is recorded by the caller and is not signalled here. Never raises; returns
    {"pid": pid, "signalled": bool}.
    """
    if process_list is not None:
        live = process_list.get(pid)
    else:
        live = process_start_time(pid)
    if live is None or live != expected_start:
        return {"pid": pid, "signalled": False}
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return {"pid": pid, "signalled": False}
    return {"pid": pid, "signalled": True}
