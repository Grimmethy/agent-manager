"""Cross-project task resolution (2026-10-30).

A task's ID is only unique within one project's queue -- the same ID can exist in
two different projects' queues without conflict. Routes that need to find a task
regardless of which project owns it (e.g. /api/task-anywhere, work-log) accept an
optional ?project= hint to narrow the search, then fall back to the active project
when no hint is given, then to every other project if still not found.

This module is the single source of truth for that resolution logic: routes import
it, tests import it, and the JS side never needs to know about the search order.

The project label format is a string matching a registered project name (one of the
labels returned by branch_projects.registered_projects(active_root)). The ?project=
query parameter in routes.py is a string matching a registered project name. Routes
task-anywhere and work-log extract ?project= from query params and pass it as
project_hint.
"""

import json
from pathlib import Path


# Queue state directories, in priority order for task lookup. Mirrors QUEUE_STATES in
# app_settings_helpers.py -- kept inline here so project_scope.py stays self-contained
# and does not pull in the flask-dependent app_settings_helpers transitive dependency.
_QUEUE_STATES = ["pending", "review", "approved", "blocked", "done", "needs-clarification", "awaiting-confirm", "coordinating"]


# Where a task file lives inside one project's queue directory, searched in priority
# order: drafting first (still being written), then every live state dir, then adhoc.
# Mirrors _find_live_task_file in app_catalog_helpers.py.
def _find_live_task_file(qdir: Path, task_id: str) -> Path | None:
    """Same search order as api_task_anywhere (drafting first, then every
    QUEUE_STATES dir, then adhoc/), but returns the actual file Path instead of its
    parsed content -- for a route that needs to WRITE the file back, not just display it.
    Deliberately does not search the done/_archived* trees api_task_anywhere also checks:
    a task that has already reached a terminal, archived state is never read by
    next-claimable-task.js's claim ranking again, so there's nothing for a priority flag
    to affect there."""
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for candidate in drafting_root.rglob(f"{task_id}.json"):
            return candidate
    for state in _QUEUE_STATES:
        p = qdir / state / f"{task_id}.json"
        if p.is_file():
            return p
    adhoc_p = qdir / "adhoc" / f"{task_id}.json"
    if adhoc_p.is_file():
        return adhoc_p
    return None


# Thin wrapper around json.loads that returns None on any read/parse error so callers
# never have to guard. Mirrors read_json_safe in app.py.
def _read_json_safe(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


class TaskNotFoundError(Exception):
    """Raised when a task ID is not found in any project's queue."""
    pass


def resolve_task_across_projects(task_id: str, project_hint: str | None, projects: dict) -> dict:
    """Look up a task by ID across all registered projects.

    Args:
        task_id: The task ID to look up (string).
        project_hint: Optional project name (from ?project= query param) to search first.
                     If provided, that project is checked before falling back to others.
        projects: Dict mapping project names to task store dicts. Each task store should
                 have a 'qdir' key (Path) pointing to the project's queue directory.
                 Example: {"my-project": {"qdir": Path("/path/to/queue"), "repoRoot": "/path"}}

    Returns:
        The task data dict if found.

    Raises:
        TaskNotFoundError: If the task is not found in any project's queue.
    """
    # Determine search order: hint first (if provided), then all other projects.
    if project_hint and project_hint in projects:
        search_order = [project_hint] + [name for name in projects if name != project_hint]
    else:
        search_order = list(projects.keys())

    # Search each project in order
    for project_name in search_order:
        task_store = projects[project_name]
        qdir = task_store.get("qdir")
        if not qdir:
            continue

        # Look up the task file in this project's queue
        task_file = _find_live_task_file(qdir, task_id)
        if task_file:
            # Read and return the task data
            data = _read_json_safe(task_file)
            if data:
                return data

    # Not found in any project
    raise TaskNotFoundError(f"Task '{task_id}' not found in any project")
