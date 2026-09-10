import json
from datetime import datetime, timezone

from flask import Blueprint, abort, jsonify, request

# NOTE: the helpers these views use (read_brain_dump_entries, write_brain_dump_entries,
# get_pipeline_dir, _call_discuss, ...) live in app.py, which imports THIS module to
# register the blueprint. Importing them at module top is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). Pull them in lazily
# inside each view instead -- by the time a view runs, app.py is fully initialised and
# `from app import ...` is just a dict lookup. (Same pattern as routes/concepts.py,
# routes/second_brain.py, routes/reports.py.)

brain_dump_bp = Blueprint("brain-dump-bp", __name__)


@brain_dump_bp.route("/api/brain-dump")
def api_brain_dump():
    """Brain Dump tab's left pane. Defaults to everything not yet actioned (captured +
    sorted) PLUS any actioned entry whose downstream task actually needs a human
    (blocked/needs-clarification) -- confirmed live 2026-08-16: every one of a real
    user's actioned entries had silently blocked, invisible under the old default filter
    (which excluded every actioned entry unconditionally, cleanly-completed or not) same
    as under the old flat "queued" badge. A genuinely still-in-progress or successfully
    completed actioned entry stays hidden by default -- only ?status=actioned/all
    surfaces those -- since there's nothing for a human to act on there.
    ?status=<value> narrows to one status, ?status=all returns the full history.

    BUG FIXED 2026-08-21 (Grimmethy: "Entry #129 is visible in both the processed and
    unprocessed tabs ... If an entry is not fully resolved it shouldn't be 'processed'"):
    ?status=actioned used to mean only "status field says actioned," which counts an
    entry whose downstream task is blocked/needs-clarification/awaiting-confirm as
    Processed even though it's simultaneously showing up in the default (Unprocessed)
    view for the exact opposite reason -- it still needs a human. "Processed" now means
    the same thing the default view's own inverse already implies: actioned AND not
    stuck waiting on a human, so an entry is in exactly one of Unprocessed/Processed,
    never both, and "not fully resolved" (this session's own words for it) can never
    read as processed."""
    from app import BRAIN_DUMP_NEEDS_ATTENTION_STATES, _brain_dump_entries_with_task_status
    entries = _brain_dump_entries_with_task_status()

    status_filter = request.args.get("status", "").strip()
    if status_filter == "actioned":
        entries = [
            e for e in entries
            if e.get("status") == "actioned" and e.get("taskStatus") not in BRAIN_DUMP_NEEDS_ATTENTION_STATES
        ]
    elif status_filter and status_filter != "all":
        entries = [e for e in entries if e.get("status") == status_filter]
    elif not status_filter:
        entries = [
            e for e in entries
            if e.get("status") != "actioned" or e.get("taskStatus") in BRAIN_DUMP_NEEDS_ATTENTION_STATES
        ]
    entries = sorted(entries, key=lambda e: e.get("capturedAt") or "", reverse=True)

    return jsonify(entries)


@brain_dump_bp.route("/api/brain-dump/capture", methods=["POST"])
def api_brain_dump_capture():
    """Dumb, synchronous append -- no LLM in the write path, same philosophy as
    queue-adhoc-task.js's manual task injection. The brain_dump_sort Ornith worker source
    picks unsorted ("captured") entries up from here asynchronously."""
    from app import brain_dump_path, read_brain_dump_entries, slugify_for_id, write_brain_dump_entries
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        abort(400, description="text is required")

    if not brain_dump_path():
        abort(500, description="no active project configured")

    # read_brain_dump_entries() backfills+persists a serial onto any pre-existing entry
    # that doesn't already have one, so `entries` here is always fully migrated before
    # next_serial is computed off it -- see _assign_brain_dump_serials()'s own header.
    entries = read_brain_dump_entries()
    next_serial = max((e.get("serial") or 0) for e in entries) + 1 if entries else 1

    entry_id = f"bd-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{slugify_for_id(text)}"
    entry = {
        "id": entry_id,
        "serial": next_serial,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "rawText": text,
        "status": "captured",
    }
    entries.append(entry)
    write_brain_dump_entries(entries)
    return jsonify(entry)


@brain_dump_bp.route("/api/brain-dump/<entry_id>", methods=["PUT"])
def api_brain_dump_edit(entry_id):
    """Edits an entry's raw text. If it had already been sorted, the sort result is tied
    to the OLD text -- keeping it around would show a category/destination that no longer
    reflects what's actually captured, so an edit resets the entry back to 'captured' and
    drops the stale sort, same as a fresh capture. brain_dump_sort picks it up again from
    there."""
    from app import read_brain_dump_entries, write_brain_dump_entries
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        abort(400, description="text is required")

    entries = read_brain_dump_entries()
    entry = next((e for e in entries if e.get("id") == entry_id), None)
    if not entry:
        abort(404)

    if entry.get("rawText") != text and entry.get("status") == "sorted":
        entry["status"] = "captured"
        entry.pop("sort", None)
    entry["rawText"] = text
    entry["editedAt"] = datetime.now(timezone.utc).isoformat()

    write_brain_dump_entries(entries)
    return jsonify(entry)


