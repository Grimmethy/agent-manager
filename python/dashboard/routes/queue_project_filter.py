"""Project filter helpers for GET /api/queue (HUB0485 1/2).

Self-contained: defines parse_project_param, collect_pieces and resolve_depends_on.
The registry reader and queue_dir() are imported lazily from app, the same way
routes/cloud_dial.py and routes/instances.py import app helpers, so this module
has no top-level import cycle with app.py.

Verified sources (python/dashboard):
  - app.read_project_registry() -> list of {repoRoot, pipelineDir, domainsPath, label}
  - app.queue_dir() -> Path | None (no arguments; active project only)
  - app.read_json_safe(path) -> dict | None
  - app.queue_dir_for_project_label is NOT used; named projects resolve via
    registry pipelineDir / 'queue', mirroring app._queue_dir_for_project_label.
"""
from pathlib import Path

ACTIVE = "active"
ALL = "all"

# Queue state directories scanned for task JSON files.
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


def _registry():
    from app import read_project_registry

    return [e for e in read_project_registry() if isinstance(e, dict)]


def parse_project_param(value):
    """Return 'active', 'all', or a known project slug (registry label).

    None or blank -> 'active'. Unknown slug -> ValueError (the handler maps it to HTTP 400).
    """
    if value is None:
        return ACTIVE
    v = str(value).strip()
    if v == "":
        return ACTIVE
    if v in (ACTIVE, ALL):
        return v
    labels = {e.get("label") for e in _registry() if e.get("label")}
    if v in labels:
        return v
    raise ValueError(f"unknown project: {v}")


def _queue_dir_for(project_param):
    """queue/ directory for 'active' or a registered slug, or None if unavailable."""
    if project_param == ACTIVE:
        from app import queue_dir

        return queue_dir()
    for e in _registry():
        if e.get("label") == project_param and e.get("pipelineDir"):
            q = Path(e["pipelineDir"]) / "queue"
            if q.is_dir():
                return q
            return None
    return None


def _pieces_in(qdir, label):
    """Read every task JSON under the queue state dirs of qdir, tagged with label.

    Each piece carries id, title, state (the queue dir it sits in), dependsOn
    (raw dependency ids from the task file), and project.
    """
    from app import read_json_safe

    out = []
    if qdir is None:
        return out
    for state in _STATE_DIRS:
        d = qdir / state
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.json")):
            data = read_json_safe(f)
            if not isinstance(data, dict):
                continue
            deps = data.get("dependsOn") or []
            out.append({
                "id": data.get("id", f.stem),
                "title": data.get("title"),
                "state": state,
                "dependsOn": list(deps) if isinstance(deps, (list, tuple)) else [],
                "project": label,
            })
    return out


def collect_pieces(project_param):
    """Pieces for 'active', one slug, or 'all'. Every piece gets a 'project' badge.

    'all' aggregates every registered project; 'active' and a slug read only that
    project's queue via queue_dir() / the registry pipelineDir.
    """
    if project_param == ALL:
        pieces = []
        for e in _registry():
            label = e.get("label")
            if not label:
                continue
            pieces += _pieces_in(_queue_dir_for(label), label)
        return pieces
    label = project_param if project_param != ACTIVE else ACTIVE
    return _pieces_in(_queue_dir_for(project_param), label)


def resolve_depends_on(piece, full_store):
    """Resolve piece's dependsOn against the FULL unfiltered store.

    full_store must be the unfiltered list from collect_pieces('all'), never a
    filtered subset. Returns [{taskId, state, project}] with None for any field
    whose dependency is absent from full_store.
    """
    by_id = {p.get("id"): p for p in full_store if isinstance(p, dict)}
    out = []
    for dep in piece.get("dependsOn") or []:
        d = by_id.get(dep)
        out.append({
            "taskId": dep,
            "state": d.get("state") if d else None,
            "project": d.get("project") if d else None,
        })
    return out
