"""What the Workers tab shows of a worker's watchdog trigger (agent-manager-pipeline-ops src/trigger.js, 2026-11-02).

The stalled-task worker and the branch verifier have no timer. The agent-manager watchdog runs their `watchdogScripts` once per tick; each script starts a detached drain
(`bin/<worker>-tick.js --drain`) when the worker's input changed. The pieces it leaves behind, all in ~/.local/state/pipeline-ops (the same names src/trigger.js `filesFor` writes):

  <name>-trigger.json   written by a drain when it ends: {sig, endedAt, backlog, stopped, iterations}
  <name>-drain.lock     held (flock) for as long as a drain runs
  <name>-trigger.beat   rewritten (an ISO time) by EVERY watchdog call of the trigger, even an idle one: how a quiet worker is told from a dead trigger

This module only READS them: no subprocess, no timer. `read_trigger` returns None when the worker has never been triggered (no state file and no drain running), so the card can say
so, and never raises.
"""
import fcntl
import json
import os
import time
from datetime import datetime, timezone


def _dir(env):
    env = os.environ if env is None else env
    return os.path.join(env.get("HOME") or os.path.expanduser("~"), ".local", "state", "pipeline-ops")


def state_path(name, env=None):
    return os.path.join(_dir(env), f"{name}-trigger.json")


def lock_path(name, env=None):
    return os.path.join(_dir(env), f"{name}-drain.lock")


def beat_path(name, env=None):
    return os.path.join(_dir(env), f"{name}-trigger.beat")


def _read_beat(name, env):
    """The time of the trigger's last call as epoch seconds, or None (no file, unreadable, not a time)."""
    try:
        with open(beat_path(name, env)) as f:
            return datetime.fromisoformat(f.read().strip().replace("Z", "+00:00")).timestamp()
    except (OSError, ValueError):
        return None


def lock_held(path):
    """True while another process holds the drain's flock. A missing or unreadable lock file means nothing is running."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        return False                      # closing the descriptor releases the lock we just took
    finally:
        os.close(fd)


def read_trigger(name, env=None, now=None, held=lock_held):
    """{state: 'draining'|'backlog'|'idle', checkedAt, checkedAgeS, endedAt, endedAgeS, stopped, iterations} or None when this worker has never been triggered."""
    now = time.time() if now is None else now
    try:
        draining = bool(held(lock_path(name, env)))
    except Exception:   # noqa: BLE001 -- the Workers tab must never fail because of this panel
        draining = False
    data = None
    try:
        with open(state_path(name, env)) as f:
            parsed = json.load(f)
        data = parsed if isinstance(parsed, dict) else None
    except (OSError, ValueError):
        data = None
    checked = _read_beat(name, env)
    if data is None and not draining and checked is None:
        return None
    data = data or {}
    ended = None
    try:
        ended = datetime.fromisoformat(str(data.get("endedAt")).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        pass
    state = "draining" if draining else ("backlog" if data.get("backlog") is True else "idle")
    return {"state": state, "checkedAt": datetime.fromtimestamp(checked, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if checked is not None else None,
            "checkedAgeS": max(0, int(now - checked)) if checked is not None else None, "endedAt": data.get("endedAt") if ended is not None else None, "endedAgeS": max(0, int(now - ended)) if ended is not None else None,
            "stopped": data.get("stopped") if isinstance(data.get("stopped"), str) else None, "iterations": data.get("iterations") if isinstance(data.get("iterations"), int) else None}
