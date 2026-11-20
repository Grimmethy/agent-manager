"""Short stale-while-revalidate cache for the /api/adhoc-tasks list.

Behaviour:
- Fresh (age < 5 s): return a copy of the stored list, no compute call.
- Stale (5 s <= age < 30 s): return a copy of the stored list at once and
  start one daemon refresh thread for the key, triggered only by a request.
- Cold or too stale (no entry, or age >= 30 s): compute synchronously.
- A failed compute never overwrites the stored value. A failed cold compute
  raises; a failed background refresh only records last_error.
- Every return value is a copy, so callers cannot alias the cache.
- No timers: the cache does work only when get() is called.
"""
import copy
import threading
import time


class SwrListCache:
    def __init__(self, compute, clock=time.monotonic, fresh_s=5.0, stale_s=30.0):
        self._compute = compute
        self._clock = clock
        self._fresh_s = fresh_s
        self._stale_s = stale_s
        self._lock = threading.Lock()
        self._entries = {}      # key -> {"value": list, "at": float}
        self._refreshing = set()
        self.last_error = {}    # key -> exception or None

    def get(self, key):
        start_refresh = False
        served = None
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                age = self._clock() - entry["at"]
                if age < self._fresh_s:
                    return copy.deepcopy(entry["value"])
                if age < self._stale_s:
                    served = copy.deepcopy(entry["value"])
                    if key not in self._refreshing:
                        self._refreshing.add(key)
                        start_refresh = True
        if served is not None:
            if start_refresh:
                # Started outside the lock so the thread cannot deadlock on it.
                threading.Thread(target=self._refresh, args=(key,),
                                 daemon=True).start()
            return served
        # Cold or too stale: compute synchronously. Store only on success.
        try:
            fresh = self._compute(key)
        except Exception as exc:
            with self._lock:
                self.last_error[key] = exc
            raise
        with self._lock:
            self._entries[key] = {"value": fresh, "at": self._clock()}
            self.last_error[key] = None
        return copy.deepcopy(fresh)

    def _refresh(self, key):
        try:
            fresh = self._compute(key)
        except Exception as exc:
            with self._lock:
                # Stored entry left untouched: a failed refresh never overwrites it.
                self.last_error[key] = exc
        else:
            with self._lock:
                self._entries[key] = {"value": fresh, "at": self._clock()}
                self.last_error[key] = None
        finally:
            with self._lock:
                self._refreshing.discard(key)


def page_tasks(tasks, limit, offset):
    """Return (page, total) for a list of tasks.

    limit=None means no upper bound. Raises ValueError on a negative limit or
    offset. The page is a new list, so it never aliases the input.
    """
    if offset < 0:
        raise ValueError("offset must be >= 0")
    if limit is not None and limit < 0:
        raise ValueError("limit must be >= 0")
    total = len(tasks)
    if limit is None:
        page = list(tasks[offset:])
    else:
        page = list(tasks[offset:offset + limit])
    return page, total
