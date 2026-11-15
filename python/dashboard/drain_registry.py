"""The plugin drains registered with the pipeline's stop (2026-11-12).

A detached drain (pipeline-ops verify/nw/merger/checker/hub/scout, context-ops map/memory/impact, pf-loops pfscraper) writes ~/.local/state/agent-manager/pids/drain-<name>.pid with its
node pid (agent-manager-pipeline-ops src/trigger.js drain()). scripts/stop.sh stops them with the other daemons and src/drain-registry.js (the watchdog) stops stragglers. The dashboard
only REPORTS them: the stop route lists the ones that were running when the stop was asked for (`drains_stopped`), the status route lists the running ones (`drains`).
Standard library only; the pids folder is the one plugin_process_manager already uses.
"""
import os
import re
from pathlib import Path

_PIDFILE = re.compile(r"^drain-(.+)\.pid$")


def default_pid_dir() -> Path:
    import plugin_process_manager
    return plugin_process_manager.PID_DIR


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def running_drains(pid_dir=None) -> list:
    """[{name, pid}] for every drain-<name>.pid whose pid is alive, sorted by name. A dead pid, a garbled file and any other pidfile (plugin-*, worker-*, dashboard) are not drains."""
    folder = Path(pid_dir) if pid_dir is not None else default_pid_dir()
    out = []
    try:
        names = sorted(p.name for p in folder.iterdir())
    except OSError:
        return []
    for fname in names:
        m = _PIDFILE.match(fname)
        if not m:
            continue
        try:
            pid = int((folder / fname).read_text().strip())
        except (OSError, ValueError):
            continue
        if pid > 0 and _alive(pid):
            out.append({"name": m.group(1), "pid": pid})
    return sorted(out, key=lambda d: d["name"])
