"""GET /api/stream -- the dashboard's server-sent-event channel (event_stream.py). Piece 1 of 'UI triggers, not polls': the server half; the page does not use it yet."""
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
    return {"memory-changed": event_stream.json_file_fact(memory_status.marker_path, lambda d: (d.get("state"), str(d.get("reason") or "")))}


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
