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

import os
from pathlib import Path

from app_catalog_helpers import _find_live_task_file
from app_settings_helpers import read_json_safe


class TaskNotFoundError(Exception):
    """Raised when a task ID is not found in any project's queue."""
    pass


def resolve_task_across_projects(task_id, project_hint, projects):
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
    # Determine search order: hint first (if provided), then active project (if no hint),
    # then all other projects. This matches the behavior of branch_projects.resolve_scope
    # and _qdir_for_request in routes/task.py.
    if project_hint:
        # Use the hint if provided and if it's a registered project
        if project_hint in projects:
            search_order = [project_hint] + [name for name in projects if name != project_hint]
        else:
            # Hint is not a registered project -- fall back to active project logic
            search_order = _search_order_without_hint(projects)
    else:
        search_order = _search_order_without_hint(projects)

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
            data = read_json_safe(task_file)
            if data:
                return data

    # Not found in any project
    raise TaskNotFoundError(f"Task '{task_id}' not found in any project")


def _search_order_without_hint(projects):
    """Determine search order when no project hint is given.

    Falls back to the active project first, then all others. The active project is
    determined by importing get_active_repo_root() from app.py and matching it against
    each project's repoRoot.
    """
    from app import get_active_repo_root

    active_root = get_active_repo_root()
    active_real = os.path.realpath(active_root) if active_root else None

    active_project_name = None
    for name, store in projects.items():
        repo_root = store.get("repoRoot", "")
        if os.path.realpath(repo_root) == active_real:
            active_project_name = name
            break

    if active_project_name:
        return [active_project_name] + [name for name in projects if name != active_project_name]
    else:
        # No active project found, just search all
        return list(projects.keys())
