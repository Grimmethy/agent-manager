from flask import Blueprint, abort, jsonify, request

from datetime import datetime, timedelta, timezone
import sqlite3
import json
import os
import subprocess
import sys

# The app.py helpers these views call (ENV_FILE_PATH, OTHER_STALE_SECONDS, PACKAGE_ROOT, WORKING_STALE_SECONDS, _expected_instance_ids, _find_task_record_anywhere, _has_instance_id_column, _is_live_worker_instance, _kill_and_requeue_instance, _read_pipeline_history_events, _recent_task_ids_for_instance, _relocate_task_to_pending, _scan_recently_completed_tasks, instances_dir, model_stats_db_path, parse_hb_timestamp, queue_dir, read_env_file, read_json_safe) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

instances_bp = Blueprint("instances-bp", __name__)

@instances_bp.route("/api/instances")
def api_instances():
    from app import OTHER_STALE_SECONDS, WORKING_STALE_SECONDS, _expected_instance_ids, instances_dir, parse_hb_timestamp, read_json_safe
    results = []
    seen_ids = set()
    inst_dir = instances_dir()
    if inst_dir and inst_dir.is_dir():
        for f in sorted(inst_dir.glob("*.json")):
            data = read_json_safe(f)
            if not data or not data.get("instanceId") or not data.get("lastHeartbeat"):
                continue
            seen_ids.add(data["instanceId"])
            last_hb = parse_hb_timestamp(data["lastHeartbeat"])
            age = (datetime.now(timezone.utc) - last_hb).total_seconds() if last_hb else None
            threshold = WORKING_STALE_SECONDS if data.get("status") == "working" else OTHER_STALE_SECONDS
            # stateSince is written by Write-HeartbeatFile on every state transition
            # (status/pass/task change); age it server-side so the first paint is right
            # even before the client's 1s ticker takes over.
            state_age = None
            if data.get("stateSince"):
                since = parse_hb_timestamp(data["stateSince"])
                if since:
                    state_age = (datetime.now(timezone.utc) - since).total_seconds()
            results.append({
                **data,
                "heartbeatAgeSeconds": round(age) if age is not None else None,
                "stateAgeSeconds": round(state_age) if state_age is not None else None,
                "stale": age is not None and age > threshold,
                "staleThresholdSeconds": threshold,
            })
    # Fill in a placeholder "offline" card for every daemon launch.sh would normally start
    # but that has no (fresh-enough) heartbeat file on disk -- previously the Workers tab
    # went entirely blank ("No instances found -- is the pipeline running?") whenever the
    # pipeline was stopped from a clean state, instead of showing operators which workers
    # exist and that they're simply not running.
    if inst_dir is not None:
        for instance_id in _expected_instance_ids():
            if instance_id in seen_ids:
                continue
            results.append({
                "instanceId": instance_id,
                "status": "offline",
                "pid": None,
                "model": None,
                "currentTaskId": None,
                "currentPass": None,
                "lastHeartbeat": None,
                "heartbeatAgeSeconds": None,
                "stateAgeSeconds": None,
                "stale": False,
                "staleThresholdSeconds": None,
            })
    results.sort(key=lambda r: r.get("instanceId") or "")
    return jsonify(results)


