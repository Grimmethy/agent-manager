"""Read-only listing of queued tasks in every registered pipeline except the active one.

Request-driven only: no timer, thread, poll or write. Reuses branch_projects.registered_projects() and
branch_projects.resolve_scope() for the project registry, so no queue-directory helper is duplicated here.
"""
import json

from flask import Blueprint, jsonify

task_anywhere_other_pipelines_bp = Blueprint("task-anywhere-other-pipelines-bp", __name__)

# Queue states that hold tasks waiting to be claimed.
QUEUED_STATES = ("pending", "adhoc")


@task_anywhere_other_pipelines_bp.route("/api/task-anywhere/other-pipelines/queued", methods=["GET"])
def api_task_anywhere_other_pipelines_queued():
    """Queued tasks of every registered pipeline other than the active one.

    Answers {"tasks": [{"id", "pipelinePath", "premiumPriority"}, ...]}. Files are opened read-only.
    """
    from app import get_active_repo_root
    import branch_projects

    active_root = get_active_repo_root()
    entries = []
    for p in branch_projects.registered_projects(active_root):
        if p["active"]:
            continue
        try:
            scope = branch_projects.resolve_scope(p["repoRoot"], active_root)
        except LookupError:
            continue
        if not scope:
            continue
        qdir = scope["qdir"]
        for state in QUEUED_STATES:
            state_dir = qdir / state
            if not state_dir.is_dir():
                continue
            for path in sorted(state_dir.glob("*.json")):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if not isinstance(data, dict):
                    continue
                entries.append({
                    "id": data.get("id") or path.stem,
                    "pipelinePath": p["pipelineDir"],
                    "premiumPriority": data.get("premiumPriority") is True,
                })
    return jsonify({"tasks": entries})