@brain_dump_bp.route("/api/brain-dump/<entry_id>", methods=["DELETE"])
def api_brain_dump_delete(entry_id):
    from app import read_brain_dump_entries, write_brain_dump_entries
    entries = read_brain_dump_entries()
    remaining = [e for e in entries if e.get("id") != entry_id]
    if len(remaining) == len(entries):
        abort(404)
    write_brain_dump_entries(remaining)
    return jsonify({"deleted": entry_id})


@brain_dump_bp.route("/api/brain-dump/<entry_id>/prioritize", methods=["POST"])
def api_brain_dump_prioritize(entry_id):
    """'Process this now' button: injects the entry straight into queue/adhoc/, the SAME
    preempt-everything lane queue-adhoc-task.js already uses (nextAdhocTask() in
    task-sources.js is checked before every deterministic source, including whatever
    brain_dump_sort/brain_dump_action end up being). Deliberately bypasses the sort stage
    rather than waiting on it -- this button means "a human wants this handled right now,"
    not "queue it for eventual triage."""
    from app import default_task_domain, get_pipeline_dir, read_brain_dump_entries, slugify_for_id, write_brain_dump_entries
    entries = read_brain_dump_entries()
    entry = next((e for e in entries if e.get("id") == entry_id), None)
    if not entry:
        abort(404)

    # Idempotency guard (2026-08-18): this endpoint used to create a brand-new task file
    # on every call, no matter how many times it was hit -- a double-click (or a slow
    # response plus an impatient re-click) queued the SAME entry twice, and the second
    # call's queuedTaskId write silently overwrote the first, orphaning it: a real task
    # file sitting in the queue that nothing -- not the Brain Dump tab, not the entry's
    # own record -- ever pointed back to again. Confirmed live: 7 real orphans found this
    # way in queue/needs-clarification/ alone. An already-actioned entry just returns its
    # existing queuedTaskId instead of minting a second one.
    if entry.get("status") == "actioned" and entry.get("queuedTaskId"):
        return jsonify(entry)

    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")

    task_id = f"adhoc-brain-dump-{slugify_for_id(entry['rawText'])}-{int(datetime.now(timezone.utc).timestamp() * 1000)}"
    record = {
        "id": task_id,
        "domain": default_task_domain(),
        "source": "manual",
        "title": entry["rawText"][:120],
        # humanQueued (2026-09-07, Grimmethy: "tasks that come from bot findings get
        # sorted into a lower priority than human entered adhoc tasks") -- clicking
        # "Process this now" is a real, explicit human decision about THIS entry, unlike
        # brain_dump_sort's own fully-autonomous actionable-classification queueing the
        # identical shape with no human ever looking at it. See
        # next-claimable-task.js's effectivePriority() for the other human-entry point
        # (queue-adhoc-task.js) and why `source` alone can't carry this signal.
        "humanQueued": True,
        "promptContext": {
            "rawText": entry["rawText"],
            "brainDumpEntryId": entry["id"],
            "sort": entry.get("sort"),
        },
    }
    adhoc_dir = pipeline_dir / "queue" / "adhoc"
    adhoc_dir.mkdir(parents=True, exist_ok=True)
    (adhoc_dir / f"{task_id}.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")

    entry["status"] = "actioned"
    entry["queuedTaskId"] = task_id
    entry["queuedAt"] = datetime.now(timezone.utc).isoformat()
    write_brain_dump_entries(entries)
    return jsonify(entry)


@brain_dump_bp.route("/api/brain-dump/<entry_id>/discuss/latest", methods=["GET"])
def api_brain_dump_discuss_latest(entry_id):
    """Same "don't silently start a duplicate session" check grill/for-note already does
    for Grill Me -- see discuss_sessions.py's latest_session_for_subject() for the
    incident that pattern traces back to."""
    from app import get_pipeline_dir
    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")
    from discuss_sessions import latest_session_for_subject
    session = latest_session_for_subject(pipeline_dir, entry_id)
    return jsonify(session)


@brain_dump_bp.route("/api/brain-dump/<entry_id>/discuss/start", methods=["POST"])
def api_brain_dump_discuss_start(entry_id):
    from app import _call_discuss, _discuss_provider_args, get_active_grep_dirs, get_active_repo_root, get_pipeline_dir, instances_dir, read_brain_dump_entries
    entries = read_brain_dump_entries()
    entry = next((e for e in entries if e.get("id") == entry_id), None)
    if not entry:
        abort(404)
    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")
    from discuss_sessions import start_session
    provider, model, effort = _discuss_provider_args()
    session = _call_discuss(start_session, pipeline_dir, entry_id, entry["rawText"], kind="brain-dump",
                             provider=provider, model=model, effort=effort, repo_root=get_active_repo_root(),
                             grep_dirs=get_active_grep_dirs(), instances_dir=instances_dir())
    return jsonify(session)
