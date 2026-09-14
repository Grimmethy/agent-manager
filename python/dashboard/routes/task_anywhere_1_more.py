from flask import Blueprint, abort, jsonify, request, session

from datetime import datetime, timedelta, timezone
import json

# The app.py helpers these views call (QUEUE_STATES, _call_discuss, _files_touched_for, _find_live_task_file, _incoming_task_links, _outgoing_task_links, _resolve_discuss_session, _resolve_under_second_brain, _task_cost_summary, _task_input_summary, _work_log_for, queue_dir, read_brain_dump_entries, read_json_safe, second_brain_dir, write_brain_dump_entries) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

task_anywhere_1_more_bp = Blueprint("task-anywhere-1-more-bp", __name__)

@task_anywhere_1_more_bp.route("/api/task-anywhere/<task_id>")
def api_task_anywhere(task_id):
    """Workers tab click-through: an instance's currentTaskId doesn't say which queue
    state to look in (a worker's is in drafting/, review-runner's is in review/,
    apply-runner's is in approved/) -- rather than hardcode that mapping (fragile if a
    new instance type is added later), just search drafting first (the common case for
    an actively 'working' instance), then every other state in order."""
    from app import QUEUE_STATES, _files_touched_for, _incoming_task_links, _outgoing_task_links, _task_cost_summary, _task_input_summary, _work_log_for, queue_dir, read_json_safe
    qdir = queue_dir()
    if not qdir:
        abort(404)

    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for candidate in drafting_root.rglob(f"{task_id}.json"):
            data = read_json_safe(candidate)
            if data:
                return jsonify({**data, "_foundState": "drafting", "_costSummary": _task_cost_summary(task_id), "_filesTouched": _files_touched_for(data), "_requestInput": _task_input_summary(data), "_workLog": _work_log_for(task_id), "_incomingLinks": _incoming_task_links(task_id), "_outgoingLinks": _outgoing_task_links(task_id)})

    def _payload(data, found_state):
        return jsonify({**data, "_foundState": found_state, "_costSummary": _task_cost_summary(task_id), "_filesTouched": _files_touched_for(data), "_requestInput": _task_input_summary(data), "_workLog": _work_log_for(task_id), "_incomingLinks": _incoming_task_links(task_id), "_outgoingLinks": _outgoing_task_links(task_id)})

    for state in QUEUE_STATES:
        data = read_json_safe(qdir / state / f"{task_id}.json")
        if data:
            return _payload(data, state)

    # A job-log / recent-tasks row can point at a task that has since been archived (by the
    # daily done-archive pass or by hand) or that lives in adhoc/ -- none of which are in
    # QUEUE_STATES. Check those too so the row still opens.
    data = read_json_safe(qdir / "adhoc" / f"{task_id}.json")
    if data:
        return _payload(data, "adhoc")
    data = read_json_safe(qdir / "done" / "_archived_no_action" / f"{task_id}.json")
    if data:
        return _payload(data, "archived")
    dated_archive_root = qdir / "done" / "_archived"
    if dated_archive_root.is_dir():
        for month_dir in sorted(dated_archive_root.iterdir(), reverse=True):
            if not month_dir.is_dir():
                continue
            data = read_json_safe(month_dir / f"{task_id}.json")
            if data:
                return _payload(data, "archived")

    abort(404, description=f"task {task_id} not found in any queue state")


