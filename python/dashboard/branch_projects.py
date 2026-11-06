"""Unmerged branches of EVERY registered project, not only the active one (Unmerged Branches tab, `?projects=all`).

The active project keeps its own cache in app.py (fresh, stale-while-revalidate). Every other project is listed here, one cache entry per repo root, refreshed by ONE
background thread that walks the stale projects one after another: a project's list costs a `git fetch` plus per-branch git work (seconds to tens of seconds), so
computing 20 of them inside a request would blow the tab's 30 s timeout. A request therefore never waits: it returns what is cached and names the projects that have no
list yet in `pending`.

Read-only by design: these branches are LISTED and labelled with their project; merge/discard stay with the active project (their endpoints, apply lock and live sync are
all active-project scoped). The one write is the same one the active project makes: deterministic verdicts into that project's own queue/branch-verdicts.json.

Standalone like branch_verdicts.py: app.py imports the route modules, so everything from app.py is imported lazily inside functions.
"""
import os
import sys
import threading
import time

_lock = threading.Lock()
_state = {"cache": {}, "thread": None}  # cache: real repo root -> {"at": epoch, "branches": [...], "error": str|None, "hubKey": str|None}

# Per-directory (inode, size, mtime_ns) cache for hub_state_key. Bounded to avoid unbounded growth.
_hub_state_cache = {}  # pipeline_dir -> {"key": str, "files": {relpath: (inode, size, mtime_ns)}, "at": epoch}
_HUB_STATE_CACHE_MAX = 500


def _ttl_seconds():
    """How long another project's branch list is served before the background thread refetches it. Default 1800 s (was 300): with ~20 registered repos the old value meant
    a `git fetch` about every 15 s on the shared disk (ADR-0024 measurement, 2026-11-03). Merge/discard in the active project invalidate its own cache separately."""
    try:
        return max(30.0, float(os.environ.get("AGENT_MANAGER_BRANCH_OTHER_PROJECTS_TTL_SECONDS", "1800")))
    except ValueError:
        return 1800.0


