from flask import Blueprint, abort, jsonify, request, session

from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import os
import subprocess

# The app.py helpers these views call (ENV_FILE_PATH, PACKAGE_ROOT, QUEUE_STATES, SRC_DIR, _archive_task_file, _call_discuss, _discuss_provider_args, _files_touched_for, _incoming_task_links, _outgoing_task_links, _record_manual_requeue, _repeated_blocker_match, _task_cost_summary, _task_input_summary, _work_log_for, get_active_grep_dirs, get_active_repo_root, get_pipeline_dir, instances_dir, logger, queue_dir, read_env_file, read_json_safe) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

task_bp = Blueprint("task-bp", __name__)

# 2026-09-17, root-caused live: /resolve and /answer below both move a held task from
# queue/needs-clarification/ into queue/adhoc/ for "a fresh draft pass", but neither ever
# clears the STALE blockedReason/blockedStage/status/localRejectCount fields the task
# already carried from BEFORE it was escalated (escalation only ever ADDS a
# needsClarification field + a needs-clarification history event -- it never clears the
# blocked-stage fields underneath). Landing back in adhoc/ still reading
# status:'blocked', blockedStage:'review', localRejectCount:2 (already AT the retry cap)
# makes the task indistinguishable from an already-exhausted blocked task: reject-retry-
# check.js's own in-place adhoc/ scan only picks up status:'blocked' entries at all, and
# once picked up, alreadyEscalatedSinceLastReadmission() (src/reject-retry-check.js)
# correctly sees the OLD needs-clarification history event with nothing after it proving
# a fresh cycle began, and refuses to touch it again -- so answering/resolving a task
# this way silently produces a permanently inert file instead of the "fresh draft pass"
# both routes' own docstrings/history text promise. Confirmed live: 3 real tasks
# answered via /answer during a 2026-09-17 sweep sat completely untouched afterward,
# each still showing its ORIGINAL pre-escalation blockedReason and a retry count already
# at cap.
#
# Mirrors src/reject-retry-check.js's READMIT_CLEAN_SLATE_FIELDS -- kept in sync by
# convention (no shared source of truth across the JS/Python boundary; see that
# constant's own comment). `status` is handled separately since the JS list never
# includes it (JS-side requeues always explicitly flip status themselves).
_NC_READMIT_CLEAN_SLATE_FIELDS = (
    "needsClarification", "localRejectCount", "ncTriageAttempts", "ncTriageBucketAttempts",
    "ncTriageDecision", "ncTriageReviewedAt", "retryableDraftBlock", "turnBudgetExhausted",
    "turnBudgetExhaustedBefore", "infraErrorRetry", "infraErrorNote", "adhocResolution",
    "subTaskProposals", "priorRejectionFeedback", "rawDiff", "implementResponse",
    "blockedReason", "blockedStage", "claimedAt", "isAgenticContinuation",
    "agenticContinuationCount", "agenticContinuationNote", "priorPartialDiff",
    "adhocDiffSubstanceFeedback", "adhocNoChangesClaimFeedback", "premiseReadmitCount",
    "_prevBlockSignature",
)


def _clean_slate_for_fresh_adhoc_attempt(data):
    """Mutates `data` in place: strips every stale blocked/rejected-attempt field so a
    task moved into queue/adhoc/ for a fresh draft pass is actually eligible for one,
    instead of reading as an already-exhausted blocked task. Called by both /resolve and
    /answer below, right before writing into adhoc_dir."""
    for field in _NC_READMIT_CLEAN_SLATE_FIELDS:
        data.pop(field, None)
    if data.get("status") == "blocked":
        data["status"] = "pending"

@task_bp.route("/api/task/<state>/<task_id>")
def api_task_detail(state, task_id):
    from app import QUEUE_STATES, _files_touched_for, _incoming_task_links, _outgoing_task_links, _task_cost_summary, _task_input_summary, _work_log_for, queue_dir, read_json_safe
    qdir = queue_dir()
    if not qdir:
        abort(404)

    if state == "drafting":
        drafting_root = qdir / "drafting"
        if drafting_root.is_dir():
            for candidate in drafting_root.rglob(f"{task_id}.json"):
                data = read_json_safe(candidate)
                if data:
                    return jsonify({**data, "_costSummary": _task_cost_summary(task_id), "_filesTouched": _files_touched_for(data), "_requestInput": _task_input_summary(data), "_workLog": _work_log_for(task_id), "_incomingLinks": _incoming_task_links(task_id), "_outgoingLinks": _outgoing_task_links(task_id)})
        abort(404)

    if state not in QUEUE_STATES:
        abort(404)
    f = qdir / state / f"{task_id}.json"
    data = read_json_safe(f)
    if not data:
        abort(404)
    return jsonify({**data, "_costSummary": _task_cost_summary(task_id), "_filesTouched": _files_touched_for(data), "_requestInput": _task_input_summary(data), "_workLog": _work_log_for(task_id), "_incomingLinks": _incoming_task_links(task_id), "_outgoingLinks": _outgoing_task_links(task_id)})