@task_anywhere_1_more_bp.route("/api/task-anywhere/<task_id>/premium-priority", methods=["POST"])
def api_task_set_premium_priority(task_id):
    """Persistent, cross-retry claim-priority override (2026-09-07, Grimmethy: "I'll need
    a way in app to be able to set that premium priority slot for any specific task. I am
    getting tired of manually selecting it for the worker queue every pass.").

    Sets/clears task.premiumPriority -- next-claimable-task.js's effectivePriority() sorts
    a premiumPriority task ahead of EVERY other pending item regardless of source, and
    (unlike the Workers tab's assign-task pinnedWorker, which local-draft.js deletes the
    instant the task is claimed -- a deliberate one-shot override) this is never
    auto-cleared: it survives every retry/requeue cycle until the operator turns it off
    here again, or the task reaches a terminal state and stops being read by claim
    ranking at all. This is what actually closes "manually selecting it every pass" --
    pinnedWorker is still the right tool for "run THIS on THAT lane right now"; this is
    for "keep this at the front of the queue no matter which lane gets to it next."

    Works on a task wherever it currently sits (pending, blocked, needs-clarification,
    drafting, adhoc, ...) -- an operator flagging a task that's mid-retry-cycle (like the
    file-decompose move this feature was built for, which was cycling blocked <-> pending
    for hours) needs to be able to set this BEFORE it's back in pending/, not only once
    it happens to be there. Body: {"enabled": true|false}, defaults to true."""
    from app import _find_live_task_file, queue_dir, read_json_safe
    body = request.get_json(silent=True) or {}
    enabled = bool(body.get("enabled", True))

    qdir = queue_dir()
    if not qdir:
        abort(404)
    target = _find_live_task_file(qdir, task_id)
    if not target:
        abort(404, description=f"'{task_id}' not found in any live queue state")

    data = read_json_safe(target)
    if not data:
        abort(500, description="could not read the task file")

    if enabled:
        data["premiumPriority"] = True
    else:
        data.pop("premiumPriority", None)
    data.setdefault("history", []).append({
        "stage": "advisory", "at": datetime.now(timezone.utc).isoformat(),
        "detail": f"premium priority {'set' if enabled else 'cleared'} by operator override",
    })
    target.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return jsonify({"id": task_id, "premiumPriority": enabled})


@task_anywhere_1_more_bp.route("/api/task-anywhere/<task_id>/hub-priority", methods=["POST"])
def api_task_set_hub_priority(task_id):
    """Operator-set priority for a coordinating HUB (2026-09-09, Grimmethy: "I'd like the
    hubs to be sortable ... by priority. Priority tagging for hubs doesn't exist yet ...
    The highest priority hub should always be worked on next until it is either ready to
    merge or gets blocked").

    Body: {"priority": <int>} to rank it (LOWER = more urgent), or {"priority": null} to
    clear the ranking. Writes `hubPriority` onto the hub's own JSON. It is never
    auto-cleared -- it survives every coordinator-sweep reconcile, same discipline as
    `premiumPriority`. src/hub-priority.js reads this field on BOTH the Hub Tasks tab's
    default sort and the worker claim order for the hub's children, so ranking a hub here
    actually changes what gets worked next, not just how the list looks.

    Only meaningful on a coordinating task; a non-hub target is rejected so a stray call
    can't stamp the field somewhere it will never be read."""
    from app import queue_dir, read_json_safe
    body = request.get_json(silent=True) or {}
    raw = body.get("priority", None)
    if raw is None or raw == "":
        priority = None
    else:
        try:
            priority = int(raw)
        except (TypeError, ValueError):
            abort(400, description="priority must be an integer or null")

    qdir = queue_dir()
    if not qdir:
        abort(404)
    target = qdir / "coordinating" / f"{task_id}.json"
    if not target.is_file():
        abort(404, description=f"'{task_id}' is not a coordinating hub -- hub priority only applies there")

    data = read_json_safe(target)
    if not data:
        abort(500, description="could not read the hub file")

    if priority is None:
        data.pop("hubPriority", None)
    else:
        data["hubPriority"] = priority
    data.setdefault("history", []).append({
        "stage": "advisory", "at": datetime.now(timezone.utc).isoformat(),
        "detail": (f"hub priority set to {priority} by operator override"
                   if priority is not None else "hub priority cleared by operator override"),
    })
    target.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return jsonify({"id": task_id, "hubPriority": priority})


