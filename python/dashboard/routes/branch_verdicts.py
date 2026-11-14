from flask import Blueprint, abort, jsonify, request

import main_push_gate

# Records a verdict for an Unmerged Branches card (see branch_verdicts.py for the store and why). This
# endpoint only RECORDS -- it never merges or discards. app.py imports this module to register the blueprint,
# so app.py's helpers are imported lazily inside the view (same circular-import rule as routes/pipeline_1_more.py).

branch_verdicts_bp = main_push_gate.attach(Blueprint("branch-verdicts-bp", __name__))  # attach: the main-push gate runs before the merge routes


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

    # Parse and validate the body BEFORE the unlisted-branch check so the pending path has real values
    # and bogus bodies get the normal 400 instead of an UnboundLocalError.
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"succeeded": False, "reason": "body must be a JSON object"}), 400
    verdict, reasons, source = body.get("verdict"), body.get("reasons") or [], body.get("source", "manual")
    err = bv.validate_verdict_body(verdict, reasons, source)
    if err:
        return jsonify({"succeeded": False, "reason": err}), 400

    # Only branches this process itself lists are accepted -- same gate as the merge/discard endpoints (another project: its cached list).
    if scope:
        real, match = branch_projects.find_or_refresh_other_project_branch(scope, branch)
    else:
        match = next((b for b in list_unmerged_branches(force=False) if b["branch"] == branch), None)
    if not match:
        # Check if the branch exists on origin (held hub branch or listing hasn't caught up yet)
        try:
            _run_git(["rev-parse", "--verify", f"origin/{branch}"], repo_root)
            # Branch exists on origin, store as pending
            import branch_verdicts_pending as bvp
            head_sha = _run_git(["rev-parse", f"origin/{branch}"], repo_root).strip()
            claimed = body.get("sha")
            if claimed and claimed != head_sha:
                return jsonify({"succeeded": False, "reason": "verdict is for an older commit; the branch head has moved", "headSha": head_sha}), 409
            bvp.store_pending_verdict(qdir, branch, head_sha, verdict, reasons, source)
            return jsonify({"succeeded": True, "pending": True, "headSha": head_sha}), 200
        except (RuntimeError, OSError):
            # Branch doesn't exist on origin, 404 as before
            abort(404, description=f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch")

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
        # Verdicts don't change branch existence, so patch the cached row in place and mark it stale
        # for the next background refresh. Merge/discard still call after_action() to recompute.
        err = branch_projects.patch_verdict_cache(scope, branch, verdict, reasons, head_sha, record)
        if err:
            # Log and continue — the verdict was still recorded, just the cache patch failed
            import logging
            logging.getLogger("branch-verdicts").warning(f"Failed to patch verdict cache for {branch}: {err}")
    else:
        _invalidate_branch_cache(refetch=False)  # a verdict moves no remote ref: drop the cached cards (they carry the verdict) but skip the fetch
    return jsonify({"succeeded": True, "written": written, "headSha": head_sha, **bv.get_verdict(qdir, branch, head_sha)})


@branch_verdicts_bp.route("/api/git/branches/verdicts", methods=["POST"])
def api_git_record_branch_verdicts_batch():
    """Batch verdict endpoint: record multiple verdicts in one request.

    Takes {"verdicts": [{"branch": ..., "project": ..., "sha": ..., "verdict": ..., "reasons": [...], "source": ...}, ...]}.
    Each item is validated and processed independently; one bad item does not fail the batch.
    Returns {"results": [{"branch": ..., "succeeded": ..., "reason": ...}, ...]}.
    """
    import branch_projects
    import branch_verdicts as bv
    from app import _invalidate_branch_cache, _run_git, get_active_repo_root, get_hub_data_provider, list_unmerged_branches, queue_dir

    repo_root = get_active_repo_root()
    if not repo_root:
        abort(404, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")
    qdir = queue_dir()
    if not qdir:
        abort(404, description="no pipeline queue directory resolvable")

    body = request.get_json(silent=True)
    if not isinstance(body, dict) or "verdicts" not in body or not isinstance(body["verdicts"], list):
        return jsonify({"succeeded": False, "reason": "body must be a JSON object with a 'verdicts' array"}), 400

    items = body["verdicts"]
    if not items:
        return jsonify({"results": []}), 200

    results = []
    touched_active = False  # an ACTIVE-project verdict was recorded or stored as pending: its cached cards must be dropped once, after the loop
    for item in items:
        if not isinstance(item, dict):
            results.append({"branch": None, "succeeded": False, "reason": "item must be a JSON object"})
            continue

        branch = item.get("branch")
        if not branch:
            results.append({"branch": None, "succeeded": False, "reason": "missing 'branch'"})
            continue

        verdict = item.get("verdict")
        reasons = item.get("reasons") or []
        source = item.get("source", "manual")
        claimed_sha = item.get("sha")
        item_project = item.get("project")

        # Resolve scope for this item
        try:
            scope = branch_projects.resolve_scope(item_project or request.args.get("project"), str(repo_root))
        except LookupError as e:
            results.append({"branch": branch, "succeeded": False, "reason": str(e)})
            continue

        item_qdir = qdir
        item_repo_root = repo_root
        if scope:
            from pathlib import Path
            item_qdir, item_repo_root = scope["qdir"], Path(scope["repoRoot"])

        # Validate the verdict body
        err = bv.validate_verdict_body(verdict, reasons, source)
        if err:
            results.append({"branch": branch, "succeeded": False, "reason": err})
            continue

        # Check if the branch exists in the cached list
        if scope:
            real, match = branch_projects.find_or_refresh_other_project_branch(scope, branch)
        else:
            match = next((b for b in list_unmerged_branches(force=False) if b["branch"] == branch), None)

        if not match:
            # Check if the branch exists on origin
            try:
                _run_git(["rev-parse", "--verify", f"origin/{branch}"], item_repo_root)
                import branch_verdicts_pending as bvp
                head_sha = _run_git(["rev-parse", f"origin/{branch}"], item_repo_root).strip()
                if claimed_sha and claimed_sha != head_sha:
                    results.append({"branch": branch, "succeeded": False, "reason": "verdict is for an older commit; the branch head has moved", "headSha": head_sha})
                    continue
                bvp.store_pending_verdict(item_qdir, branch, head_sha, verdict, reasons, source)
                touched_active = touched_active or not scope
                results.append({"branch": branch, "succeeded": True, "pending": True, "headSha": head_sha})
                continue
            except (RuntimeError, OSError):
                results.append({"branch": branch, "succeeded": False, "reason": f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch"})
                continue

        # Branch found in cached list
        head_sha = match.get("headSha") or _run_git(["rev-parse", f"origin/{branch}"], item_repo_root).strip()
        if claimed_sha and claimed_sha != head_sha:
            results.append({"branch": branch, "succeeded": False, "reason": "verdict is for an older commit; the branch head has moved", "headSha": head_sha})
            continue

        # Record the verdict
        record, written = bv.record_verdict(item_qdir, branch, head_sha, verdict, reasons, source)
        if written:
            task_ids, hub_id = bv.resolve_owner(item_repo_root, match.get("mainBranch") or "master", branch, _run_git, item_qdir,
                                                get_hub_data_provider().hub_for_branch, match.get("taskId"))
            bv.write_task_log(item_qdir, task_ids, hub_id or (match.get("hub") or {}).get("id"), branch, verdict, reasons, source, head_sha)

        # Patch the cache for non-active projects
        if scope:
            cache_err = branch_projects.patch_verdict_cache(scope, branch, verdict, reasons, head_sha, record)
            if cache_err:
                import logging
                logging.getLogger("branch-verdicts").warning(f"Failed to patch verdict cache for {branch}: {cache_err}")

        touched_active = touched_active or (written and not scope)
        results.append({"branch": branch, "succeeded": True, "written": written, "headSha": head_sha})

    if touched_active:
        # Same as the single-verdict route: a verdict moves no remote ref, so drop the cached cards (they carry the verdict) but skip the fetch.
        _invalidate_branch_cache(refetch=False)
    return jsonify({"results": results}), 200