@task_bp.route("/api/task/<state>/<task_id>/archive", methods=["POST"])
def api_task_archive(state, task_id):
    """Manual archive (Job Status > Blocked/Done tabs, per-row button): moves the task file
    to queue/done/_archived_no_action/ via _archive_task_file (see its own header). A blocked / needs-clarification /
    awaiting-confirm archive first stamps terminalDisposition 'abandoned' (+ manualArchive, optional JSON body `reason`) via
    _stamp_manual_archive so the record is never left 'unclassified'.
    Load-bearing detail: src/task-sources.js's taskIdExistsInQueue() only ever checks the
    direct queue/<state>/<id>.json path, never nested subfolders, so moving a file here
    silently frees up its underlying item (a brain-dump entry, an arch_import itemId, a
    deep_dive community) for reconsideration next time its source generator runs -- with
    zero source-specific logic needed on this end. 'needs-clarification' included since
    2026-08-16 -- "reject the dump" (Discuss session on context-aware-file-path-prefetch-
    job.md) is exactly this action for a held task the user decides isn't worth chasing
    down an anchor for. 'awaiting-confirm' included the same day, same reasoning -- DENYING
    a delete-containing batch (the awaiting-confirm gate's own opposite of /confirm below)
    is exactly this action too: give up on it rather than let it apply."""
    from app import _archive_task_file, _stamp_manual_archive, queue_dir
    if state not in ("blocked", "done", "needs-clarification", "awaiting-confirm"):
        abort(400, description="only a blocked, done, needs-clarification, or awaiting-confirm task can be archived")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / state / f"{task_id}.json"
    if not src.is_file():
        abort(404)
    dest = qdir / "done" / "_archived_no_action" / src.name
    if dest.exists():
        abort(409, description=f"an archived copy of '{src.stem}' already exists")
    body = request.get_json(silent=True) or {}
    # Record what this archive MEANS before moving it (see _stamp_manual_archive): without a disposition the task is
    # "unclassified" forever and silently blocks anything that dependsOn it.
    stamped = _stamp_manual_archive(src, state, body.get("reason"))
    try:
        _archive_task_file(qdir, src)
    except FileExistsError as e:
        abort(409, description=str(e))
    return jsonify({"id": task_id, "archived": True, "disposition": "abandoned" if stamped else None})


@task_bp.route("/api/task/<state>/<task_id>/rereview", methods=["POST"])
def api_task_rereview(state, task_id):
    """Re-review: send a review-stage-blocked task BACK TO REVIEW with its draft intact -- no redraft.
    Every other requeue drops planResponse/implementResponse, so retrying a blocked task always meant a
    full (expensive) redraft even when the draft was fine and the REVIEW side was wrong (e.g. a
    deterministic gate that contradicted the prompt). Single implementation: src/rereview-task.js, run
    here as a subprocess the same way the assignable-tasks route runs next-claimable-task.js, so the
    dashboard, the CLI and any future caller can never diverge."""
    from app import ENV_FILE_PATH, PACKAGE_ROOT, read_env_file
    if state not in ("blocked", "needs-clarification"):
        abort(400, description="only a blocked or needs-clarification task can be re-reviewed")
    body = request.get_json(silent=True) or {}
    reason = (body.get("reason") or "").strip() or "re-review requested from the dashboard"
    script = PACKAGE_ROOT / "src" / "rereview-task.js"
    try:
        cp = subprocess.run(
            ["node", str(script), task_id, "--state", state, "--reason", reason],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, **read_env_file(ENV_FILE_PATH)},
        )
        result = json.loads((cp.stdout or "{}").strip().splitlines()[-1])
    except Exception as e:  # noqa: BLE001 -- surface a clean error, never a stack trace
        abort(500, description=f"re-review failed: {e}")
    if not result.get("ok"):
        return jsonify(result), 409
    return jsonify(result)


