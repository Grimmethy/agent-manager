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
    """Only worker lanes (worker-<letters or digits>) have a switch; reviewers and the watchdog do not."""
    return isinstance(instance_id, str) and bool(WORKER_ID_RE.match(instance_id))


def _run(*args):
    return subprocess.run(["node", str(SWITCH_JS), *args], capture_output=True, text=True, timeout=TIMEOUT_S, env=os.environ.copy())


def disabled_workers() -> set:
    """The ids currently switched off. Fails open (an empty set) when node or the directory cannot be read: a broken switch must never hide the Workers tab."""
    try:
        r = _run("list")
        if r.returncode != 0:
            return set()
        import json
        return {i for i in json.loads(r.stdout) if is_switchable(i)}
    except (OSError, subprocess.SubprocessError, ValueError):
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
