from flask import Blueprint, abort, jsonify, request

# Records a verdict for an Unmerged Branches card (see branch_verdicts.py for the store and why). This
# endpoint only RECORDS -- it never merges or discards. app.py imports this module to register the blueprint,
# so app.py's helpers are imported lazily inside the view (same circular-import rule as routes/pipeline_1_more.py).

branch_verdicts_bp = Blueprint("branch-verdicts-bp", __name__)


@branch_verdicts_bp.route("/api/git/branches/<path:branch>/verdict", methods=["POST"])
def api_git_record_branch_verdict(branch):
    from app import _invalidate_branch_cache, _run_git, get_active_repo_root, get_hub_data_provider, list_unmerged_branches, queue_dir
    import branch_verdicts as bv

    repo_root = get_active_repo_root()
    if not repo_root:
        abort(404, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")
    qdir = queue_dir()
    if not qdir:
        abort(404, description="no pipeline queue directory resolvable")

    # Only branches this process itself lists are accepted -- same gate as the merge/discard endpoints.
    match = next((b for b in list_unmerged_branches(force=True) if b["branch"] == branch), None)
    if not match:
        abort(404, description=f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch")

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"succeeded": False, "reason": "body must be a JSON object"}), 400
    verdict, reasons, source = body.get("verdict"), body.get("reasons", []), body.get("source", "manual")
    err = bv.validate_verdict_body(verdict, reasons, source)
    if err:
        return jsonify({"succeeded": False, "reason": err}), 400

    head_sha = match.get("headSha") or _run_git(["rev-parse", f"origin/{branch}"], repo_root).strip()
    claimed = body.get("sha")
    if claimed and claimed != head_sha:
        return jsonify({"succeeded": False, "reason": "verdict is for an older commit; the branch head has moved", "headSha": head_sha}), 409

    record, written = bv.record_verdict(qdir, branch, head_sha, verdict, reasons, source)
    if written:
        task_ids, hub_id = bv.resolve_owner(repo_root, match.get("mainBranch") or "master", branch, _run_git, qdir,
                                            get_hub_data_provider().hub_for_branch, match.get("taskId"))
        bv.write_task_log(qdir, task_ids, hub_id or (match.get("hub") or {}).get("id"), branch, verdict, reasons, source)
    _invalidate_branch_cache()
    return jsonify({"succeeded": True, "written": written, "headSha": head_sha, **bv.get_verdict(qdir, branch, head_sha)})
