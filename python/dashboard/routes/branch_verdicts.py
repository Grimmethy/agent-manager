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

    # Optional project (the card's repoRoot, query string or body): record for THAT project's branch, in its own queue. Absent = the active project, as
    # before; a given-but-unknown project is a 404, never a fallback to the active one.
    import branch_projects
    pre = request.get_json(silent=True)
    try:
        scope = branch_projects.resolve_scope(request.args.get("project") or (pre.get("project") if isinstance(pre, dict) else None), str(repo_root))
    except LookupError as e:
        abort(404, description=str(e))
    if scope:
        from pathlib import Path
        qdir, repo_root = scope["qdir"], Path(scope["repoPath"])

    # Only branches this process itself lists are accepted -- same gate as the merge/discard endpoints (another project: its cached list).
    if scope:
        real, match = branch_projects.find_other_project_branch(scope["repoRoot"], branch)
    else:
        match = next((b for b in list_unmerged_branches(force=False) if b["branch"] == branch), None)
    if not match:
        # Check if the branch exists on origin (held hub branch or listing hasn't caught up yet)
        try:
            _run_git(["rev-parse", "--verify", f"origin/{branch}"], repo_root)
            # Branch exists on origin, store as pending
            import branch_verdicts_pending as bvp
            head_sha = _run_git(["rev-parse", f"origin/{branch}"], repo_root).strip()
            bvp.store_pending_verdict(qdir, branch, head_sha, verdict, reasons, source)
            return jsonify({"succeeded": True, "pending": True, "headSha": head_sha}), 200
        except (RuntimeError, OSError):
            # Branch doesn't exist on origin, 404 as before
            abort(404, description=f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch")

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"succeeded": False, "reason": "body must be a JSON object"}), 400
    verdict, reasons, source = body.get("verdict"), body.get("reasons", []), body.get("source", "manual")
    err = bv.validate_verdict_body(verdict, reasons, source)
    if err:
        return jsonify({"succeeded": False, "reason": err}), 400

    # A stale cached card can only make this a spurious 409 (re-verify) or bind the verdict to the older commit the caller named, which then reads back stale -- never a wrong
    # verdict for a commit nobody checked, so the cached headSha (with the rev-parse fallback) is kept.
    head_sha = match.get("headSha") or _run_git(["rev-parse", f"origin/{branch}"], repo_root).strip()
    claimed = body.get("sha")
    if claimed and claimed != head_sha:
        return jsonify({"succeeded": False, "reason": "verdict is for an older commit; the branch head has moved", "headSha": head_sha}), 409

    record, written = bv.record_verdict(qdir, branch, head_sha, verdict, reasons, source)
    if written:
        task_ids, hub_id = bv.resolve_owner(repo_root, match.get("mainBranch") or "master", branch, _run_git, qdir,
                                            get_hub_data_provider().hub_for_branch, match.get("taskId"))
        bv.write_task_log(qdir, task_ids, hub_id or (match.get("hub") or {}).get("id"), branch, verdict, reasons, source, head_sha)
    if scope:
        branch_projects.after_action(scope)  # recompute that project's list so its card carries the verdict
    else:
        _invalidate_branch_cache(refetch=False)  # a verdict moves no remote ref: drop the cached cards (they carry the verdict) but skip the fetch
    return jsonify({"succeeded": True, "written": written, "headSha": head_sha, **bv.get_verdict(qdir, branch, head_sha)})
