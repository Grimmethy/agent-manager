"""GET /api/stream -- the dashboard's server-sent-event channel (event_stream.py). The page listens to it (static/js/live-updates.js); the pieces of 'UI triggers, not polls' that built it are listed in docs/adr/0024-triggers-not-polls.md."""
import os
import re

from flask import Blueprint, Response, jsonify, request, stream_with_context

import event_stream

event_stream_bp = Blueprint("event-stream-bp", __name__)
KEEPALIVE_S = 15.0     # a comment line so a dead connection is noticed; it carries no data and triggers no redraw


def _resolve():
    from app import instances_dir, queue_dir, PLUGINS_MANIFEST_PATH
    return {"queue": queue_dir(), "instances": instances_dir(), "plugins": PLUGINS_MANIFEST_PATH}


def _providers():
    """Facts the hub cannot derive from the queue directories. memory-changed: the host-memory chip's state and reason, from the gpu-broker's marker file."""
    import memory_status
    # The marker's reason carries live numbers ("memory stall 11.64%"): announce a change of the STATE or of the reason's wording, never of a number inside it.
    return {"settings-changed": event_stream.dir_files_fact(lambda: [], _settings_files),
            "worker-panels-changed": event_stream.dir_files_fact(_panel_specs, _panel_files), "memory-changed": event_stream.json_file_fact(memory_status.marker_path, lambda d: (d.get("state"), re.sub(r"\d+", "#", str(d.get("reason") or ""))))}


# The files the Workers tab's panels read (routes/stalled_worker.py, verifier_worker.py, needswork_worker.py, context_worker.py, pipeline_ops_workers.py, cloud_meter.py, worker_switch.py and the
# cost summary): the pipeline-ops workers' ledgers, indexes and on/off markers, the cloud gateway's spend ledger, the worker switch markers and the model-stats database. NOT their drain logs,
# beats, locks or trigger files: those are rewritten on every idle tick and would announce nothing new.
PANEL_FILE_RE = re.compile(r"(-ledger\.jsonl|-index\.json|-disabled)$")
WORKER_MARKER_RE = re.compile(r"^worker-[a-z0-9]+$")


def _panel_specs():
    import worker_switch
    from routes import context_worker
    ops = context_worker.state_dir()
    return [(ops, PANEL_FILE_RE), (os.path.join(ops, "gateway"), PANEL_FILE_RE), (worker_switch.switch_dir(), WORKER_MARKER_RE)]


def _settings_files():
    """The files the Job List tab's settings come from (routes/job_types.py): agent-manager.env (the task-source allowlist, priorities, approval modes, worker types) and dashboard-settings.json."""
    from app import ENV_FILE_PATH
    from app_settings_helpers import DASHBOARD_SETTINGS_PATH
    return [ENV_FILE_PATH, DASHBOARD_SETTINGS_PATH]


def _panel_files():
    from app import model_stats_db_path
    db = model_stats_db_path()
    return [db, (str(db) + "-wal") if db else None]


@event_stream_bp.route("/api/stream")
def api_stream():
    if not event_stream.enabled():
        return jsonify({"enabled": False}), 404
    hub = event_stream.get_hub(_resolve, _providers())
    try:
        last_id = int(request.headers.get("Last-Event-ID", ""))
    except ValueError:
        last_id = None

    def generate():
        seq = hub.subscribe()
        try:
            yield "retry: 3000\n\n"
            events, resync = ([], True) if last_id is None else hub.events_after(last_id, 0)
            if resync:
                yield event_stream.sse("snapshot", {"seq": seq, "events": hub.event_names()}, seq)
                cursor = seq
            else:
                cursor = last_id
                for e in events:
                    yield event_stream.sse(e["event"], e["data"], e["id"])
                    cursor = e["id"]
            while True:
                events, resync = hub.events_after(cursor, KEEPALIVE_S)
                if resync:
                    cursor = hub.status()["seq"]       # read once, BEFORE the yield: an event published while the snapshot is being sent must still be delivered next
                    yield event_stream.sse("snapshot", {"seq": cursor, "events": hub.event_names()}, cursor)
                    continue
                if not events:
                    yield ": keepalive\n\n"
                    continue
                for e in events:
                    yield event_stream.sse(e["event"], e["data"], e["id"])
                    cursor = e["id"]
        finally:
            hub.unsubscribe()

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
