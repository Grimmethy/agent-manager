"""Queue-only project lookup, split from branch_projects.py (2026-11-13) so that file's frozen function caps (src/size-ratchet) hold.

Routes that only move a file inside a project's queue directory (the archive route) use this instead of branch_projects.resolve_scope, which needs a registered
project that is its own git repo. Imports from app.py stay lazy: app.py imports the route modules.
"""
import os


def resolve_queue_dir(project_root, active_root):
    """Queue-only twin of resolve_scope, for routes that only move a file inside a project's queue directory (the archive route, 2026-11-13).

    resolve_scope needs a registered project that is its own git repo, because branch actions run git. A project registered with a pipelineDir whose repoRoot is a
    subfolder of another repo (TaxHarvest) has a queue but no `.git`, and so could not be archived in. None = the active project (also when `project_root` is empty);
    otherwise the project's queue Path. An unknown project, or a registry entry with no pipelineDir, raises LookupError (a 404, never a fallback to the active one)."""
    from pathlib import Path
    if not project_root:
        return None
    real = os.path.realpath(project_root)
    if active_root and real == os.path.realpath(active_root):
        return None
    from app import read_project_registry
    for e in read_project_registry():
        root, pipeline = e.get("repoRoot"), e.get("pipelineDir")
        if root and pipeline and os.path.realpath(root) == real:
            return Path(pipeline) / "queue"
    raise LookupError(f"'{project_root}' is not a registered project")
