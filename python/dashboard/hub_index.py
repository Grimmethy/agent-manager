"""One index of the coordinator hub records per project queue, rebuilt only when a hub file changed (found 2026-11-07 in the CPU analysis, after the git memo: a refresh of the Branches
list still cost ~9 s of CPU on the core repo because _hub_for_branch globbed the coordinating/done/superseded folders and parsed EVERY hub record, once per branch and three times per
branch (label, listing, verdict enrichment): ~15,000 json.loads per refresh).

The index lists the hub files in a fixed order (coordinating, then done, then done/_superseded; the order Path.glob gave inside each), keeps each parsed record, and maps a branch name and a sub-task id to
the FIRST file that names it. lookup() answers with the earliest file that matches the branch or any of the task ids, which is exactly what scanning the files in order and stopping at the first
match gave. A file is parsed again only when its (modification time, size) changed; the folder scan is one scandir per folder. A file that is unreadable or not JSON is left out (it is looked at again
when it changes). Kill switch: AGENT_MANAGER_HUB_INDEX=false scans the files the old way on every call."""
import fnmatch
import os
import threading
from pathlib import Path

_lock = threading.Lock()
_cache = {}                # str(qdir) -> {"sig": tuple, "files": {path: (key, record)}, "order": [(path, state, record)], "by_branch": {}, "by_task": {}}
_stats = {"builds": 0, "parses": 0, "lookups": 0}

_FOLDERS = (
    ("coordinating", ("coordinating",), ("*.json",), "coordinating"),
    # (the old scan also listed file-decompose-hub-*.json after this pattern; every such name already matches *-hub-*.json, so it only repeated files)
    ("done", ("done",), ("*-hub-*.json",), "done"),
    ("superseded", ("done", "_superseded"), ("*hub*.json",), "superseded"),
)


def enabled():
    return os.environ.get("AGENT_MANAGER_HUB_INDEX", "").strip().lower() != "false"


def reset():
    with _lock:
        _cache.clear()
        _stats.update(builds=0, parses=0, lookups=0)


def stats():
    with _lock:
        return dict(_stats, projects=len(_cache))


def scan(qdir):
    """[(path, state, (mtime_ns, size))] for every hub file, in the order the old file scan visited them: folder by folder, and inside a folder pattern by pattern, each pattern in
    directory order (what Path.glob yields). A branch that two hubs both name (a rescued branch carries Task: trailers of several hubs) must keep getting the SAME hub as before."""
    out = []
    for _name, parts, patterns, state in _FOLDERS:
        folder = os.path.join(str(qdir), *parts)
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for pattern in patterns:
            for entry in entries:
                if not fnmatch.fnmatchcase(entry.name, pattern):
                    continue
                try:
                    st = entry.stat()
                except OSError:
                    continue
                out.append((entry.path, state, (st.st_mtime_ns, st.st_size)))
    return out


def _build(qdir, listing, read_json, previous):
    old_files = previous["files"] if previous else {}
    files = {}
    order = []
    by_branch = {}
    by_task = {}
    for path, state, key in listing:
        cached = old_files.get(path)
        if cached and cached[0] == key:
            record = cached[1]
        else:
            record = read_json(Path(path))
            with _lock:
                _stats["parses"] += 1
        files[path] = (key, record)
        if not record or not isinstance(record, dict):
            continue
        pos = len(order)
        order.append((path, state, record))
        by_branch.setdefault(record.get("branch"), pos)
        for sub in record.get("subTasks") or []:
            if isinstance(sub, dict):
                try:
                    by_task.setdefault(sub.get("id"), pos)
                except TypeError:          # an unhashable id could never equal a branch task id
                    continue
    return {"sig": tuple((p, s, k) for p, s, k in listing), "files": files, "order": order, "by_branch": by_branch, "by_task": by_task}


def lookup(qdir, branch, task_ids, read_json):
    """(record, state) of the first hub file that owns this branch (its `branch` field) or holds one of `task_ids` among its subTasks, else None."""
    listing = scan(qdir)
    sig = tuple((p, s, k) for p, s, k in listing)
    key = str(qdir)
    with _lock:
        _stats["lookups"] += 1
        entry = _cache.get(key)
    if entry is None or entry["sig"] != sig:
        entry = _build(qdir, listing, read_json, entry)
        with _lock:
            _stats["builds"] += 1
            _cache[key] = entry
    best = entry["by_branch"].get(branch)
    for task_id in task_ids:
        try:
            pos = entry["by_task"].get(task_id)
        except TypeError:
            continue
        if pos is not None and (best is None or pos < best):
            best = pos
    if best is None:
        return None
    path, state, record = entry["order"][best]
    return record, state