@task_bp.route("/api/task/<state>/<task_id>/staleness-keep", methods=["POST"])
def api_task_staleness_keep(state, task_id):
    """Dismiss a stalenessFlag (adhoc-staleness-flag.js): the human looked and decided the
    task is still valid. Clears the flag and writes a `stalenessKeep` cooldown so the sweep
    does not re-flag it for AGENT_MANAGER_STALENESS_COOLDOWN_DAYS (default 21). The task
    stays exactly where it is -- this only affects the flag."""
    from app import queue_dir
    if state not in ("blocked", "needs-clarification"):
        abort(400, description="staleness flags only exist on blocked / needs-clarification tasks")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / state / f"{task_id}.json"
    if not src.is_file():
        abort(404)
    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        abort(500, description="could not read the task file")
    data.pop("stalenessFlag", None)
    cooldown_days = int(os.environ.get("AGENT_MANAGER_STALENESS_COOLDOWN_DAYS") or 21)
    until = datetime.now(timezone.utc) + timedelta(days=cooldown_days)
    data["stalenessKeep"] = {"until": until.isoformat(), "by": "human", "at": datetime.now(timezone.utc).isoformat()}
    data.setdefault("history", []).append({
        "stage": "advisory", "at": datetime.now(timezone.utc).isoformat(),
        "detail": f"staleness flag dismissed by a human -- keep until {until.date().isoformat()}",
    })
    src.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return jsonify({"id": task_id, "kept": True, "until": until.isoformat()})


@task_bp.route("/api/task/<state>/<task_id>/context-trim-keep", methods=["POST"])
def api_task_context_trim_keep(state, task_id):
    """Dismiss a contextTrimFlag (context-trim-sweep.js): the human looked and decided the
    task's grounding is fine as-is, or that re-anchoring genuinely can't help. Clears the
    flag and writes a `contextTrimKeep` cooldown so the sweep does not re-flag it for
    AGENT_MANAGER_CONTEXT_TRIM_SWEEP_KEEP_COOLDOWN_DAYS (default 21). The task stays exactly
    where it is -- this only affects the flag, same as staleness-keep above."""
    from app import queue_dir
    if state != "blocked":
        abort(400, description="context-trim flags only exist on blocked tasks")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / state / f"{task_id}.json"
    if not src.is_file():
        abort(404)
    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        abort(500, description="could not read the task file")
    data.pop("contextTrimFlag", None)
    cooldown_days = int(os.environ.get("AGENT_MANAGER_CONTEXT_TRIM_SWEEP_KEEP_COOLDOWN_DAYS") or 21)
    until = datetime.now(timezone.utc) + timedelta(days=cooldown_days)
    data["contextTrimKeep"] = {"until": until.isoformat(), "by": "human", "at": datetime.now(timezone.utc).isoformat()}
    data.setdefault("history", []).append({
        "stage": "advisory", "at": datetime.now(timezone.utc).isoformat(),
        "detail": f"context-trim flag dismissed by a human -- keep until {until.date().isoformat()}",
    })
    src.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return jsonify({"id": task_id, "kept": True, "until": until.isoformat()})


@task_bp.route("/api/task/awaiting-confirm/<task_id>/confirm", methods=["POST"])
def api_task_confirm_delete(task_id):
    """Confirms a delete-containing Group B batch (src/apply-task.js's remaining
    awaiting-confirm gate), moving it from queue/awaiting-confirm/ back into
    queue/approved/ so the next apply-task.sh pass re-runs it for real. Denying instead
    of confirming is just the existing generic archive action above (state='awaiting-
    confirm') -- no separate deny endpoint needed.

    REMOVED 2026-08-22 (Grimmethy: "I'd like to skip the confirm step. We already have a
    manual step for merge to main. This extra step is unnecessary friction."): this
    endpoint used to also stamp adhocApplyConfirmedAt/researchApplyConfirmedAt/
    pipelineSelfFixConfirmedAt/productSpecConfirmedAt, the confirm gates for adhoc/
    research_task/pipeline_self_audit/product_spec real-diff tasks -- apply-task.js no
    longer holds any of those, so none of them should reach queue/awaiting-confirm/ in
    the first place going forward. Left this endpoint's own behavior otherwise unchanged
    (still moves whatever's actually sitting in awaiting-confirm/ back to approved/) so
    it stays correct for the delete-mode gate, and harmless for any already-queued task
    that still happens to carry one of the old fields."""
    from app import queue_dir, read_json_safe
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / "awaiting-confirm" / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    now_iso = datetime.now(timezone.utc).isoformat()
    data["deleteConfirmedAt"] = now_iso
    # pipeline_forensics (2026-09-01): its apply's first pass held the ranked root-cause
    # report here for a human read. Confirming it stamps forensicsReportConfirmedAt so the
    # re-run's second pass files the RECOMMENDED FOLLOW-UP FIX as a pipeline-fix candidate
    # (see applyForensicsReport in src/apply-group-a.js).
    if data.get("source") == "pipeline_forensics":
        data["forensicsReportConfirmedAt"] = now_iso
    # pipeline_debrief (2026-09-06): its apply's first pass held the What/So-What/Now-What
    # report here for a human read. Confirming it stamps debriefReportConfirmedAt so the
    # re-run's second pass archives the window's own done/ tasks (see applyDebriefReport in
    # src/apply-group-a.js).
    if data.get("source") == "pipeline_debrief":
        data["debriefReportConfirmedAt"] = now_iso
    if data.get("source") == "decompose_design_question":
        data["decomposeQuestionConfirmedAt"] = now_iso

    approved_dir = qdir / "approved"
    approved_dir.mkdir(parents=True, exist_ok=True)
    dest = approved_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in approved/")
    dest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    src.unlink()
    return jsonify({"id": task_id, "confirmed": True})


