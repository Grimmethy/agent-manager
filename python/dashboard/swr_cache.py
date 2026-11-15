"""A value that is expensive to compute (here: `node src/lanes.js`), kept fresh by what it depends on instead of by a clock (ADR-0024; piece 4 of 'UI triggers, not polls').

The old cache expired every 60 s and the request that found it expired paid for a `node` start: 6 to 18 s on this host while the shared disk sat at 90% I/O pressure, which is
what made /api/instances (the Workers tab, fetched on every redraw) freeze. Now:

  - the cache is VALID while its dependency key is unchanged: key_fn() is a handful of stat() calls (the lanes registry file, the env file) plus a hash of the AGENT_MANAGER_*
    environment, so nothing is recomputed unless something it reads changed (the trigger), plus a slow reconcile age (ttl_s) as the safety net;
  - when it is NOT valid and a last-good value exists, that value is returned AT ONCE and one background refresh is started (stale-while-revalidate): no request ever waits for node;
  - only when there is nothing at all to serve (the first call after start) does the caller compute inline.

compute() returns the new value, or an empty list/None when it could not be computed (that keeps the last good one). run_background(fn) starts fn on a daemon thread; tests replace
it with a synchronous runner.
"""
import threading
import time

_inflight = set()
_inflight_lock = threading.Lock()


def run_background(fn):
    threading.Thread(target=fn, name="swr-cache-refresh", daemon=True).start()


def _refresh(cache, field, key_fn, compute, now, key):
    try:
        value = compute()
    except Exception:   # noqa: BLE001 -- a failed refresh keeps the last good value
        value = None
    if value:
        cache.update({field: value, "at": now(), "key": key})


def cached_value(cache, field, key_fn, compute, ttl_s, now=time.monotonic, background=None):
    """-> the cached list for `field` (a copy), refreshing as described in the module docstring. Never raises for a failing compute()."""
    background = background or run_background
    current = cache.get(field) or []
    try:
        key = key_fn()
    except Exception:   # noqa: BLE001 -- an unreadable key counts as "changed"
        key = object()
    if current and cache.get("key") == key and now() - cache.get("at", 0.0) < ttl_s:
        return list(current)
    ident = (id(cache), field)
    if not current:
        _refresh(cache, field, key_fn, compute, now, key)
        return list(cache.get(field) or [])
    with _inflight_lock:
        starting = ident not in _inflight
        if starting:
            _inflight.add(ident)
    if starting:
        def job():
            try:
                _refresh(cache, field, key_fn, compute, now, key)
            finally:
                with _inflight_lock:
                    _inflight.discard(ident)
        try:
            background(job)
        except Exception:   # noqa: BLE001 -- could not start a thread: serve the stale value, try again next call
            with _inflight_lock:
                _inflight.discard(ident)
    return list(current)
