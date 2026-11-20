"""Amend a blocked / needs-clarification task, and insert a piece into a coordinating hub.

Routes:
  POST /api/task/<state>/<task_id>/amend   (state: blocked | needs-clarification)
  POST /api/hub/<hub_id>/insert-piece      (exactly one of before / after)
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

from flask import Blueprint, jsonify, request

task_amend_bp = Blueprint("task-amend-bp", __name__)

AMEND_STATES = ("blocked", "needs-clarification")
REPO_ROOT = Path(__file__).resolve().parents[3]
HUB_ADD_PIECE = REPO_ROOT / "src" / "hub-add-piece.js"


def _pipeline_queue_dir():
    base = os.environ.get("AGENT_MANAGER_PIPELINE_DIR", "").strip()
    if not base:
        return None
    return Path(base) / "queue"


def _files_line(files):
    return "Files: " + ", ".join(files)


def _apply_amendment(record, raw_text, files, reason):
    pc = record.setdefault("promptContext", {})
    text = pc.get("rawText", "")
    if raw_text:
        text = raw_text
    if files:
        lines = [ln for ln in text.splitlines() if not ln.lstrip().lower().startswith("files:")]
        text = "\n".join(lines).rstrip() + "\n" + _files_line(files)
    pc["rawText"] = text
    # Bypass the repeated-blocker guard for THIS task only (keyed on this record, not on blocker text).
    record["blockedReason"] = None
    record.pop("priorRejectionFeedback", None)
    record["localRejectCount"] = 0
    history = record.setdefault("history", [])
    history.append({"stage": "amended", "reason": reason, "files": files or None})
    return record


@task_amend_bp.route("/api/task/<state>/<task_id>/amend", methods=["POST"])
def api_task_amend(state, task_id):
    if state not in AMEND_STATES:
        return jsonify({"ok": False, "error": f"amend is only allowed for blocked or needs-clarification, not {state}"}), 400
    body = request.get_json(silent=True) or {}
    reason = str(body.get("reason") or "").strip()
    raw_text = body.get("rawText")
    files = body.get("files")
    if not reason:
        return jsonify({"ok": False, "error": "reason is required"}), 400
    if not raw_text and not files:
        return jsonify({"ok": False, "error": "give at least one of rawText or files"}), 400
    if files is not None and not isinstance(files, list):
        return jsonify({"ok": False, "error": "files must be a list"}), 400

    qdir = _pipeline_queue_dir()
    if qdir is None:
        return jsonify({"ok": False, "error": "AGENT_MANAGER_PIPELINE_DIR is not set"}), 500
    record_file = qdir / state / f"{task_id}.json"
    if not record_file.exists():
        return jsonify({"ok": False, "error": f"no task '{task_id}' in {state}"}), 404
    record = json.loads(record_file.read_text(encoding="utf-8"))
    _apply_amendment(record, str(raw_text).strip() if raw_text else None, files, reason)
    tmp = record_file.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, record_file)

    # Delegate the requeue to the existing view (same request context).
    from routes.task import api_task_requeue
    return api_task_requeue(state, task_id)


@task_amend_bp.route("/api/hub/<hub_id>/insert-piece", methods=["POST"])
def api_hub_insert_piece(hub_id):
    body = request.get_json(silent=True) or {}
    before = body.get("before")
    after = body.get("after")
    if bool(before) == bool(after):
        return jsonify({"ok": False, "error": "give exactly one of before or after"}), 400
    title = str(body.get("title") or "").strip()
    raw_text = str(body.get("rawText") or "").strip()
    if not title or not raw_text:
        return jsonify({"ok": False, "error": "title and rawText are required"}), 400

    pipeline_dir = os.environ.get("AGENT_MANAGER_PIPELINE_DIR", "").strip()
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump({"rawText": raw_text}, fh)
        pc_file = fh.name
    args = ["node", str(HUB_ADD_PIECE), hub_id, "--title", title, "--prompt-context-file", pc_file,
            "--who", "dashboard"]
    args += ["--before", str(before)] if before else ["--after", str(after)]
    if pipeline_dir:
        args += ["--pipeline-dir", pipeline_dir]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=60)
    finally:
        try:
            os.unlink(pc_file)
        except OSError:
            pass
    try:
        result = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return jsonify({"ok": False, "error": (proc.stderr or proc.stdout or "no output").strip()}), 409
    if result.get("ok"):
        return jsonify(result), 200
    err = str(result.get("error") or "")
    status = 404 if "no coordinating hub" in err else 409
    return jsonify(result), status