@task_anywhere_1_more_bp.route("/api/discuss/<session_id>/message", methods=["POST"])
def api_discuss_message(session_id):
    from app import _call_discuss, _resolve_discuss_session
    kind, storage_dir, existing = _resolve_discuss_session(session_id)
    if not storage_dir:
        abort(404)
    body = request.get_json(silent=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        abort(400, description="message is required")
    from discuss_sessions import send_message
    session = _call_discuss(send_message, storage_dir, session_id, message)
    if not session:
        abort(404)
    return jsonify(session)


@task_anywhere_1_more_bp.route("/api/discuss/<session_id>", methods=["GET"])
def api_discuss_get(session_id):
    from app import _resolve_discuss_session
    kind, storage_dir, session = _resolve_discuss_session(session_id)
    if not session:
        abort(404)
    return jsonify(session)


@task_anywhere_1_more_bp.route("/api/discuss/<session_id>/end", methods=["POST"])
def api_discuss_end(session_id):
    """Ends the conversation and, if it produced a real summary, applies it to whatever
    it was discussing:
    - brain-dump entry: appended to rawText, reusing PUT /api/brain-dump/<id>'s own
      sorted->captured reset logic (a discussion that adds real context is exactly the
      kind of text change that should make a stale prior sort get re-evaluated).
    - vault note: appended as a "## Discuss session -- <date>" section, same convention
      grill_sessions.py's enrich_note() already uses for Grill Me/Grill With Docs.
    - held queue/needs-clarification/ task: appended to promptContext.rawText, AND
      reopened for another path_prefetch_resolve attempt (suggestionAttempted cleared,
      any stale suggestion dropped) -- per the actual ask: discussing a held task should
      leave you with a real shot at an automatic resolution, not just more text sitting
      next to the same manual picker you started with.
    discuss_sessions.py deliberately never touches any of these data stores itself --
    this is the one place that happens, same division of responsibility as every other
    mutation of any of them in this file."""
    from app import _call_discuss, _resolve_discuss_session, _resolve_under_second_brain, queue_dir, read_brain_dump_entries, read_json_safe, second_brain_dir, write_brain_dump_entries
    kind, storage_dir, existing = _resolve_discuss_session(session_id)
    if not storage_dir:
        abort(404)
    from discuss_sessions import end_session
    session = _call_discuss(end_session, storage_dir, session_id)
    if not session:
        abort(404)

    entry = None
    note_updated = False
    held_task = None
    summary = (session.get("summary") or "").strip()
    if summary and kind == "brain-dump":
        entries = read_brain_dump_entries()
        entry = next((e for e in entries if e.get("id") == session["subjectId"]), None)
        if entry:
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            entry["rawText"] = f"{entry['rawText']}\n\n[Discussed {stamp}]: {summary}"
            if entry.get("status") == "sorted":
                entry["status"] = "captured"
                entry.pop("sort", None)
            entry["editedAt"] = datetime.now(timezone.utc).isoformat()
            write_brain_dump_entries(entries)
    elif summary and kind == "second-brain":
        root = second_brain_dir()
        if root:
            note_path = _resolve_under_second_brain(root.resolve(), session["subjectId"])
            if note_path.is_file():
                stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                entry_text = f"\n\n## Discuss session -- {stamp}\n\n{summary}\n"
                note_path.write_text(note_path.read_text(encoding="utf-8") + entry_text, encoding="utf-8")
                note_updated = True
    elif summary and kind == "needs-clarification":
        qdir = queue_dir()
        if qdir:
            held_path = qdir / "needs-clarification" / f"{session['subjectId']}.json"
            held_task = read_json_safe(held_path)
            if held_task:
                stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                ctx = held_task.setdefault("promptContext", {})
                ctx["rawText"] = f"{ctx.get('rawText', '')}\n\n[Discussed {stamp}]: {summary}"
                nc = held_task.setdefault("needsClarification", {})
                if nc.get("reason") == "design-decision":
                    # 2026-08-24 (adhoc-agentic-draft.js's RESOLUTION: needs-human-
                    # decision): a real product/design question, not path_prefetch_
                    # resolve's ambiguous-file-path picker -- this task never had
                    # suggested/suggestionAttempted/highReasoningAttempted/attempt in the
                    # first place, so touching those fields would just fabricate a shape
                    # nothing else here ever wrote. The discussion is already folded into
                    # promptContext.rawText above; the task stays in needs-clarification/
                    # exactly as-is, ready for the existing generic /resolve endpoint
                    # (already reused unchanged) to send it to queue/adhoc/ for a fresh
                    # agentic draft once a human decides it's ready.
                    pass
                else:
                    nc.pop("suggested", None)
                    nc["suggestionAttempted"] = False
                    # Brain Dump #77: reset alongside suggestionAttempted so a human-
                    # reopened task gets a fresh automatic low-then-high reasoning pair
                    # again, not just the low tier (see task-sources.js's
                    # nextPathPrefetchResolveTask()).
                    nc["highReasoningAttempted"] = False
                    # Bumped so nextPathPrefetchResolveTask()'s resolve-task id includes
                    # the attempt number -- without this, a second attempt's id collides
                    # with the first attempt's now-done/ file forever (taskIdExistsInQueue()
                    # checks done/ too), silently blocking every re-attempt after Discuss.
                    nc["attempt"] = nc.get("attempt", 1) + 1
                held_path.write_text(json.dumps(held_task, indent=2), encoding="utf-8")

    return jsonify({"session": session, "entry": entry, "noteUpdated": note_updated, "heldTask": held_task})
