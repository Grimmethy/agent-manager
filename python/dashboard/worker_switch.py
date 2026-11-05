"""Operator on/off switch for worker lanes, as seen by the dashboard. A thin wrapper over src/worker-switch.js (the marker-file rule lives there, once:
the bash worker and this module both shell out to it). See docs/agents/lanes.md "Switching a worker off"."""
import os
import re
import subprocess
from pathlib import Path

SWITCH_JS = Path(__file__).resolve().parent.parent.parent / "src" / "worker-switch.js"
TIMEOUT_S = 10
WORKER_ID_RE = re.compile(r"^worker-[a-z0-9]+$")


def is_switchable(instance_id) -> bool:
    """Only worker lanes (worker-<letters or digits>) have a switch; reviewers and the watchdog do not. fullmatch: the same rule as the node check (no trailing newline slips through)."""
    return isinstance(instance_id, str) and bool(WORKER_ID_RE.fullmatch(instance_id))


def switch_dir() -> str:
    """The marker directory, by the same rule as src/worker-switch.js switchDir(): AGENT_MANAGER_DISABLED_WORKERS_DIR, else $HOME/.local/state/agent-manager/disabled-workers."""
    override = str(os.environ.get("AGENT_MANAGER_DISABLED_WORKERS_DIR") or "").strip()
    if override:
        return override
    home = os.path.expanduser("~")          # $HOME first, then the password database: the same order node's env.HOME || os.homedir() uses
    return os.path.join(home, ".local", "state", "agent-manager", "disabled-workers")


def _run(*args):
    return subprocess.run(["node", str(SWITCH_JS), *args], capture_output=True, text=True, timeout=TIMEOUT_S, env=os.environ.copy())


def disabled_workers() -> set:
    """The ids currently switched off. READ-ONLY and in-process: one directory listing, no `node` start (the Workers tab asks on every redraw, and a node start took seconds when the
    shared disk was busy: /api/instances measured 9 to 15 s on 2026-11-04). The marker-file RULE still lives once, in src/worker-switch.js (it also decides is-disabled for the bash worker and
    does every WRITE); this is only its `list` command, with a parity test. Fails open (an empty set) when the directory cannot be read: a broken switch must never hide the Workers tab."""
    try:
        return {name for name in os.listdir(switch_dir()) if is_switchable(name)}
    except OSError:
        return set()


def set_worker_enabled(instance_id: str, enabled: bool):
    """Switch a worker on (enabled True) or off. Returns (ok, error message or '')."""
    if not is_switchable(instance_id):
        return False, f"'{instance_id}' is not a worker lane that can be switched"
    try:
        r = _run("enable" if enabled else "disable", instance_id)
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"could not run the worker switch: {exc}"
    if r.returncode != 0:
        return False, (r.stderr or "the worker switch failed").strip()[:200]
    return True, ""
