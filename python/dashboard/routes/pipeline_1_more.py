from flask import Blueprint, abort, jsonify, request

from pathlib import Path
from datetime import datetime, timedelta, timezone
import json
import subprocess

# The app.py helpers these views call (ENV_FILE_PATH, _COMMIT_LOG_FIELD_SEP, _COMMIT_LOG_RECORD_SEP, _TASK_TRAILER_RE, _acquire_apply_lock, _archive_task_file, _find_task_log_anywhere, _find_task_record_anywhere, _hub_for_branch, _invalidate_branch_cache, _pipeline_running, _pipeline_stoppable, _release_apply_lock, _run_git, _start_pipeline, _stop_pipeline, _summarize_task_record, _sync_live_checkout, get_active_repo_root, get_pipeline_dir, list_unmerged_branches, logger, queue_dir, read_env_file, read_json_safe) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

pipeline_1_more_bp = Blueprint("pipeline-1-more-bp", __name__)

@pipeline_1_more_bp.route("/api/pipeline/status")
def api_pipeline_status():
    from app import ENV_FILE_PATH, _pipeline_running, _pipeline_stoppable, get_active_repo_root, read_env_file
    env = read_env_file(ENV_FILE_PATH)
    running = _pipeline_running()
    return jsonify({
        "activeRepoRoot": get_active_repo_root(),
        "running": running,
        # "stoppable" is looser than "running": true whenever a real daemon process
        # exists, even if every heartbeat says otherwise. The frontend gates its Stop
        # control on (running || stoppable) so a wrong "running" can never hide the only
        # way to stop a live pipeline from the UI (2026-08-30 incident).
        "stoppable": True if running else _pipeline_stoppable(),
        # Which job types actually run is no longer a bundled "mode" -- see /api/job-types.
        # includeApply/skipPush are the two run-specific safety toggles that used to be
        # implied by mode; they're per-repoRoot and persisted the same way REPO_ROOT is.
        "includeApply": env.get("AGENT_MANAGER_INCLUDE_APPLY", "false") == "true",
        "skipPush": env.get("AGENT_MANAGER_APPLY_SKIP_PUSH", "true") == "true",
    })


@pipeline_1_more_bp.route("/api/pipeline/start", methods=["POST"])
def api_pipeline_start():
    """The Project tab's entry point. includeApply controls whether apply-runner.ps1 runs
    at all (False = nothing can touch the target repo's files or git history, the safest
    setting). skipPush no longer prevents pushing -- src/apply-task.js's applyTask() now
    always pushes applied work regardless (an unpushed branch was a real durability risk,
    confirmed live 2026-08-16/17: ~300 were silently lost to a bulk local branch cleanup
    over time). What it still controls: whether the local checkout returns to main after
    each apply, or stays on the applied branch for inspection. Which job TYPES run is no
    longer chosen here -- see /api/job-types, a top-level setting independent of which
    project this starts against."""
    from app import _pipeline_running, _start_pipeline
    if _pipeline_running():
        return jsonify({"started": False, "reason": "a pipeline is already running -- stop it first"}), 409

    body = request.get_json(silent=True) or {}
    raw_path = (body.get("path") or "").strip()
    if not raw_path:
        abort(400, description="path is required")
    if not Path(raw_path).is_dir():
        abort(404, description="path does not exist")

    include_apply = bool(body.get("includeApply", False))
    skip_push = bool(body.get("skipPush", True))

    result = _start_pipeline(raw_path, include_apply, skip_push)
    status_code = 200 if result.get("started") else 501
    return jsonify(result), status_code


@pipeline_1_more_bp.route("/api/pipeline/stop", methods=["POST"])
def api_pipeline_stop():
    from app import _stop_pipeline
    body = request.get_json(silent=True) or {}
    force = bool(body.get("force", False))
    return jsonify({"stopped": _stop_pipeline(force=force)})


@pipeline_1_more_bp.route("/api/git/unmerged-branches")
def api_git_unmerged_branches():
    from app import list_unmerged_branches
    return jsonify(list_unmerged_branches(force=True))