@task_bp.route("/api/task/<state>/<task_id>/requeue", methods=["POST"])
def api_task_requeue(state, task_id):
    """Manual requeue (Job Status > Blocked/Needs Clarification/Done tabs, per-row button; also the Brain Dump
    tab's "Reopen" action on an archived entry's badge): moves the task back to pending/,
    stripped to the same shape a freshly-generated task has -- every drafting/review/apply
    artifact (blockedReason, doneMarker, ornithVotes, planResponse, implementResponse, etc.)
    is dropped, not carried forward. ornithRejectCount resets to 0 deliberately: a manual
    requeue is a deliberate human do-over, not a continuation of the same automatic retry
    cycle queue-watchdog.ps1's Invoke-RejectRetryCheck already runs for review-stage
    rejections (capped at $MaxOrnithRejectRetries=2) -- carrying the old count forward would
    let a manually-requeued task block again after fewer real attempts than a task hitting
    that cap for the first time gets.

    2026-09-06, real incident: a stacked file-decompose sub-task (seq 2 of 5, sharing one
    branch with its 4 siblings -- see file-decompose-to-hub.js) blocked on a sustained
    Ollama infra outage. Its `stacked` field -- {branch, seq, total}, the ONLY thing that
    ties it back to the shared branch and its position in the sequence -- is a TOP-LEVEL
    task field, not part of promptContext, so the "fresh" rebuild below silently dropped it
    on every requeue: a human clicking Requeue on a stuck stacked sub-task would have
    detached it from its hub, breaking the coordination with no error and no visible sign
    anything was wrong until the wiring step later found the branch missing pieces.
    `dependsOn` (also file-decompose-to-hub.js, and consumed by nextAdhocTask's/
    coordinator-sweep.js's dependency gate) is the identical shape -- a top-level field a
    generic reset has no way to know matters.

    2026-09-06, same requeue, second field: `atomic` (also file-decompose-to-hub.js) was
    STILL being dropped by this same allowlist gap even after the stacked/dependsOn fix
    above -- confirmed live, the requeued sub-task's own local-draft.js pre-split check
    (`!task.atomic`, the guard that exists specifically because "a file-decompose child IS
    the output of a decomposition; re-splitting it loops") saw `atomic: undefined` and let
    the model try to decompose it AGAIN, producing a malformed 2-piece split and blocking a
    second time. `noDecompose` (set alongside `atomic` by the same code, currently unread
    elsewhere but the same coordination-field shape) is preserved too rather than assuming
    it stays unused forever. All four preserved explicitly now, when present, rather than
    trusting this allowlist to anticipate every future coordination field one at a time.

    'archived' is a distinct pseudo-state (not a real QUEUE_STATES member) for a task
    api_task_archive moved to done/_archived_no_action/ -- _task_state_index reports it as
    'archived', not 'done', so this must be handled as a separate lookup path rather than
    falling through to state_dir/task_id.json, which would 404 (real gap found 2026-08-17
    auditing the "always reversible" promise: an archived item couldn't actually be
    un-archived through the UI before this). 2026-08-24: also checks done-archive.js's own
    dated month buckets (queue/done/_archived/<YYYY-MM>/) -- a task the AUTOMATIC daily
    archive pass moved there is just as "archived" and must be just as requeueable as one a
    human moved to _archived_no_action/ by hand; see done-archive.js's own header on the
    same "always reversible" promise this endpoint already exists to uphold."""
    from app import _record_manual_requeue, _repeated_blocker_match, get_active_repo_root, logger, queue_dir, read_json_safe
    if state not in ("blocked", "needs-clarification", "done", "archived"):
        abort(400, description="only a blocked, needs-clarification, done, or archived task can be requeued")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    if state == "archived":
        src = qdir / "done" / "_archived_no_action" / f"{task_id}.json"
        if not src.is_file():
            archived_root = qdir / "done" / "_archived"
            if archived_root.is_dir():
                for month_dir in archived_root.iterdir():
                    if not month_dir.is_dir():
                        continue
                    candidate = month_dir / f"{task_id}.json"
                    if candidate.is_file():
                        src = candidate
                        break
    else:
        src = qdir / state / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    # A needs-clarification task can be sent straight back for a fresh draft -- but only a NON-adhoc one. An adhoc-shaped task lives in
    # queue/adhoc/ (nextAdhocTask only scans there), and this route writes to pending/, which would silently orphan it; those have their
    # own /resolve and /answer routes below. (2026-09-20: a candidate-fulfillment task exhausted its retries on failures that were then
    # fixed, and the only way back was moving its file to blocked/ by hand.)
    if state == "needs-clarification" and (
        data.get("domain") == "adhoc" or data.get("source") in ("manual", "derived_task")
    ):
        abort(400, description=(
            "this is an adhoc-shaped task -- send it back with the file-path picker (/resolve) or the answer box (/answer), "
            "which put it where the adhoc lane claims it; a plain requeue would strand it in pending/"
        ))

    if state in ("blocked", "needs-clarification") and not (request.get_json(silent=True) or {}).get("force"):
        repeat = _repeated_blocker_match(data)
        if repeat:
            abort(409, description=(
                "This task's rejection looks like the same underlying problem as an "
                f"earlier attempt: \"{repeat[:220]}\" -- redrafting alone hasn't fixed "
                "this before and likely won't now without a real change. Diagnose the "
                "actual root cause first (or confirm you already have), then requeue "
                "again to proceed anyway."
            ))

    # If this task was already applied to a branch that never merged (task-disposition.js's
    # 'pending-merge' -- an agent/<id> branch exists, ahead of main, unmerged), a requeue is
    # about to redo the same work from scratch on a FRESH branch, so the old one is now
    # abandoned, not merely forgotten. Without this, this endpoint silently orphaned the
    # prior branch: it stayed pushed to GitHub, unmerged, with no PR and no record anywhere
    # that a later attempt superseded it. Confirmed live 2026-09-13:
    # adhoc-add-spec-comment-at-call-site-in-src-local-draft-js-1789232601161-1's
    # forbidden-path-gate-blocked branch sat dangling until a human noticed and deleted it
    # by hand. Guarded on terminalDisposition != 'merged' so a task record that (rarely)
    # reached done/ with its branch already merged is never touched.
    if data.get("terminalDisposition") != "merged":
        applied_branch = None
        for ev in reversed(data.get("history") or []):
            if isinstance(ev, dict) and ev.get("stage") == "applied" and ev.get("detail"):
                applied_branch = ev["detail"]
                break
        if applied_branch:
            from app import _invalidate_branch_cache, _run_git
            repo_root = get_active_repo_root()
            repo_root = Path(repo_root) if repo_root else None
            if repo_root:
                try:
                    _run_git(["push", "origin", "--delete", applied_branch], repo_root)
                except RuntimeError as e:
                    # Non-fatal, same reasoning as api_git_merge_branch's own post-merge
                    # branch delete -- already gone, never actually pushed, or a transient
                    # network error are all fine; the requeue itself must not fail here.
                    logger.warning(
                        "Non-fatal: could not delete superseded branch %r for requeued task %r: %s",
                        applied_branch, task_id, e,
                    )
                _invalidate_branch_cache()
            abandon_iso = datetime.now(timezone.utc).isoformat()
            abandon_detail = f"superseded by a manual requeue from {state}/; prior branch {applied_branch} deleted"
            data.setdefault("history", []).append({
                "stage": "abandoned", "at": abandon_iso, "detail": abandon_detail,
            })
            data["terminalDisposition"] = "abandoned"
            # NOT closing out task-logs/<id>.json here (contrast api_git_merge_branch's
            # 'merged' handling): that file is committed only on the task's OWN branch, and
            # for an unmerged branch it was never on <main> to begin with -- there is
            # nothing on disk in this checkout to update. task-log-reconcile.js's own
            # 'abandoned' disposition (see task-disposition.js's header) has the identical
            # scope: it marks the queue/ record, it does not retroactively rescue a
            # never-merged branch's task-log onto main.

    pending_dir = qdir / "pending"
    pending_dir.mkdir(parents=True, exist_ok=True)
    dest = pending_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in pending/")

    now_iso = datetime.now(timezone.utc).isoformat()
    # history must never be replaced -- it's the one append-only, complete log of
    # everything that happened to this task (see task-history.js and AGENTS.md's task-log
    # section), and a manual requeue is exactly the kind of step whose OWN reason (plus
    # whatever blockedReason/priorRejectionFeedback drove it) needs to survive in that log,
    # not vanish the moment the task starts its next draft cycle. Root-caused live
    # 2026-09-12: this endpoint used to stamp a brand-new one-entry array here, discarding
    # every prior event -- including the real blockedReason a `blocked` history event
    # already carried -- for observability-fix-ac-158 and others, so the ONLY trace left
    # of why a task ever blocked was this note's bare "manually requeued from blocked/".
    old_history = data.get("history")
    history = list(old_history) if isinstance(old_history, list) else []
    history.append({
        "stage": "requeued",
        "at": now_iso,
        "note": f"manually requeued from {state}/",
        # The exact fields a fresh rebuild used to drop silently -- carried into the log
        # entry itself so they're never lost even though the rebuilt task below won't
        # carry them forward as live working state.
        "blockedReasonAtRequeue": data.get("blockedReason"),
        "priorRejectionFeedbackAtRequeue": data.get("priorRejectionFeedback"),
    })
    fresh = {
        "id": data.get("id", task_id),
        "domain": data.get("domain"),
        "source": data.get("source"),
        "title": data.get("title"),
        "promptContext": data.get("promptContext"),
        "status": "pending",
        "createdAt": data.get("createdAt", now_iso),
        "history": history,
    }
    # Coordination fields (see this endpoint's own docstring) -- never part of the
    # drafting/review/apply history this reset is meant to clear, so always carried over
    # verbatim when present rather than silently dropped.
    if "stacked" in data:
        fresh["stacked"] = data["stacked"]
    if "dependsOn" in data:
        fresh["dependsOn"] = data["dependsOn"]
    if "atomic" in data:
        fresh["atomic"] = data["atomic"]
    if "noDecompose" in data:
        fresh["noDecompose"] = data["noDecompose"]
    dest.write_text(json.dumps(fresh, indent=2), encoding="utf-8")
    src.unlink()
    _record_manual_requeue(data, reason_hint=f"manually requeued from {state}/", requeue_writer="operator-manual")
    return jsonify({"id": task_id, "requeued": True})


