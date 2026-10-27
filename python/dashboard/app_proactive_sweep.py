"""Start-up helpers for the proactive file-decompose sweep, shared with scripts/queue-watcher.sh.

Why this exists (2026-10-17, measured live): the sweep is 15+ minutes of local-model calls per run. The watchdog used to run it inline (holding every other tick-bound sweep behind it)
and this dashboard started a second `--force` copy on project select, so two copies ran at once. Both callers now take the SAME exclusive lock (flock -n on the lock file below), so a
second start exits at once instead of duplicating the work. scripts/lib/start-singleton-bg.sh is the shell side of the same contract.
"""
import os
import shutil
from pathlib import Path

LOCK_NAME = "proactive-file-decompose.lock"


def proactive_sweep_lock_path() -> Path:
    """The shared lock file, next to the pidfiles launch.sh and queue-watcher.sh use (~/.local/state/agent-manager/pids). Creates the directory."""
    pid_dir = Path(os.environ.get("HOME") or "~").expanduser() / ".local" / "state" / "agent-manager" / "pids"
    pid_dir.mkdir(parents=True, exist_ok=True)
    return pid_dir / LOCK_NAME


def proactive_sweep_argv(sweep_path, lock_path) -> list:
    """argv for the on-demand `--force` start. Prefixed with `flock -n <lock>` where flock exists (so a copy already running makes this a no-op); plain node on Windows or without flock."""
    base = ["node", str(sweep_path), "--force"]
    if os.name != "nt" and shutil.which("flock"):
        return ["flock", "-n", str(lock_path), *base]
    return base
