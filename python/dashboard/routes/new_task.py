"""POST /api/new-task: files ONE adhoc task into a chosen registered project's queue.

The caller names a project by its registry label only. The pipeline dir comes from the
registry entry, never from request input, and the active project is refused outright.
The write is done by src/queue-adhoc-submit.js, run with an argv list (no shell).
"""
import html
import json
import os
import subprocess

from flask import Blueprint, abort, jsonify, request

# Helpers come from app.py via lazy imports inside the view (same pattern as routes/brain_dump.py).

new_task_bp = Blueprint("new-task-bp", __name__)

SUBMIT_TIMEOUT_SECONDS = 30


def _clean(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _same_dir(a, b) -> bool:
    return bool(a) and bool(b) and os.path.realpath(str(a)) == os.path.realpath(str(b))


@new_task_bp.route("/api/new-task", methods=["POST"])
def api_new_task():
    from app import PACKAGE_ROOT, get_active_repo_root, read_project_registry

    body = request.get_json(silent=True) or {}
    title = _clean(body.get("title"))
    text = _clean(body.get("text"))
    raised_from = _clean(body.get("raisedFrom"))
    repo = _clean(body.get("repo"))
    premium = body.get("premium") is True
    if not title or not text:
        abort(400, description="title and text are required")
    if not repo:
        abort(400, description="repo must name a registered project")

    matches = [
        e for e in read_project_registry()
        if isinstance(e, dict) and e.get("label") == repo and e.get("repoRoot") and e.get("pipelineDir")
    ]
    if len(matches) != 1:
        abort(400, description="repo must be exactly one registered project label")
    entry = matches[0]

    if _same_dir(entry["repoRoot"], get_active_repo_root()):
        abort(400, description="the active project is not a valid target for a new task")

    payload = {
        "title": title,
        "promptContext": {"text": text, "source": "new-task-form"},
        "premium": premium,
        "pipelineDir": str(entry["pipelineDir"]),
    }
    if raised_from:
        payload["raisedFrom"] = raised_from

    try:
        cp = subprocess.run(
            ["node", str(PACKAGE_ROOT / "src" / "queue-adhoc-submit.js"), json.dumps(payload)],
            capture_output=True, text=True, timeout=SUBMIT_TIMEOUT_SECONDS, cwd=str(PACKAGE_ROOT), shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        abort(500, description="task submit did not complete")
    if cp.returncode != 0:
        abort(500, description="task submit failed")
    try:
        result = json.loads((cp.stdout or "").strip().splitlines()[-1])
        task_id = str(result["id"])
        file_name = os.path.basename(str(result["filePath"]))
    except (ValueError, KeyError, IndexError, TypeError):
        abort(500, description="task submit returned an unexpected result")

    return jsonify({
        "id": html.escape(task_id, quote=True),
        "link": html.escape(f"/queue/adhoc/{file_name}", quote=True),
        "title": html.escape(title, quote=True),
    })