@pipeline_1_more_bp.route("/api/git/branches/<path:branch>/commits")
def api_git_branch_commits(branch):
    """Full commit history for one pushed-but-unmerged branch, ahead of mainBranch --
    the Unmerged Branches tab previously only ever showed the tip commit's subject line,
    so selecting a multi-commit branch gave no way to see what it actually did short of
    a manual `git log` on the box running the dashboard."""
    from app import _COMMIT_LOG_FIELD_SEP, _COMMIT_LOG_RECORD_SEP, _TASK_TRAILER_RE, _find_task_log_anywhere, _find_task_record_anywhere, _hub_for_branch, _run_git, _summarize_task_record, get_active_repo_root, get_pipeline_dir, list_unmerged_branches
    repo_root = get_active_repo_root()
    if not repo_root:
        abort(404, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")
    repo_root = Path(repo_root)

    # Same "only act on what we ourselves already offered" gate api_git_merge_branch
    # uses -- never trust a caller-supplied branch string as a raw git ref beyond what
    # this process already enumerated itself.
    branches = list_unmerged_branches(force=False)
    match = next((b for b in branches if b["branch"] == branch), None)
    if not match:
        abort(404, description=f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch")

    main_branch = match["mainBranch"]
    fmt = _COMMIT_LOG_FIELD_SEP.join(["%H", "%an", "%aI", "%s", "%b"]) + _COMMIT_LOG_RECORD_SEP
    try:
        raw = _run_git(
            ["log", f"origin/{main_branch}..origin/{branch}", f"--format={fmt}"],
            repo_root,
        )
    except RuntimeError as e:
        abort(502, description=f"git log failed: {e}")

    commits = []
    for record in raw.split(_COMMIT_LOG_RECORD_SEP):
        if not record.strip("\n"):
            continue
        parts = record.lstrip("\n").split(_COMMIT_LOG_FIELD_SEP)
        if len(parts) != 5:
            continue
        sha, author, date, subject, body = parts
        commits.append({
            "sha": sha,
            "author": author,
            "date": date,
            "subject": subject,
            "body": body.strip("\n"),
        })

    # Join each commit back to its originating task's REAL pipeline log via the
    # `Task: <id>` trailer -- the commit body alone is just the final message, not the
    # plan / draft tiers / review votes / disposition the operator actually wants when
    # deciding whether to merge. Plus the owning coordinator hub, if any.
    pd = get_pipeline_dir()
    qdir = (pd / "queue") if pd else None
    commit_task_ids = []
    for c in commits:
        m = _TASK_TRAILER_RE.search(c["body"] or "")
        tid = m.group(1) if m else None
        c["taskId"] = tid
        c["task"] = None
        if tid:
            if tid not in commit_task_ids:
                commit_task_ids.append(tid)
            data, state = _find_task_record_anywhere(qdir, tid)
            if data is None:
                log_data = _find_task_log_anywhere(repo_root, tid)
                if log_data is not None:
                    data, state = log_data, "task-log"
            if data:
                c["task"] = _summarize_task_record(data, state)
    hub = _hub_for_branch(qdir, branch, commit_task_ids)
    return jsonify({"branch": branch, "mainBranch": main_branch, "commits": commits, "hub": hub})


@pipeline_1_more_bp.route("/api/git/branches/<path:branch>/merge", methods=["POST"])
def api_git_merge_branch(branch):
    from app import _acquire_apply_lock, _invalidate_branch_cache, _release_apply_lock, _run_git, _sync_live_checkout, get_active_repo_root, list_unmerged_branches, logger, queue_dir, read_json_safe
    repo_root = get_active_repo_root()
    if not repo_root:
        abort(404, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")
    repo_root = Path(repo_root)

    # Never trust a caller-supplied branch string as a raw git ref beyond what THIS
    # process already enumerated itself -- re-derive the current list (cheap: cached
    # unless stale) and require an exact match, the same "only act on what we ourselves
    # already offered" gate api_task_archive/api_task_requeue's state allowlists use.
    branches = list_unmerged_branches(force=True)
    match = next((b for b in branches if b["branch"] == branch), None)
    if not match:
        abort(404, description=f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch")

    # A sibling branch still unmerged in the SAME coordinator hub that this branch would
    # conflict with (2026-09-16: root-caused live -- 4 sub-tasks of one hub all edited the
    # same file, each independently branched off main, so each showed willConflict:False
    # against main alone; merging them one at a time hit a real conflict on the 2nd). The
    # real merge attempt below would fail the same way (or worse, silently ship whichever
    # side happened to be merged first without the other's change) -- block and name the
    # sibling(s) so the caller merges in dependency order (or combines them by hand) rather
    # than discovering this from an opaque git error. Checked BEFORE the hub-not-finished
    # gate below: a hub mid-decomposition is ALSO very often the exact shape with an
    # unmerged sibling still pending, and that gate's own `force` would otherwise mask
    # this one from ever being seen at all (only one gate's reason is ever returned per
    # request) -- surfacing the sibling-conflict warning first means a caller who force-
    # bypasses the hub gate still sees it, instead of being silently exposed to the same
    # conflict this whole check exists to catch.
    sibling_conflicts = [s for s in (match.get("hubSiblingConflicts") or [])
                          if any(b["branch"] == s for b in branches)]
    if sibling_conflicts and not (request.get_json(silent=True) or {}).get("force"):
        return jsonify({
            "succeeded": False,
            "reason": (
                f"'{branch}' would conflict with still-unmerged sibling branch(es) in the same "
                f"coordinator hub: {', '.join(sibling_conflicts)}. Merge the sibling(s) first (in "
                "dependency order), or resolve the overlap by hand, rather than merging this one "
                'independently. Re-send with {"force": true} only if you have already verified '
                "the resolution."
            ),
        }), 409

    # A branch owned by a coordinator hub that hasn't finished (a stacked file-decompose
    # branch still missing its wiring commit + integration-gate pass) is not safe to merge
    # -- doing so 404s the moved routes. Block it unless the caller explicitly forces.
    hub = match.get("hub")
    if hub and not hub.get("readyToMerge") and not (request.get_json(silent=True) or {}).get("force"):
        prog = hub.get("progress") or {}
        gate = (hub.get("integrationGate") or {}).get("status")
        return jsonify({
            "succeeded": False,
            "reason": (
                f"'{branch}' belongs to coordinator hub {hub.get('id')} which is not finished "
                f"({prog.get('done')}/{prog.get('total')} task(s) done"
                + (f", integration gate {gate}" if gate else "")
                + "). Merging now would ship an incomplete decomposition. Re-send with "
                '{"force": true} only if you have verified the branch is actually complete.'
            ),
        }), 409

    lock_fd = _acquire_apply_lock()
    if lock_fd is None:
        abort(409, description="the pipeline is mid-apply right now -- try again in a few seconds")

    main_branch = match["mainBranch"]
    try:
        _run_git(["fetch", "origin"], repo_root)
        _run_git(["checkout", main_branch], repo_root)
        _run_git(["reset", "--hard", f"origin/{main_branch}"], repo_root)
        try:
            _run_git(["merge", "--no-ff", f"origin/{branch}", "-m", f"Merge {match['title']} (via dashboard)"], repo_root)
        except RuntimeError as merge_err:
            subprocess.run(["git", "merge", "--abort"], cwd=str(repo_root), capture_output=True, timeout=15)
            # match['willConflict']/['conflictFiles'] came from list_unmerged_branches's
            # own merge-tree preview a moment ago (same request, force-refreshed above) --
            # if it already predicted this exact outcome, say so plainly instead of
            # surfacing raw git stderr. Confirmed live 2026-08-18: an add/add conflict
            # between two independently-drafted candidate docs produced exactly this kind
            # of opaque failure with no indication of WHICH files or WHY.
            if match.get("willConflict") and match.get("conflictFiles"):
                files = ", ".join(match["conflictFiles"])
                raise RuntimeError(
                    f"conflicts with {main_branch} on: {files} -- this was flagged before you clicked merge; "
                    f"resolve by hand (e.g. combine both versions) rather than retrying, retrying will fail the same way"
                ) from merge_err
            raise merge_err
        _run_git(["push", "origin", main_branch], repo_root)
        try:
            _run_git(["push", "origin", "--delete", branch], repo_root)
        except RuntimeError as e:
            # Non-fatal -- the merge to main already succeeded and is the part that
            # matters; a leftover now-fully-merged remote branch is harmless clutter
            # (next list will filter it out via the ahead==0 check) rather than a real
            # failure worth reporting as one.
            logger.warning("Non-fatal: could not delete remote branch %r (repo: %s): %s", branch, repo_root, e)
    except RuntimeError as e:
        return jsonify({"succeeded": False, "reason": str(e)}), 500
    finally:
        _release_apply_lock(lock_fd)

    _invalidate_branch_cache()
    live_sync = _sync_live_checkout(main_branch)

    # Stamp mergedAt on the task record once its branch is actually merged (2026-08-22,
    # Grimmethy: "some way to prioritize what order adhoc tasks get completed in. Those
    # with dependencies on new adhoc tasks are absolutely going to need to be done after
    # the dependency is completed") -- this is the real "is this dependency satisfied"
    # signal task-sources.js's nextAdhocTask() checks before letting a dependent task
    # claim. Reaching queue/done/ alone isn't enough: a task there is only pushed to its
    # OWN branch, not merged, and every adhoc draft's git worktree starts from
    # origin/<mainBranch> -- a dependency's fix isn't actually visible to a dependent
    # task's fresh checkout until it's merged, confirmed live by the exact failure this
    # feature exists to prevent (a dependent task's diff going stale against code the
    # dependency hadn't landed yet). Best-effort: a task record not found (already
    # archived, or this merge came from some other source than the normal apply flow)
    # must never fail the merge itself, which already fully succeeded above.
    qdir = queue_dir()
    if qdir:
        task_id = branch.removeprefix("agent/")
        for candidate in (qdir / "done" / f"{task_id}.json", qdir / "done" / "_archived_no_action" / f"{task_id}.json"):
            if candidate.is_file():
                data = read_json_safe(candidate)
                if data is not None:
                    now_iso = datetime.now(timezone.utc).isoformat()
                    data["mergedAt"] = now_iso
                    # Close the task log with a terminal disposition event (see
                    # src/task-disposition.js) -- `mergedAt` alone is a field the dependency
                    # gate reads; an update audit reads the history, which used to stop at
                    # `applied`.
                    if data.get("terminalDisposition") != "merged":
                        hist = data.get("history")
                        if not isinstance(hist, list):
                            hist = data["history"] = []
                        hist.append({
                            "stage": "merged",
                            "at": now_iso,
                            "detail": f"merged into {main_branch} via the dashboard Unmerged Branches tab",
                        })
                        data["terminalDisposition"] = "merged"
                    try:
                        candidate.write_text(json.dumps(data, indent=2), encoding="utf-8")
                    except OSError as exc:
                        logger.error("Failed to persist merge-state for branch %r to %s: %s", branch, candidate, exc)
                        raise
                break

        # Close out the LOCAL task log too (src/task-log-store.js), not just the queue/
        # working copy above -- that file is gitignored and gets archived/pruned, while
        # task-logs/<id>.json is a durable local snapshot that survives it, and this is the
        # one moment (the task's branch just landed on main) its own log can record that
        # fact. RE-EVALUATED 2026-09-15 (Grimmethy, .gitignore's own comment on
        # task-logs/): this repo is public and the log retains a task's rawText/
        # implementResponse/planResponse verbatim -- for a brain_dump-derived task that is
        # the user's own free-typed personal/business note content, so this file is no
        # longer committed/pushed, updated on disk only. Best-effort: a task not authored
        # through apply-task.js (so it never got a task-logs/ entry in the first place) is
        # a normal, expected case, not an error.
        task_log_path = repo_root / "task-logs" / f"{task_id}.json"
        if task_log_path.is_file():
            log_data = read_json_safe(task_log_path)
            if log_data is not None and log_data.get("terminalDisposition") != "merged":
                merge_iso = datetime.now(timezone.utc).isoformat()
                hist = log_data.get("history")
                if not isinstance(hist, list):
                    hist = log_data["history"] = []
                hist.append({
                    "stage": "merged",
                    "at": merge_iso,
                    "detail": f"merged into {main_branch} via the dashboard Unmerged Branches tab",
                })
                log_data["terminalDisposition"] = "merged"
                try:
                    task_log_path.write_text(json.dumps(log_data, indent=2) + "\n", encoding="utf-8")
                except OSError as exc:
                    logger.warning("Non-fatal: could not record merge disposition in task-logs/%s.json: %s", task_id, exc)

    return jsonify({"succeeded": True, "branch": branch, "mainBranch": main_branch, "liveSync": live_sync})


@pipeline_1_more_bp.route("/api/git/branches/<path:branch>/discard", methods=["POST"])
def api_git_discard_branch(branch):
    """The Unmerged Branches tab's other action (2026-09-08, Grimmethy: "If we aren't
    merging it we definitely need to archive it. It's still visible in my unmerged
    branches tab... leaves us open to accidentally opening it back up in the future.") --
    root-caused live via change-review-fix-ac-1: list_unmerged_branches is a pure git scan
    (refs/remotes/origin/agent/* with ahead>0 vs. main), with zero awareness of task
    disposition -- archiving a task record alone (api_task_archive) never removes its
    branch from this list. This is the other half api_git_merge_branch's own delete-on-
    success step never covers: a branch you've decided NOT to merge, which needs its
    remote ref actually deleted plus its task archived, not just hidden.

    Mirrors api_git_merge_branch for the parts that overlap (the same-list re-validation
    gate, the apply-lock, the two-location task lookup) minus the merge/checkout/push-to-
    main steps this doesn't need."""
    from app import _acquire_apply_lock, _archive_task_file, _invalidate_branch_cache, _release_apply_lock, _run_git, get_active_repo_root, list_unmerged_branches, logger, queue_dir, read_json_safe
    repo_root = get_active_repo_root()
    if not repo_root:
        abort(404, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")
    repo_root = Path(repo_root)

    # Same "only act on what we ourselves already offered" gate api_git_merge_branch/
    # api_task_archive/api_task_requeue all already use.
    branches = list_unmerged_branches(force=True)
    match = next((b for b in branches if b["branch"] == branch), None)
    if not match:
        abort(404, description=f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch")

    lock_fd = _acquire_apply_lock()
    if lock_fd is None:
        abort(409, description="the pipeline is mid-apply right now -- try again in a few seconds")

    try:
        try:
            _run_git(["push", "origin", "--delete", branch], repo_root)
        except RuntimeError as e:
            # A delete failing because the ref is already gone (deleted by hand, or a
            # duplicate click) means the actual goal -- this branch not existing on origin
            # -- is already achieved; only a REAL git failure (auth, network, etc.) should
            # surface as an error. Same "remote ref does not exist" shape git itself uses
            # for this case.
            if "remote ref does not exist" not in str(e) and "unable to delete" not in str(e).lower():
                raise
    except RuntimeError as e:
        return jsonify({"succeeded": False, "reason": str(e)}), 500
    finally:
        _release_apply_lock(lock_fd)

    # Archive the matching task record, same 2-location lookup api_git_merge_branch's own
    # mergedAt-stamping step already does. Best-effort: no task record found (a branch
    # pushed with nothing matching in done/) is not an error, just nothing to reconcile;
    # already-archived (a human archived it by hand first, or a duplicate click) is a
    # silent no-op, not a 409 -- the branch delete above is the part that mattered.
    task_archived = False
    qdir = queue_dir()
    if qdir:
        task_id = branch.removeprefix("agent/")
        done_path = qdir / "done" / f"{task_id}.json"
        archived_path = qdir / "done" / "_archived_no_action" / f"{task_id}.json"
        if done_path.is_file():
            data = read_json_safe(done_path)
            if data is not None:
                now_iso = datetime.now(timezone.utc).isoformat()
                if data.get("terminalDisposition") != "dismissed":
                    hist = data.get("history")
                    if not isinstance(hist, list):
                        hist = data["history"] = []
                    hist.append({
                        "stage": "dismissed",
                        "at": now_iso,
                        "detail": f"branch {branch} discarded via the dashboard Unmerged Branches tab -- not merging this",
                    })
                    data["terminalDisposition"] = "dismissed"
                try:
                    done_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
                except OSError as exc:
                    logger.error("Failed to persist dismissed-state for branch %r to %s: %s", branch, done_path, exc)
                    raise
            try:
                _archive_task_file(qdir, done_path)
                task_archived = True
            except FileExistsError:
                pass
        elif archived_path.is_file():
            task_archived = True  # already archived (e.g. by hand) -- nothing more to do

    _invalidate_branch_cache()
    return jsonify({"succeeded": True, "branch": branch, "taskArchived": task_archived})