@instances_bp.route("/api/instances/<instance_id>/recent-tasks")
def api_instance_recent_tasks(instance_id):
    """Last 10 tasks a given instance actually completed (2026-08-23, Workers tab:
    "When I click on a worker to expand it's information I'd like to see a list of the
    last 10 tasks it completed."). model_calls is the only place that ties a task_id to
    the instance that drafted it (see model-stats-db.js's own instance_id migration) --
    GROUP BY task_id since a task can carry several calls (retries/revisions) from the
    same instance. Only instance_id itself is trusted from that table (see
    _recent_task_ids_for_instance's own header for why its outcome column isn't) -- the
    real completedAt/outcome/model for each candidate come from the task's own current
    record via _find_task_record_anywhere, and only task_ids that resolved to an actual
    terminal state (done / archived / superseded, not still drafting/pending/blocked)
    count as "completed" here.

    reviewer (2026-08-24, Grimmethy: "add reviewer's reviewed tasks too"; rewritten
    2026-09-08 -- "Under reviewer they're all showing approved and 5 hours ago. I don't
    think it's updating properly") is a special case, not just the branch below with a
    different verdict word: review-task.js never calls recordCall for its own
    majorityVote() calls at all, only recordModelOutcome against the DRAFTER's own
    call_id -- so instance_id='reviewer' never matches a single row in this table at
    all, model_calls-based or not. Worse, root-caused live: an increasing share of real
    reviews are now DETERMINISTIC (deterministic-script-extract-approve,
    brain_dump_sort's deterministicReviewValidate, ...) and make no model call
    whatsoever -- confirmed directly against the real db, the single most recent
    outcome_stage='review' row genuinely was ~4.5 hours stale, because every review in
    that window happened to be one of these. _scan_recently_completed_tasks reads each
    task's own real history instead, which can't miss a review class that hasn't even
    been invented yet either. Includes both verdicts (approved AND blocked both count as
    "reviewed"), unlike the draft branch below which only counts approved as
    "completed"."""
    from app import _find_task_record_anywhere, _has_instance_id_column, _recent_task_ids_for_instance, _scan_recently_completed_tasks, model_stats_db_path, queue_dir
    if instance_id == "reviewer":
        rows, _ = _scan_recently_completed_tasks(10, reviewed_only=True)
        return jsonify({"tasks": [{"taskId": r["taskId"], "completedAt": r["completedAt"], "model": r["model"], "outcome": r["outcome"]} for r in rows]})
    qdir = queue_dir()
    db_path = model_stats_db_path()
    if not qdir or not db_path or not db_path.is_file():
        return jsonify({"tasks": []})
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if not _has_instance_id_column(conn):
            return jsonify({"tasks": []})
        # Over-fetch: several of this instance's most recent calls can land on the same
        # task_id (retries), or on a task_id that's still in-flight rather than terminal
        # -- both get filtered out below, so 10 real candidates needs more than 10 raw
        # rows to draw from.
        candidate_ids = _recent_task_ids_for_instance(conn, instance_id, 60)
    finally:
        conn.close()
    results = []
    for tid in candidate_ids:
        rec, state = _find_task_record_anywhere(qdir, tid)
        if not rec or state not in ("done", "archived", "superseded"):
            continue
        history = rec.get("history") or []
        last = history[-1] if history and isinstance(history[-1], dict) else {}
        results.append({
            "taskId": tid,
            "completedAt": last.get("at"),
            "model": rec.get("draftModel"),
            "outcome": rec.get("terminalDisposition") or rec.get("status"),
        })
        if len(results) >= 10:
            break
    return jsonify({"tasks": results})


