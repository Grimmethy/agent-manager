"""Registry of the projects listed in projects.json.

list_projects() and resolve_registered_repo() are the shared lookups for every
registered project. They read projects.json with the same candidate paths as
_get_project_tests_command() in routes/pipeline_1_more.py, but they never consult
the active repo, so they see every registered project regardless of which one is
active.
"""
import json
from pathlib import Path

# Base for the projects.json lookup: this package's repo root
# (python/dashboard/project_registry.py -> parents[2]). The candidate list below
# mirrors routes/pipeline_1_more.py:30, applied to this base instead of a
# caller-supplied repo_root.
_REGISTRY_BASE = Path(__file__).resolve().parents[2]


def _load_projects() -> list:
    """Return the parsed projects.json list, or [] if missing, unreadable, or not a list."""
    repo_root = _REGISTRY_BASE
    candidates = [repo_root / "projects.json", (repo_root.parent) / "projects.json"]
    projects_path = None
    for candidate in candidates:
        if candidate.is_file():
            projects_path = candidate
            break

    if not projects_path:
        return []

    try:
        projects = json.loads(projects_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []

    if not isinstance(projects, list):
        return []
    return projects


def list_projects() -> list:
    """Return a dict {name, repoRoot, pool, testsCommand, mainBranch} per registered project.

    Entries with neither repoRoot nor path are skipped.
    """
    out = []
    for entry in _load_projects():
        if not isinstance(entry, dict):
            continue
        repo = entry.get("repoRoot") or entry.get("path")
        if not repo:
            continue
        out.append({
            "name": entry.get("name"),
            "repoRoot": repo,
            "pool": entry.get("pool"),
            "testsCommand": entry.get("testsCommand"),
            "mainBranch": entry.get("mainBranch"),
        })
    return out


def resolve_registered_repo(repo_root):
    """Return the list_projects() dict whose repoRoot resolves to repo_root, or None."""
    if not repo_root:
        return None
    target = Path(repo_root).resolve()
    for project in list_projects():
        if Path(project["repoRoot"]).resolve() == target:
            return project
    return None