@task_bp.route("/api/task/needs-clarification/<task_id>/resolve", methods=["POST"])
def api_task_resolve_clarification(task_id):
    """Moves a held task from queue/needs-clarification/ into queue/adhoc/ (NOT
    queue/pending/ -- unlike requeue above, this is an adhoc-domain task, and
    nextAdhocTask() only ever scans queue/adhoc/; landing it in pending/ the way requeue
    does would silently orphan it) so local-worker.sh can finally claim and draft it.
    Body: {"paths": [...]}  -- the file path(s) the user picked (from the 'ambiguous'
    candidates, or hand-typed for a 'no-match' case) become promptContext.prefetchedPaths;
    an empty/omitted paths list means "proceed with no prefetch at all," a deliberate
    choice, not an error."""
    from app import _record_manual_requeue, queue_dir, read_json_safe
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / "needs-clarification" / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    body = request.get_json(silent=True) or {}
    paths = body.get("paths")
    if paths and isinstance(paths, list):
        data.setdefault("promptContext", {})["prefetchedPaths"] = [str(p) for p in paths]
    _clean_slate_for_fresh_adhoc_attempt(data)

    adhoc_dir = qdir / "adhoc"
    adhoc_dir.mkdir(parents=True, exist_ok=True)
    dest = adhoc_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in adhoc/")
    dest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    src.unlink()
    _record_manual_requeue(data, reason_hint="needs-clarification resolved via the file-path picker", requeue_writer="operator-manual")
    return jsonify({"id": task_id, "resolved": True, "prefetchedPaths": data.get("promptContext", {}).get("prefetchedPaths")})