@instances_bp.route("/api/instances/<instance_id>/run-log")
def api_instance_run_log(instance_id):
    """Every real attempt this instance made to run a model, not just the ones that
    reached a reviewed/completed task state (2026-09-08, Grimmethy: "This looks like
    it's only showing fully completed tasks. I want to see a log of every time an agent
    is run and the outcome of that run."). recent-tasks (above) is deliberately
    'terminal task state only'; this is the raw call-level trail, merging:

      - every model_calls row this instance made (regardless of its own outcome column
        -- see _recent_task_ids_for_instance's own header for why that column alone
        under-reports), with 'pending'/'in-progress' shown instead of a blank outcome
        when the owning task hasn't resolved to a real terminal state yet;
      - every hard-failure (timeout/connection-refused/non-200) entry this instance
        logged, which never reaches model_calls at all -- local-client.js's call() only
        invokes recordCall on a response it actually got back, so an errored-out call
        never gets that far (see logHardFailureAudit's own header). This is exactly the
        class of run that was invisible before this route existed: worker-1's real
        state during the 2026-09-08 GPU-contention incident was dozens of back-to-back
        OLLAMA_TIMEOUTs that the terminal-state-only recent-tasks view had no way to
        show at all -- it just looked stale.

    Merged and sorted by timestamp, newest first."""
    from app import _find_task_record_anywhere, _has_instance_id_column, _read_pipeline_history_events, instances_dir, model_stats_db_path, queue_dir
    limit = min(max(request.args.get("limit", 30, type=int) or 30, 1), 100)
    qdir = queue_dir()
    db_path = model_stats_db_path()
    runs = []
    if db_path and db_path.is_file():
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            if _has_instance_id_column(conn):
                rows = conn.execute("""
                    SELECT task_id, stage, model, started_at, outcome, latency_ms
                    FROM model_calls
                    WHERE instance_id = ?
                    ORDER BY started_at DESC
                    LIMIT ?
                """, (instance_id, limit * 2)).fetchall()
                for task_id, stage, model, started_at, outcome, latency_ms in rows:
                    resolved_outcome = outcome
                    if not resolved_outcome:
                        rec, state = (_find_task_record_anywhere(qdir, task_id) if qdir else (None, None))
                        if rec and state in ("done", "archived", "superseded"):
                            resolved_outcome = rec.get("terminalDisposition") or rec.get("status") or "resolved"
                        elif rec:
                            resolved_outcome = "in-progress"
                        else:
                            resolved_outcome = "pending"
                    runs.append({
                        "at": started_at, "taskId": task_id, "stage": stage, "model": model,
                        "kind": "call", "outcome": resolved_outcome, "latencyMs": latency_ms,
                    })
        finally:
            conn.close()
    for ev in _read_pipeline_history_events(instances_dir(), "hard-failure", instance_id=instance_id, limit=limit * 2):
        runs.append({
            "at": ev.get("at"), "taskId": ev.get("taskId"), "stage": ev.get("stage"),
            "model": ev.get("model"), "kind": "failed", "outcome": ev.get("code") or "error",
            "detail": ev.get("message"),
        })
    runs.sort(key=lambda r: r.get("at") or "", reverse=True)
    return jsonify({"runs": runs[:limit]})


@instances_bp.route("/api/instances/<instance_id>/assignable-tasks")
def api_instance_assignable_tasks(instance_id):
    """Candidate list for the Workers tab's assign-task dropdown (2026-09-07, Grimmethy
    after live-testing the override below: "the only tasks I have access to, no matter
    the worker, are pipeline debrief tasks. The task I want, autodecomp, is in drafting.
    I need access to the full list of available jobs, they should however be whats
    available for that specific worker type"). queue/pending/ alone is too narrow a
    candidate pool -- the task an operator actually wants to reassign is usually already
    claimed by some other lane, sitting in ITS queue/drafting/<lane>/.

    Shells out to src/next-claimable-task.js's listAssignableTasks (via its
    --list-assignable CLI mode), the same way _arbiter_cancel_below already shells out
    to scripts/gpu-arbiter-cli.js: tier resolution (reasoningTierFor) depends on the
    real registered task sources + config overrides and must never be re-derived in
    Python, where it could silently drift from the Node source of truth that
    local-worker.sh's actual claim loop uses."""
    from app import ENV_FILE_PATH, PACKAGE_ROOT, _is_live_worker_instance, queue_dir, read_env_file
    if not _is_live_worker_instance(instance_id):
        abort(404, description=f"'{instance_id}' is not a worker lane that claims tasks from pending/")
    qdir = queue_dir()
    if not qdir:
        return jsonify({"items": []})
    is_reasoning_lane = instance_id.startswith("worker-reasoning")
    script = PACKAGE_ROOT / "src" / "next-claimable-task.js"
    if not script.is_file():
        return jsonify({"items": []})
    try:
        cp = subprocess.run(
            ["node", str(script), "--list-assignable", str(qdir), instance_id,
             "true" if is_reasoning_lane else "false"],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, **read_env_file(ENV_FILE_PATH)},
        )
        items = json.loads((cp.stdout or "[]").strip() or "[]")
    except Exception as e:  # noqa: BLE001 -- best-effort; an empty list is a safe fallback for a dropdown
        print(f"[assignable-tasks] failed for {instance_id} (non-fatal): {e}", file=sys.stderr, flush=True)
        items = []
    return jsonify({"items": items})


