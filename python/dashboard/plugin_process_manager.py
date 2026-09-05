"""Start/stop control surface for a "slotted" dashboard plugin -- one running its own
standalone HTTP server (e.g. agent-manager-hardware-plugin,
agent-manager-hardware-goatmon-plugin), as opposed to the existing task-source
register.js plugins (which have no process of their own to manage) or the
PromptForge/AdForge/ScriptForge companions (started completely independently, never
by this dashboard).

Mirrors scripts/launch.sh's is_running()/start_bg() semantics exactly, using the SAME
~/.local/state/agent-manager/{pids,logs}/ directories launch.sh already writes to, so
existing `ps`/log-tailing habits work unchanged -- just prefixed "plugin-" to avoid
colliding with worker-1.pid/dashboard.pid/etc.

Every function here is fail-open (never raises) -- a plugin process failing to
start/stop must degrade to "didn't start"/"already gone", the same way a missing
nvidia-smi degrades hardware_stats.py's _gpu() to None rather than crashing whatever
called it.
"""
import logging
import os
import signal
import subprocess
import time
from pathlib import Path

log = logging.getLogger(__name__)

_STATE_DIR = Path(os.environ.get("HOME") or "~").expanduser() / ".local" / "state" / "agent-manager"
PID_DIR = _STATE_DIR / "pids"
LOG_DIR = _STATE_DIR / "logs"


def _pidfile(name: str) -> Path:
    return PID_DIR / f"plugin-{name}.pid"


def _logfile(name: str) -> Path:
    return LOG_DIR / f"plugin-{name}.log"


def _read_pid(name: str) -> int | None:
    try:
        return int(_pidfile(name).read_text().strip())
    except (OSError, ValueError):
        return None


def is_running(name: str) -> bool:
    """Same signal-0 liveness check as launch.sh's is_running() (`kill -0`)."""
    pid = _read_pid(name)
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def start(entry: dict) -> bool:
    """Idempotent: already running -> log + return True, matching start_bg()'s
    "already running (pid N) -- skipping" behavior. Returns False (never raises) if
    the process fails to launch at all (bad command, missing cwd, etc.)."""
    name = entry.get("name")
    if is_running(name):
        log.info("plugin '%s' already running -- skipping start", name)
        return True
    process = entry.get("process") or {}
    command, args = process.get("command"), process.get("args") or []
    cwd = process.get("cwd")
    if not command:
        log.warning("plugin '%s' has no process.command -- cannot start", name)
        return False
    try:
        PID_DIR.mkdir(parents=True, exist_ok=True)
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        # Strip Werkzeug reloader markers before they leak into the child's env.
        # This dashboard runs under Werkzeug's auto-reloader -- the actual serving
        # process (not its watcher parent) has WERKZEUG_RUN_MAIN=true and
        # WERKZEUG_SERVER_FD=<n> baked into its real environment. subprocess.Popen
        # inherits that by default, and the child plugin's own Werkzeug server then
        # tries to reuse fd <n> as an already-bound socket via socket.fromfd() --
        # meaningless in the new process (Popen's close_fds=True default has already
        # closed it), so this crashed every plugin child with "OSError: [Errno 9] Bad
        # file descriptor" before this fix. Confirmed live 2026-09-05.
        child_env = {k: v for k, v in os.environ.items()
                     if not k.startswith("WERKZEUG_")}
        with open(_logfile(name), "ab") as logfile:
            proc = subprocess.Popen(
                [command, *args],
                cwd=cwd,
                env=child_env,
                stdout=logfile,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # detach, same intent as launch.sh's `nohup ... &`
            )
        _pidfile(name).write_text(str(proc.pid))
        log.info("started plugin '%s' (pid %s), logging to %s", name, proc.pid, _logfile(name))
        return True
    except Exception:
        log.exception("failed to start plugin '%s'", name)
        return False


def stop(name: str, wait_s: float = 3.0) -> bool:
    """SIGTERM, poll for exit up to wait_s, SIGKILL if still alive. Returns True once
    the process is confirmed gone (or was never running); never raises."""
    pid = _read_pid(name)
    if pid is None:
        return True
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass  # already gone
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if not is_running(name):
            break
        time.sleep(0.1)
    if is_running(name):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        _pidfile(name).unlink(missing_ok=True)
    except OSError:
        pass
    return not is_running(name)