@task_bp.route("/api/task/needs-clarification/<task_id>/answer", methods=["POST"])
def api_task_answer_clarification(task_id):
    """Multiple-choice / free-text answer for a 'design-decision' held task -- Grimmethy,
    2026-08-24: "we could build in some multiple choice options into the task log
    including an 'other:' option that the user could fill in without ever starting a chat
    session... reduce the friction caused by pausing the pipeline to set up a chat."
    Distinct from /resolve above (that one's for the file-path picker's 'ambiguous'/
    'no-match' shape); this is for nc.reason == 'design-decision', where the answer is a
    human decision folded into the task's own instructions -- same text shape a Discuss
    session's transcript already gets folded in as (see api_discuss_end's needs-
    clarification branch), just without ever opening a session.
    Body: {"answer": "<free text, or the clicked option's label+description>"}."""
    from app import _record_manual_requeue, queue_dir, read_json_safe
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / "needs-clarification" / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    body = request.get_json(silent=True) or {}
    answer = (body.get("answer") or "").strip()
    if not answer:
        abort(400, description="answer is required")

    data.setdefault("promptContext", {})
    prior = data["promptContext"].get("rawText", "")
    data["promptContext"]["rawText"] = prior + (
        f"\n\nHUMAN DESIGN DECISION (answered directly from the Needs Clarification "
        f"picker, {datetime.now(timezone.utc).isoformat()}):\n{answer}\n"
        f"This answer resolves the open question(s) above -- implement against it "
        f"directly rather than re-asking for clarification."
    )
    _clean_slate_for_fresh_adhoc_attempt(data)
    data.setdefault("history", []).append({
        "stage": "needs-clarification-resolved", "at": datetime.now(timezone.utc).isoformat(),
        "detail": "Answered directly from the dashboard's multiple-choice/Other picker -- requeued to adhoc/ for a fresh draft pass.",
    })

    adhoc_dir = qdir / "adhoc"
    adhoc_dir.mkdir(parents=True, exist_ok=True)
    dest = adhoc_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in adhoc/")
    dest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    src.unlink()
    _record_manual_requeue(data, reason_hint=f"needs-clarification answered from the picker: {answer[:200]}", requeue_writer="operator-manual")
    return jsonify({"id": task_id, "answered": True})