@instances_bp.route("/api/instances/<instance_id>/assign-task", methods=["POST"])
def api_instance_assign_task(instance_id):
    """Operator override: pin a specific pending task to a specific worker lane,
    bypassing the normal priority/reasoningTier claim ranking (src/next-claimable-
    task.js), and preempt whatever that lane is doing right now so it picks the pinned
    task up next (2026-09-06, Workers tab, Grimmethy: "I need to be able to select the
    task I want each worker to run... this should override the automated system...
    whatever is being worked on should save its current state to the task log and then
    cancel itself as soon as possible"). "Save current state" is already true
    continuously (the Node persist hook flushes the whole task JSON to disk on every
    history event, see task-history.js) -- what this route adds is a labeled
    operator-preempted history event explaining WHY the in-flight task stopped, instead
    of it looking like an unexplained infra failure next time someone reads its history.

    Scoped to worker-* lanes only (the ones that actually claim from queue/pending/ via
    local-worker.sh) -- 'reviewer' and 'watchdog' don't run drafts, so pinning a task to
    either would be a no-op that just silently confuses the operator.

    The task doesn't have to already be in pending/ -- per 2026-09-07 feedback ("The
    task I want, autodecomp, is in drafting"), _relocate_task_to_pending() also finds a
    task already claimed by some OTHER lane (killing it if it's actively in-flight there,
    or just relocating it if it's merely sitting in that lane's own drafting/ backlog)
    and moves it into pending/ first, so everything below operates on it the same way
    either way."""
    from app import _is_live_worker_instance, _kill_and_requeue_instance, _relocate_task_to_pending, instances_dir, queue_dir, read_json_safe
    if not _is_live_worker_instance(instance_id):
        abort(404, description=f"'{instance_id}' is not a worker lane that claims tasks from pending/")

    body = request.get_json(silent=True) or {}
    task_id = body.get("taskId")
    if not task_id:
        abort(400, description="taskId is required")

    qdir = queue_dir()
    if not qdir:
        abort(404)

    relocated = _relocate_task_to_pending(qdir, task_id, instance_id)
    if relocated["already_here"]:
        # Operator "reassigned" a task to the lane already running/queuing it -- nothing
        # to preempt, nothing to relocate, matching the existing already-running guard's
        # spirit below for the plain-pending case.
        return jsonify({"id": task_id, "pinnedTo": instance_id, "preempted": False})
    if not relocated["found"]:
        abort(404, description=f"'{task_id}' was not found in pending/ or any worker's drafting/")

    pending_path = qdir / "pending" / f"{task_id}.json"
    if not pending_path.is_file():
        abort(404, description=f"'{task_id}' is not in queue/pending/ -- it may already have been claimed")

    try:
        data = json.loads(pending_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        abort(500, description="could not read the task file")
    data["pinnedWorker"] = instance_id
    data.setdefault("history", []).append({
        "stage": "operator-assigned", "at": datetime.now(timezone.utc).isoformat(),
        "detail": f"pinned to {instance_id} by operator override",
    })
    pending_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    inst_dir = instances_dir()
    hb = (read_json_safe(inst_dir / f"{instance_id}.json") if inst_dir else None) or {}
    preempted = False
    current_task_id = hb.get("currentTaskId")
    if current_task_id and current_task_id != task_id:
        result = _kill_and_requeue_instance(
            instance_id, f"cancelled by operator -- worker reassigned to {task_id}")
        preempted = result["killed"]

    return jsonify({"id": task_id, "pinnedTo": instance_id, "preempted": preempted})
