"""Single source of truth for cross-project path resolution.

Maps a project hint -- a project label (e.g. "alpha"), a filesystem repoRoot, or None for
the active project -- to that project's pipeline dir and queue dir, reusing the
`registered_projects` registry in branch_projects.py instead of re-deriving paths inline in
routes and helpers (the borrowed-task 404 bug came from each call site doing this its own
way).

Standalone like branch_verdicts.py: everything from app.py is imported lazily inside
functions, so importing this module never drags in the Flask app. Works both as
`dashboard.project_scope` (package context) and as a top-level `project_scope` (dashboard
dir on sys.path, how the tests and app.py load their siblings).

Pure in-memory lookup: no filesystem writes, no git, no network.

NOTE for callers: `resolve_project` raises `ValueError` for an unknown hint (the older
`branch_projects.resolve_scope` raises `LookupError`). A given-but-unknown hint never
falls back to the active project.
"""
import os
from pathlib import Path

try:
    from .branch_projects import registered_projects
except ImportError:  # imported as a top-level module (dashboard dir on sys.path)
    from branch_projects import registered_projects

__all__ = ["resolve_project", "all_registered_projects"]


def _active_root():
    """The active project's repo root, None when the dashboard has none set. Lazy import:
    app.py is heavy and only needs its one-line setting accessor."""
    try:
        from app import get_active_repo_root
    except Exception:  # noqa: BLE001 -- no app in this context: resolve without an active flag
        return None
    root = get_active_repo_root()
    return str(root) if root else None


def _normalize(p):
    """One registry entry -> the consistent key set every consumer gets."""
    pipeline_dir = str(p["pipelineDir"])
    return {
        "label": p["label"],
        "repo_root": str(p["repoRoot"]),
        "pipeline_dir": pipeline_dir,
        "queue_dir": str(Path(pipeline_dir) / "queue"),
        "active": bool(p["active"]),
    }


def all_registered_projects():
    """Every registered project (one per real git root, active one flagged), normalised to
    the {label, repo_root, pipeline_dir, queue_dir, active} key set. `queue_dir` is derived
    exactly like branch_projects.resolve_scope: Path(pipelineDir) / "queue"."""
    return [_normalize(p) for p in registered_projects(_active_root())]


def resolve_project(hint):
    """Resolve a project label OR repoRoot to its path record
    {label, repo_root, pipeline_dir, queue_dir, active}.

    hint: a project label, a filesystem repoRoot path, or None/"" for the active project.
    Matching order: case-insensitive label -> exact repoRoot (realpath-compared, so relative
    and symlinked hints work) -> repoRoot suffix (a path-like hint such as the trailing
    folder name).

    Raises:
        ValueError: the hint is given but matches no registered project (no silent fallback
            to the active one), or None/"" was given but no active project is set.
    """
    entries = all_registered_projects()
    if hint is None or str(hint).strip() == "":
        for e in entries:
            if e["active"]:
                return e
        raise ValueError("No active project to resolve to; registry: "
                         + ", ".join(e["label"] for e in entries))

    hint = str(hint)
    lowered = hint.lower()
    for e in entries:  # 1) label, case-insensitive
        if e["label"].lower() == lowered:
            return e
    hint_real = os.path.realpath(hint)
    for e in entries:  # 2) exact repoRoot (realpath on both sides)
        if e["repo_root"] == hint or os.path.realpath(e["repo_root"]) == hint_real:
            return e
    for e in entries:  # 3) path-like hint: trailing part of the repoRoot
        if e["repo_root"].lower().endswith(lowered):
            return e
    raise ValueError(f"Unknown project: {hint!r}")