@task_bp.route("/api/task/needs-clarification/<task_id>/done", methods=["POST"])
def api_task_mark_done_clarification(task_id):
    """Manual "mark as done" for a held needs-clarification task (Job Status > Needs
    Clarification, 2026-08-17: "I found entries here that have been fully resolved"): unlike
    Reject/archive above, which files it under done/_archived_no_action/ (a nested folder
    api_queue_state() never lists, and taskIdExistsInQueue() never checks, so the underlying
    item is silently freed up for reconsideration), this writes queue/done/<id>.json directly
    -- the same path a real apply-pass completion uses -- so it shows up in the Done tab and
    taskIdExistsInQueue() correctly treats it as already handled, matching what the user is
    telling us: the work is genuinely finished, not merely dismissed.

    2026-09-19, [[ghost-in-the-machine]] incident (concept-ghost-in-the-machine-0dbeea):
    this route used to move the file into done/ without ever stamping `status` or
    `terminalDisposition`, and appended a malformed history entry (`{"status": ...}`
    instead of every other event's `{"stage": ...}` shape). The record's own top-level
    `status` field stayed whatever it was before (usually 'blocked'), directly
    contradicting the folder it now lived in -- and with no `terminalDisposition` and no
    `mergedAt`, task-sources.js's isDependencySatisfied() (which only recognizes those two
    signals) could NEVER be satisfied by it. Confirmed live: two real tasks sat completely
    untouched for 6-9 days, silently waiting on a `dependsOn` edge that named exactly this
    kind of manually-"done"-but-unstamped task -- a merge that was never going to happen,
    because the "prerequisite" never produced any code the pipeline could track in the
    first place. A human correctly resolving a stuck task by hand still has to leave the
    record in a state every OTHER deterministic consumer can actually read, or the manual
    action just relocates the ghost instead of exorcising it. `terminalDisposition:
    'noop'` is the closest existing, already-understood signal for "no code is coming
    from this specific record, but the need is considered met" -- exactly what
    isDependencySatisfied's own new no-code-coming check now looks for (see its comment).
    """
    from app import queue_dir, read_json_safe
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / "needs-clarification" / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    now_iso = datetime.now(timezone.utc).isoformat()
    data["doneMarker"] = "manually marked done from Needs Clarification"
    data["status"] = "done"
    data["terminalDisposition"] = "noop"
    data.setdefault("history", []).append({
        "stage": "noop", "at": now_iso,
        "detail": "manually marked done from needs-clarification/ (operator override -- no code produced, need considered met)",
    })

    done_dir = qdir / "done"
    done_dir.mkdir(parents=True, exist_ok=True)
    dest = done_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in done/")
    dest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    src.unlink()
    return jsonify({"id": task_id, "done": True})


