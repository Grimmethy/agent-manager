"""Coalesces the Unmerged Branches tab's `kick=1` requests (found 2026-11-07 in the CPU analysis: ~6 kicks a minute, each one invalidating the active project's list with a fetch
AND expiring every other project's list, so the dashboard recomputed all 47 projects back to back: ~7 git processes a second, a fifth of a core, plus a `git fetch` per repo).

The page sends a kick whenever a counts or branches event arrives. A kick means "something that feeds the list happened"; the work it starts is the same however many arrive close
together. So at most one kick is HONOURED per window (AGENT_MANAGER_BRANCH_KICK_MIN_SECONDS, default 60; 0 turns the throttle off (every kick is honoured)). A kick inside the window is not lost: one trailing
honour is scheduled for the end of the window and carries everything asked for in the meantime (the other projects' expiry if any of the coalesced kicks wanted it).
The request that carried the kick is always answered from the cache, as before."""
import os
import threading
import time

_lock = threading.Lock()
_state = {"last": 0.0, "timer": None, "invalidate": None, "expire": None}


def min_seconds():
    try:
        return max(0.0, float(os.environ.get("AGENT_MANAGER_BRANCH_KICK_MIN_SECONDS", "60")))
    except ValueError:
        return 60.0


def reset():
    """Forget the window (tests, and a clean start). A pending trailing honour is cancelled."""
    with _lock:
        timer = _state["timer"]
        _state.update(last=0.0, timer=None, invalidate=None, expire=None)
    if timer is not None:
        timer.cancel()


def kick(invalidate, expire_others=None, now=time.time, timer_factory=threading.Timer):
    """Honour this kick now, or coalesce it into the one trailing honour. `invalidate()` always runs when honoured; `expire_others()` (None for a kick that did not ask for all
    projects) runs when any coalesced kick asked for it. The newest callables win. Returns 'now', 'scheduled' (a trailing honour was set up) or 'merged' (one is already waiting)."""
    window = min_seconds()
    t = now()
    with _lock:
        _state["invalidate"] = invalidate
        if expire_others is not None:
            _state["expire"] = expire_others
        elapsed = t - _state["last"]
        if elapsed >= window:
            _state["last"] = t
            inv, exp = _take()
            timer = None
        else:
            if _state["timer"] is not None:
                return "merged"
            timer = timer_factory(window - elapsed, _trailing(now))
            timer.daemon = True
            _state["timer"] = timer
    if timer is None:
        inv()
        if exp is not None:
            exp()
        return "now"
    timer.start()
    return "scheduled"


def _take():
    """Under the lock: the callables to run for this honour, and forget the wish for the other projects (it belongs to the window that is closing)."""
    inv, exp = _state["invalidate"], _state["expire"]
    _state["expire"] = None
    return inv, exp


def _trailing(now):
    def run():
        with _lock:
            _state["timer"] = None
            _state["last"] = now()
            inv, exp = _take()
        inv()
        if exp is not None:
            exp()
    return run
