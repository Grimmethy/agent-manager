"""Queue page index: lightweight task listings built from directory scans only.

This module provides the "what's in the queue" view without reading task JSON
files. It is intentionally decoupled from the heavy route logic in
queue_project_filter.py -- it supplies raw id->state/project mappings that the
route layer can use to assemble responses.

Contract (HUB0776):
- list_state_ids(project_slugs, state) -> sorted [(id, project, path)]
  Directory listing only (os.scandir). No JSON reads.
- dependency_index() -> {id: (state, project)}
  Cached map, invalidated by mtime_ns signature of state directories.
- resolve_page_depends_on(piece, index) -> [{taskId, state, project}]
  With {taskId, state: None, project: None} for missing ids.
  Keeps the unresolved_dependency queue_filter_stats counter.
"""
import os
import threading
from pathlib import Path

# Queue state directories scanned for task JSON files. Mirrors the set used by
# queue_project_filter._STATE_DIRS so the index covers every state the route
# layer already surfaces.
_STATE_DIRS = (
    "pending",
    "review",
    "approved",
    "blocked",
    "done",
    "needs-clarification",
    "awaiting-confirm",
    "coordinating",
)

# Cache for dependency_index(). Protected by _cache_lock.
_cache = {}
_cache_sig = None
_cache_lock = threading.Lock()


def _bump_stat(key):
    """Increment a counter in the shared queue_filter_stats namespace.

    Imported lazily to avoid a top-level import cycle with queue_project_filter.
    The counter is consulted by monitoring dashboards to flag tasks whose
    dependsOn references an id that no longer exists in any queue state.
    """
    from routes.queue_project_filter import queue_filter_stats

    queue_filter_stats[key] = queue_filter_stats.get(key, 0) + 1


def _registry():
    """Return the list of registered projects (labels + pipelineDir)."""
    from app import read_project_registry

    return [e for e in read_project_registry() if isinstance(e, dict)]


def _queue_dir_for_label(label):
    """queue/ directory for a registered project label, or None if unavailable."""
    for e in _registry():
        if e.get("label") == label and e.get("pipelineDir"):
            q = Path(e["pipelineDir"]) / "queue"
            if q.is_dir():
                return q
            return None
    return None


def _active_queue_dir():
    """queue/ directory for the active project (no label)."""
    from app import queue_dir

    return queue_dir()


def list_state_ids(project_slugs, state):
    """Return sorted [(id, project, path)] for task files in a single state dir.

    project_slugs: iterable of project labels (including the sentinel "active"
        for the default project).
    state: one of _STATE_DIRS (e.g. "pending", "review").

    Uses os.scandir only -- never reads JSON. The id comes from the filename
    stem (task files are named by their id), the project is the label passed
    in, and path is the absolute Path to the file.

    Returns a sorted list (by id) of (id, project, path) tuples. Empty state
    dirs or missing queue directories produce no entries and are not errors.
    """
    if state not in _STATE_DIRS:
        return []

    out = []
    for slug in project_slugs:
        if slug == "active":
            qdir = _active_queue_dir()
        else:
            qdir = _queue_dir_for_label(slug)
        if qdir is None or not qdir.is_dir():
            continue
        state_dir = qdir / state
        if not state_dir.is_dir():
            continue
        try:
            with os.scandir(state_dir) as scan:
                for entry in scan:
                    if entry.name.endswith(".json"):
                        out.append((entry.name[:-5], slug, Path(entry.path)))
        except OSError:
            continue

    out.sort(key=lambda x: x[0])
    return out


def _compute_signature(project_slugs):
    """Compute an mtime_ns signature over all state directories for given projects.

    Returns a tuple of (project_slug, state_name, mtime_ns) sorted for stability.
    Empty/missing dirs contribute (slug, state, 0) so the signature is stable
    across runs even when dirs appear/disappear.
    """
    sig = []
    for slug in project_slugs:
        if slug == "active":
            qdir = _active_queue_dir()
        else:
            qdir = _queue_dir_for_label(slug)
        if qdir is None or not qdir.is_dir():
            for state in _STATE_DIRS:
                sig.append((slug, state, 0))
            continue
        for state in _STATE_DIRS:
            state_dir = qdir / state
            try:
                mtime = state_dir.stat().st_mtime_ns
            except OSError:
                mtime = 0
            # Per-file mtimes: an in-place edit does not change the dir mtime.
            files_sig = 0
            try:
                with os.scandir(state_dir) as scan:
                    for entry in scan:
                        if entry.name.endswith(".json"):
                            try:
                                files_sig ^= hash((entry.name, entry.stat().st_mtime_ns))
                            except OSError:
                                pass
            except OSError:
                pass
            sig.append((slug, state, mtime, files_sig))
    sig.sort()
    return tuple(sig)


def dependency_index():
    """Return {id: (state, project)} mapping every task id to its state and project.

    The result is cached and invalidated when any state directory's mtime_ns
    changes (detected via the signature computed by _compute_signature).

    The id comes from the filename stem -- this is a directory-scan-only view,
    no JSON is read. Projects are labels from the registry (or "active").

    Returns a dict mapping task id (str) -> (state, project) tuple.
    """
    global _cache, _cache_sig

    project_slugs = ["active"] + [e.get("label") for e in _registry() if e.get("label")]
    project_slugs = [s for s in project_slugs if s]  # filter None

    with _cache_lock:
        sig = _compute_signature(project_slugs)
        if _cache_sig == sig and _cache:
            return _cache

        new_cache = {}
        for slug in project_slugs:
            if slug == "active":
                qdir = _active_queue_dir()
            else:
                qdir = _queue_dir_for_label(slug)
            if qdir is None or not qdir.is_dir():
                continue
            for state in _STATE_DIRS:
                state_dir = qdir / state
                if not state_dir.is_dir():
                    continue
                try:
                    with os.scandir(state_dir) as scan:
                        for entry in scan:
                            if entry.name.endswith(".json"):
                                task_id = entry.name[:-5]
                                new_cache[task_id] = (state, slug)
                except OSError:
                    continue

        _cache = new_cache
        _cache_sig = sig
        return _cache


def resolve_page_depends_on(piece, index):
    """Resolve piece's dependsOn against the given index.

    piece: dict with at least an "id" and "dependsOn" (list of task id strings).
    index: the dict returned by dependency_index() -- {id: (state, project)}.

    Returns [{taskId, state, project}] with None for any field whose dependency
    is absent from index. Bumps the unresolved_dependency counter in
    queue_filter_stats for each dep with state=None (mirrors the behaviour in
    queue_project_filter.queue_response).
    """
    out = []
    for dep_id in piece.get("dependsOn") or []:
        entry = index.get(dep_id)
        if entry is None:
            out.append({"taskId": dep_id, "state": None, "project": None})
            _bump_stat("unresolved_dependency")
        else:
            out.append({"taskId": dep_id, "state": entry[0], "project": entry[1]})
    return out
