"""Host-memory state for the dashboard header chip (phase 5 of the memory-pressure plan, 2026-11-02).

The gpu-broker classifies host memory (ok | tight | critical) from kernel pressure-stall information and writes it to a small file in /dev/shm on every
pressure event and at least every 300 s. /api/summary already runs on the page's refresh cycle, so reading that file there costs one tiny read and adds NO
timer and NO request to the broker while memory is ok. Only when the state is tight or critical is the broker asked, once per summary call, for the pause
details (`GET /api/gpu/status` -> memory.relief: whether new work is paused, since when, and whether the owner-only Ollama unload is enabled).

Event, not poll (ADR-0024): the file is rewritten by the broker on the kernel's pressure events; the event that would remove even the per-refresh read is a
push from the broker. Fails soft everywhere: a missing, stale or malformed marker reads as 'unknown' (no chip), an unreachable broker just omits the pause details.
"""
import json
import os
import time
import urllib.error
import urllib.request

DEFAULT_MARKER = "/dev/shm/agent-manager-mem-pressure.json"
DEFAULT_MAX_AGE_S = 330          # the broker's 300 s reconcile plus slack, same limit the lanes use (scripts/agent-manager-common.sh)
BROKER_TIMEOUT_S = 1.5
STATES = ("ok", "tight", "critical")


def marker_path():
    return os.environ.get("AGENT_MANAGER_MEM_PRESSURE_MARKER", DEFAULT_MARKER)


def max_age_s():
    try:
        v = int(os.environ.get("AGENT_MANAGER_MEM_MARKER_MAX_AGE_S", DEFAULT_MAX_AGE_S))
        return v if v >= 0 else DEFAULT_MAX_AGE_S
    except ValueError:
        return DEFAULT_MAX_AGE_S


def broker_url():
    return os.environ.get("GPU_BROKER_URL", "http://127.0.0.1:7449").rstrip("/")


def _read_marker(path):
    try:
        mtime = os.stat(path).st_mtime
        with open(path) as f:
            data = json.load(f)
        return (data if isinstance(data, dict) else None), mtime
    except (OSError, ValueError):
        return None, None


def _broker_relief():
    """memory.relief from the broker's status, or None when the broker does not answer."""
    try:
        with urllib.request.urlopen(f"{broker_url()}/api/gpu/status", timeout=BROKER_TIMEOUT_S) as r:
            body = json.load(r)
        relief = (body.get("memory") or {}).get("relief")
        return relief if isinstance(relief, dict) else None
    except (OSError, ValueError, urllib.error.URLError):
        return None


def memory_status(now=None, read=_read_marker, broker_relief=_broker_relief):
    """-> {"state": "ok"|"unknown"} or, for tight/critical, {state, reason, numbers, ageS, paused, wouldPause, pauseS, canUnload}. Never raises."""
    try:
        now = time.time() if now is None else now
        data, mtime = read(marker_path())
        if not data or mtime is None:
            return {"state": "unknown"}
        age = now - mtime
        state = data.get("state")
        if state not in STATES or age < 0 or age > max_age_s():
            return {"state": "unknown"}
        if state == "ok":
            return {"state": "ok"}
        out = {"state": state, "reason": str(data.get("reason") or ""), "numbers": data.get("numbers") if isinstance(data.get("numbers"), dict) else {},
               "ageS": int(age), "paused": False, "wouldPause": False, "pauseS": None, "canUnload": False}
        relief = broker_relief()
        if relief:
            out["paused"] = bool(relief.get("paused"))
            out["wouldPause"] = bool(relief.get("would_pause"))
            since = relief.get("since")
            if (out["paused"] or out["wouldPause"]) and isinstance(since, (int, float)) and since > 0:
                out["pauseS"] = max(0, int(now - since))
            out["canUnload"] = relief.get("ollama_unload") == "owner"
        return out
    except Exception:   # noqa: BLE001 -- the page's refresh must never fail because of the memory chip
        return {"state": "unknown"}


def unload_ollama(who="dashboard", post=None):
    """Owner action: ask the broker to unload the Ollama models. -> (http status, body). The broker decides (403 unless it was started with
    AGENT_MANAGER_MEM_RELIEF_OLLAMA=owner); a broker without the route answers 404, which the page treats as 'hide the button'."""
    url = f"{broker_url()}/api/gpu/memory/unload-ollama"
    data = json.dumps({"who": who}).encode()
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"}, method="POST")
    try:
        with (post or urllib.request.urlopen)(req, timeout=10) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
        except ValueError:
            body = {"error": f"broker answered HTTP {e.code}"}
        return e.code, body
    except (OSError, ValueError, urllib.error.URLError) as e:
        return 502, {"error": f"broker not reachable: {e}"}