def hub_state_key(pipeline_dir):
    """Deterministic key over the hub state files in a pipeline directory.

    Reads every queue/coordinating/*.json file and hashes (filename, inode, size, mtime_ns)
    for each. Returns a hex string. Two pipelines with identical hub state produce the same
    key; any change to any coordinating file changes the key.

    Pure function -- no side effects, no I/O caching of its own. Callers should wrap with
    _hub_state_with_cache for the per-file (inode, size, mtime_ns) short-circuit.
    """
    import hashlib
    coord_dir = os.path.join(pipeline_dir, "queue", "coordinating")
    if not os.path.isdir(coord_dir):
        return ""
    entries = []
    for name in sorted(os.listdir(coord_dir)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(coord_dir, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        entries.append((name, st.st_ino, st.st_size, st.st_mtime_ns))
    h = hashlib.sha256()
    for entry in entries:
        h.update(str(entry).encode("utf-8"))
    return h.hexdigest()


def _hub_state_with_cache(pipeline_dir):
    """hub_state_key with per-directory (inode, size, mtime_ns) caching.

    Skips the stat+hash work entirely when every file's (inode, size, mtime_ns) matches
    the cached values. Bounded to 500 entries to prevent unbounded growth across many
    registered projects.
    """
    cached = _hub_state_cache.get(pipeline_dir)
    if cached is not None:
        # Quick directory-level check first: if the directory itself hasn't changed,
        # and every file still matches, return the cached key.
        files_match = True
        coord_dir = os.path.join(pipeline_dir, "queue", "coordinating")
        if os.path.isdir(coord_dir):
            for name, (c_ino, c_size, c_mtime) in cached["files"].items():
                fpath = os.path.join(coord_dir, name)
                try:
                    st = os.stat(fpath)
                except OSError:
                    files_match = False
                    break
                if (st.st_ino, st.st_size, st.st_mtime_ns) != (c_ino, c_size, c_mtime):
                    files_match = False
                    break
        else:
            files_match = False
        if files_match:
            return cached["key"]

    key = hub_state_key(pipeline_dir)
    # Re-stat to capture current file metadata for the cache.
    coord_dir = os.path.join(pipeline_dir, "queue", "coordinating")
    file_meta = {}
    if os.path.isdir(coord_dir):
        for name in sorted(os.listdir(coord_dir)):
            if not name.endswith(".json"):
                continue
            fpath = os.path.join(coord_dir, name)
            try:
                st = os.stat(fpath)
                file_meta[name] = (st.st_ino, st.st_size, st.st_mtime_ns)
            except OSError:
                continue
    # Evict oldest entries if over capacity.
    if len(_hub_state_cache) >= _HUB_STATE_CACHE_MAX:
        oldest_key = min(_hub_state_cache, key=lambda k: _hub_state_cache[k]["at"])
        del _hub_state_cache[oldest_key]
    _hub_state_cache[pipeline_dir] = {"key": key, "files": file_meta, "at": time.time()}
    return key


def registered_projects(active_root):
    """Every registered project that is its own git repo, one per real repo root (projects.json lists some repos twice under two mount paths and some as a subfolder
    of another), active one flagged. A project the registry lacks but that is active still appears."""
    from app import read_project_registry
    entries = list(read_project_registry())
    active_real = os.path.realpath(active_root) if active_root else None
    if active_real and not any(os.path.realpath(e.get("repoRoot") or "") == active_real for e in entries):
        entries.append({"repoRoot": active_real, "label": os.path.basename(active_real)})
    seen, out = set(), []
    for e in entries:
        root = e.get("repoRoot")
        if not root:
            continue
        real = os.path.realpath(root)
        if real in seen or not os.path.exists(os.path.join(real, ".git")):
            continue
        seen.add(real)
        out.append({
            "label": e.get("label") or os.path.basename(real),
            "repoRoot": real,
            "pipelineDir": e.get("pipelineDir") or real,
            "active": real == active_real,
        })
    return out


def project_tag(project):
    return {"label": project["label"], "repoRoot": project["repoRoot"], "active": bool(project["active"])}


def expire_all():
    """Mark every other project's cached list stale (its `at` back to 0, the last good list kept) so the next request starts ONE background refresh at once instead of
    waiting for the TTL. Used when something announced that branches changed."""
    with _lock:
        for entry in _state["cache"].values():
            entry["at"] = 0.0


def _refresh_stale(projects):
    """Background thread body: recompute each stale project in turn. A failure stamps the entry anyway (keeping any previous list) so a broken repo is retried at the
    next TTL, not on every request.

    Stores the current hubKey in the cache entry before recomputing so that other_project_branches
    can detect phase changes (hub state file changes) and trigger a refresh even within the TTL.
    """
    import app
    try:
        for p in projects:
            err = None
            # Capture hubKey BEFORE recomputing branches -- this is the "before" snapshot.
            hub_key_before = _hub_state_with_cache(p["pipelineDir"])
            try:
                branches = app._list_unmerged_branches_uncached(force_fetch=True, repo_root=p["repoRoot"], pipeline_dir=p["pipelineDir"])
            except Exception as e:  # noqa: BLE001 -- one broken repo must not stop the others
                err = f"{type(e).__name__}: {e}"
                print(f"[branches] project {p['label']} failed (non-fatal): {err}", file=sys.stderr)
                with _lock:
                    branches = list((_state["cache"].get(p["repoRoot"]) or {}).get("branches") or [])
            import event_stream
            with _lock:
                previous = _state["cache"].get(p["repoRoot"]) or {}
                _state["cache"][p["repoRoot"]] = {
                    "at": time.time(),
                    "branches": branches,
                    "error": err,
                    "hubKey": hub_key_before,
                }
            if event_stream.digest(branches) != event_stream.digest(previous.get("branches")):
                event_stream.announce("branch-list-changed", project=p["repoRoot"])
    finally:
        with _lock:
            _state["thread"] = None


def other_project_branches(active_root):
    """({project tag -> branches}, pending labels). Never blocks on git: returns the cache and starts the refresh thread for anything stale.

    A project is stale when:
      Rule 1 (TTL): time since last refresh >= ttl_seconds()
      Rule 2 (phase change): hubKey differs from cached value AND >= 30 s since last refresh

    Rule 2 lets us react to hub state file changes (coordinating/*.json) without waiting for the
    full TTL, but the 30 s floor prevents thrashing when a hub is being rapidly updated.
    """
    others = [p for p in registered_projects(active_root) if not p["active"]]
    ttl, now = _ttl_seconds(), time.time()
    with _lock:
        cache = dict(_state["cache"])
        stale = []
        for p in others:
            entry = cache.get(p["repoRoot"])
            if entry is None:
                stale.append(p)
                continue
            last_at = entry.get("at", 0.0)
            # Rule 1: TTL expired.
            if now - last_at >= ttl:
                stale.append(p)
                continue
            # Rule 2: hubKey changed AND 30 s floor passed.
            cached_hub_key = entry.get("hubKey")
            current_hub_key = _hub_state_with_cache(p["pipelineDir"])
            if cached_hub_key != current_hub_key and now - last_at >= 30.0:
                stale.append(p)
        if stale and _state["thread"] is None:
            t = threading.Thread(target=_refresh_stale, args=(stale,), name="branch-projects-refresh", daemon=True)
            _state["thread"] = t
            t.start()
    result, pending = [], []
    for p in others:
        entry = cache.get(p["repoRoot"])
        if entry is None:
            pending.append(p["label"])
            continue
        result.append((p, entry["branches"]))
    return result, pending


def combined_branches(active_branches, active_root):
    """Active project's branches first (their existing order), then each other project's, projects A-Z and oldest push first within one. Every row is a copy carrying a
    `project` tag, so the cached lists are never mutated. Returns (rows, pending project labels)."""
    projects = registered_projects(active_root)
    active = next((p for p in projects if p["active"]), None)
    rows = []
    if active_branches:
        tag = project_tag(active) if active else {"label": "active project", "repoRoot": active_root or "", "active": True}
        rows.extend({**b, "project": tag} for b in active_branches)
    others, pending = other_project_branches(active_root)
    for p, branches in sorted(others, key=lambda pb: pb[0]["label"].lower()):
        tag = project_tag(p)
        rows.extend({**b, "project": tag} for b in sorted(branches, key=lambda b: b.get("pushedAt") or ""))
    return rows, pending


def resolve_scope(project_root, active_root):
    """What a branch action (merge, discard, verdict) must act on. None = the active project (also when `project_root` is absent or is the active root):
    the caller keeps its existing code path. A dict {label, repoRoot, pipelineDir, repoPath, qdir} for another registered project. An unknown project raises
    LookupError so the route answers 404: a given-but-unknown project never falls back to the active one."""
    from pathlib import Path
    if not project_root:
        return None
    real = os.path.realpath(project_root)
    if active_root and real == os.path.realpath(active_root):
        return None
    for p in registered_projects(active_root):
        if p["repoRoot"] == real and not p["active"]:
            return {**p, "repoPath": Path(real), "qdir": Path(p["pipelineDir"]) / "queue"}
    raise LookupError(f"'{project_root}' is not a registered project")


def find_or_refresh_other_project_branch(scope, branch):
    """find_other_project_branch, but when that project has no cached list that names the branch (the cache is only filled once the tab has asked for `?projects=all`,
    and a list can be up to TTL old), compute the project's list now, exactly like merge and discard do, and look again. Without this a verdict for a pushed branch of a
    registered project was parked in pending_verdicts, which nothing drains for a non-active project. A failed refresh counts as 'not listed'."""
    real, row = find_other_project_branch(scope["repoRoot"], branch)
    if row:
        return real, row
    try:
        refresh_branches(scope)
    except Exception as e:  # noqa: BLE001 -- the caller falls back to its pending/404 path
        print(f"[branches] refresh for verdict on {scope.get('label')} failed (non-fatal): {type(e).__name__}: {e}", file=sys.stderr)
    return find_other_project_branch(scope["repoRoot"], branch)


def refresh_branches(scope):
    """Recompute that project's list NOW (git fetch included) and cache it: an action must gate on the branch as it is, not on a list up to 5 minutes old."""
    import app
    rows = app._list_unmerged_branches_uncached(force_fetch=True, repo_root=scope["repoRoot"], pipeline_dir=scope["pipelineDir"],
                                                fetch_timeout=app._ACTION_FETCH_TIMEOUT_SECONDS)
    with _lock:
        _state["cache"][scope["repoRoot"]] = {"at": time.time(), "branches": rows, "error": None}
    return rows


def after_action(scope):
    """After a merge/discard/verdict in another project: recompute its list so the card disappears (or changes) on the next poll. A failure only marks the
    entry stale so the background refresh redoes it; the action itself already succeeded."""
    try:
        refresh_branches(scope)
    except Exception as e:  # noqa: BLE001
        print(f"[branches] refresh after action failed for {scope.get('label')} (non-fatal): {e}", file=sys.stderr)
        with _lock:
            entry = _state["cache"].get(scope["repoRoot"])
            if entry:
                entry["at"] = 0.0


def patch_verdict_cache(scope, branch, verdict, reasons, head_sha, record=None):
    """Update the cached row for a branch in a non-active project with a new verdict without recomputing the whole list.

    A verdict does not change which branches exist, only their label. So we patch the cached row in place and mark the entry stale (at=0.0) so the next
    background refresh redoes it. Merge/discard still call after_action() because a card can disappear.

    Returns None on success, an error string on failure (the verdict was still recorded; only the cache patch failed).
    """
    with _lock:
        cache = dict(_state["cache"])
    entry = cache.get(scope["repoRoot"])
    if not entry:
        return "no cached list for project"
    row = next((b for b in entry["branches"] if b["branch"] == branch), None)
    if not row:
        return f"branch '{branch}' not in cached list"
    row["verdict"] = verdict
    row["reasons"] = list(reasons) if reasons else []
    row["stale"] = False
    # source / verifiedAt are what a card shows next to the badge (tooltip, detail view); a patched row must carry them like a recomputed one does.
    if isinstance(record, dict):
        row["source"] = record.get("source")
        row["verifiedAt"] = record.get("verifiedAt")
    with _lock:
        current = _state["cache"].get(scope["repoRoot"])
        if current:
            current["at"] = 0.0
    return None


def find_other_project_branch(project_root, branch):
    """(project, branch row) for a cached branch of a NON-active project, else (None, None). The commits endpoint's "only act on what we offered" gate."""
    with _lock:
        cache = dict(_state["cache"])
    real = os.path.realpath(project_root or "")
    entry = cache.get(real)
    if not entry:
        return None, None
    row = next((b for b in entry["branches"] if b["branch"] == branch), None)
    return (real, row) if row else (None, None)
