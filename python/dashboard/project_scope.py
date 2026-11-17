"""Resolve a project scope value to the project(s) it names.

The scope value is None/empty (the active project), 'all' (every registered project), or a
registered project's label or repo root. The registry and the active-project setting are read
on every call. Nothing is written and nothing is cached.

Error type: an unknown name raises ValueError. branch_projects.resolve_scope and
queue_projects.resolve_queue_dir raise LookupError instead and are intentionally unchanged.

Standalone like branch_projects.py: app.py imports the route modules, so app is imported lazily
inside the function.
"""
import os


def _projects():
    """Every registered project that is a distinct real repo root, plus the active project when it
    is missing from the registry. Each entry: {label, repoRoot, pipelineDir, active}."""
    from app import read_project_registry, get_active_repo_root
    active_root = get_active_repo_root()
    active_real = os.path.realpath(active_root) if active_root else None
    out, seen = [], set()
    for e in read_project_registry():
        root = e.get("repoRoot")
        if not root:
            continue
        real = os.path.realpath(root)
        if real in seen:
            continue
        seen.add(real)
        out.append({
            "label": e.get("label") or os.path.basename(real),
            "repoRoot": real,
            "pipelineDir": e.get("pipelineDir") or real,
            "active": real == active_real,
        })
    if active_real and active_real not in seen:
        out.append({"label": os.path.basename(active_real), "repoRoot": active_real,
                    "pipelineDir": active_real, "active": True})
    return out


def resolve_project_scope(project=None):
    """Return the project a scope value names.

    - None or empty: the active project entry, or None when no project is active.
    - 'all': the list of every registered project entry.
    - a registered label or repo root: that project's entry.
    - anything else: raises ValueError.
    """
    projects = _projects()
    if not project:
        return next((p for p in projects if p["active"]), None)
    if project == "all":
        return projects
    for p in projects:
        if project in (p["label"], p["repoRoot"]):
            return p
    raise ValueError(f"unknown project: {project!r}")
