"""Resolve a task_id to the project that owns it.

This module provides a single public function, ``resolve_task_project``, which
maps a task identifier to the queue key (project label) of the project that
owns it. It is used by the requeue endpoint to determine the destination
project for a task being moved.

The lookup works by:
1. Finding the task record in any queue location (active, archived, etc.)
2. Reading the ``project`` field from the task record
3. Returning that project label as the queue key

If the task record has no ``project`` field, the task is considered to belong
to the active project, and the active project's label is returned. If the task
cannot be found at all, or no project can be determined, a ``ValueError`` is
raised.
"""


def resolve_task_project(task_id: str) -> str:
    """Determine which project owns a given task.

    Looks up the task record in any queue location (active, archived,
    superseded, or per-worker drafting) and returns the project label stored
    on the task. If the task has no ``project`` field, it is considered to
    belong to the active project and the active project's label is returned.

    Args:
        task_id: The task identifier to look up.

    Returns:
        The project label (queue key) of the owning project.

    Raises:
        ValueError: If the task cannot be found in any queue location, or if
            no project can be determined for the task.
    """
    from app import (
        _find_task_record_anywhere,
        _queue_dir_for_project_label,
        get_active_repo_root,
        queue_dir,
        read_project_registry,
    )
    from branch_projects import registered_projects

    qdir = queue_dir()
    if not qdir:
        raise ValueError(f"Cannot resolve project for task {task_id!r}: no active queue directory")

    task_data, state = _find_task_record_anywhere(qdir, task_id)

    if task_data is None:
        raise ValueError(f"Task {task_id!r} not found in any queue location")

    # Check if the task has an explicit project field
    project_label = task_data.get("project")

    if not project_label:
        # No explicit project: task belongs to the active project
        # Get the active project's label from the registry
        active_root = get_active_repo_root()
        if not active_root:
            raise ValueError(f"Cannot resolve project for task {task_id!r}: no active project")

        projects = registered_projects(active_root)
        active_project = next((p for p in projects if p.get("active")), None)

        if not active_project:
            raise ValueError(f"Cannot resolve project for task {task_id!r}: active project not found in registry")

        project_label = active_project.get("label")
        if not project_label:
            raise ValueError(f"Cannot resolve project for task {task_id!r}: active project has no label")

    # Verify the project label is valid by checking if it has a queue directory
    queue_dir_path = _queue_dir_for_project_label(project_label)
    if queue_dir_path is None:
        raise ValueError(
            f"Cannot resolve project for task {task_id!r}: "
            f"project {project_label!r} has no valid queue directory"
        )

    return project_label
