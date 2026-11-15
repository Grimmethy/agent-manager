"""Remembers the git facts of one unmerged branch for as long as the branch and the default branch have not moved (found 2026-11-07 in the CPU analysis: after the kick
coalescer the Branches list still ran ~560 git processes a minute, recomputing ahead/behind, the squash check, the merge-tree conflict preview and the Task: trailers of every
branch of all 47 projects, although the answers depend ONLY on two commit ids: the branch head and the base head).

Key = (repo root, base sha, head sha, kind, extra). A branch that did not move, under a base that did not move, is a hit and costs no git process; a pushed branch or a base that
advanced has a new key and is recomputed once. Nothing is remembered when a sha is unknown or when the caller says the answer is not final (a git error, a timed-out merge-tree).
Bounded (AGENT_MANAGER_BRANCH_GIT_MEMO_MAX entries, default 8192, oldest dropped first; 0 turns the memo off). Counters: stats(); take_delta() for a per-refresh log line."""
import os
import threading
from collections import OrderedDict

_lock = threading.Lock()
_entries = OrderedDict()
_counts = {"hits": 0, "misses": 0, "bypass": 0}
_marked = {"hits": 0, "misses": 0}


def max_entries():
    try:
        return max(0, int(os.environ.get("AGENT_MANAGER_BRANCH_GIT_MEMO_MAX", "8192")))
    except ValueError:
        return 8192


def reset():
    with _lock:
        _entries.clear()
        _counts.update(hits=0, misses=0, bypass=0)
        _marked.update(hits=0, misses=0)


def stats():
    with _lock:
        return {**_counts, "size": len(_entries)}


def take_delta():
    """Hits and misses since the previous call (one refresh's worth when called once per refresh)."""
    with _lock:
        delta = {"hits": _counts["hits"] - _marked["hits"], "misses": _counts["misses"] - _marked["misses"]}
        _marked.update(hits=_counts["hits"], misses=_counts["misses"])
    return delta


def get(repo_root, base_sha, head_sha, kind, compute, final=lambda value: True, extra=""):
    """The remembered value for this key, else `compute()` (which may raise: nothing is stored then). The computed value is stored only when `final(value)` is true."""
    limit = max_entries()
    if limit == 0 or not base_sha or not head_sha:
        with _lock:
            _counts["bypass"] += 1
        return compute()
    key = (str(repo_root), base_sha, head_sha, kind, extra)
    with _lock:
        if key in _entries:
            _entries.move_to_end(key)
            _counts["hits"] += 1
            return _entries[key]
    value = compute()
    with _lock:
        _counts["misses"] += 1
        if final(value):
            _entries[key] = value
            _entries.move_to_end(key)
            while len(_entries) > limit:
                _entries.popitem(last=False)
    return value