@task_bp.route("/api/task/approved/<task_id>/apply", methods=["POST"])
def api_task_apply(task_id):
    """Manual per-task apply (three-tier approval mode, 2026-07-26): the missing piece that
    makes 'prompt'/'approve'-tier tasks actually usable one at a time, instead of only via
    the all-or-nothing AGENT_MANAGER_INCLUDE_APPLY global toggle. Shells out to
    apply-runner.ps1 -TaskId <id> (a one-shot invocation mode that bypasses the automatic
    loop's approval-mode filtering entirely, since a human explicitly clicked Apply) and
    waits for it to finish -- a real git branch/commit/push can take a while, hence the
    generous timeout, and this is deliberately synchronous (no async job tracking) since
    the dashboard button needs a direct success/failure answer to show the user."""
    from app import ENV_FILE_PATH, PACKAGE_ROOT, SRC_DIR, get_active_repo_root, logger, queue_dir, read_env_file
    qdir = queue_dir()
    if not qdir:
        abort(404)
    approved_path = qdir / "approved" / f"{task_id}.json"
    if not approved_path.is_file():
        abort(404, description=f"'{task_id}' not found in approved/")

    repo_root = get_active_repo_root()
    if not repo_root:
        abort(400, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")

    env_overrides = read_env_file(ENV_FILE_PATH)
    env_overrides["AGENT_MANAGER_REPO_ROOT"] = repo_root
    child_env = {**os.environ, **env_overrides}

    script_path = SRC_DIR / "apply-runner.ps1"
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script_path), "-TaskId", task_id],
            capture_output=True, text=True, timeout=300, env=child_env, cwd=str(PACKAGE_ROOT),
        )
    except subprocess.TimeoutExpired as e:
        logger.error(
            "apply-runner.ps1 -TaskId %s timed out (script: %s): %s: %s",
            task_id, str(script_path), type(e).__name__, str(e),
            exc_info=True,
        )
        raise

    output_tail = (result.stdout or "")[-4000:]
    if result.returncode == 2:
        return jsonify({"id": task_id, "applied": False, "reason": f"'{task_id}' was not found in approved/ by apply-runner.ps1 (raced with the automatic loop?)"}), 404
    if result.returncode != 0:
        return jsonify({"id": task_id, "applied": False, "reason": "apply-runner.ps1 exited non-zero", "output": output_tail}), 500

    return jsonify({"id": task_id, "applied": True, "output": output_tail})


@task_bp.route("/api/task/needs-clarification/<task_id>/discuss/latest", methods=["GET"])
def api_needs_clarification_discuss_latest(task_id):
    """Held-task counterpart to the brain-dump/second-brain discuss/latest checks above --
    same "don't silently start a duplicate" reasoning."""
    from app import get_pipeline_dir
    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")
    from discuss_sessions import latest_session_for_subject
    session = latest_session_for_subject(pipeline_dir, task_id)
    return jsonify(session)


@task_bp.route("/api/task/needs-clarification/<task_id>/discuss/start", methods=["POST"])
def api_needs_clarification_discuss_start(task_id):
    """"Rather than inputting a file path manually we should open a 'discuss' to get more
    information about the task itself" -- the actual ask. Starts a conversation about a
    held queue/needs-clarification/ task, using its rawText as the subject. Ending it
    (see api_discuss_end's 'needs-clarification' branch) reopens the task for a fresh
    path_prefetch_resolve attempt with the enriched text, rather than just leaving a
    human to manually resolve it with no more information than they started with."""
    from app import _call_discuss, _discuss_provider_args, get_active_grep_dirs, get_active_repo_root, get_pipeline_dir, instances_dir, queue_dir, read_json_safe
    qdir = queue_dir()
    if not qdir:
        abort(500, description="no active project configured")
    held_path = qdir / "needs-clarification" / f"{task_id}.json"
    held = read_json_safe(held_path)
    if not held:
        abort(404)
    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")
    subject_text = (held.get("promptContext") or {}).get("rawText") or held.get("title") or ""
    from discuss_sessions import start_session
    provider, model, effort = _discuss_provider_args()
    session = _call_discuss(start_session, pipeline_dir, task_id, subject_text, kind="needs-clarification",
                             provider=provider, model=model, effort=effort, repo_root=get_active_repo_root(),
                             grep_dirs=get_active_grep_dirs(), instances_dir=instances_dir())
    return jsonify(session)
