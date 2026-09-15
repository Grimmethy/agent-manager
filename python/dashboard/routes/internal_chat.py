"""Internal API for the standalone Chat plugin (agent-manager-chat-plugin) -- Phase 2 of
extracting Chat into its own repo, see /home/wok/.claude/plans/immutable-noodling-axolotl.md.

Phase 1 built the plugin as its own process, but pointed it directly at this repo's own
instances/, queue/, and src/local-tool-client.js via AGENT_MANAGER_CORE_REPO_ROOT -- the
same direct-filesystem coupling the in-tree Chat feature always had, just relocated.
These four routes are the small, stable seam that replaces that: the plugin calls HERE
instead, and every genuinely pipeline-internal concern (the preempt chain's SIGKILL
authority, the GPU single-flight lock, the tool-loop's getConfig()/queue/ coupling) stays
host-side, wrapped rather than exposed. See chat_preempt.py's own header and the plan's
"Why host-side, not direct filesystem/process access" section for the reasoning.

Added here ADDITIVELY, zero behavior change to the still-live in-tree routes/chat.py --
nothing calls these yet. Phase 3 switches the plugin repo's own local-turn/preempt/
reserve/roots calls from direct access to these routes instead.

Loopback-only: every route requires the X-Internal-Token header to match
AGENT_MANAGER_INTERNAL_TOKEN (agent-manager.env), not because of an external threat model
(the plugin process runs as the same local user and could reach instances//queue/
directly regardless) but so this never accidentally becomes a route some OTHER iframe'd
plugin tab (PromptForge etc.) could reach.
"""
import hmac
import json
import os
import threading
import time

from flask import Blueprint, Response, abort, jsonify, request, stream_with_context

internal_chat_bp = Blueprint("internal-chat-bp", __name__)

# Own registry, deliberately SEPARATE from app.py's own _chat_reservations (the in-tree
# Chat feature's dict, still live and still swept by app.py's _chat_reservation_watchdog
# thread today). Reusing that dict was the first draft of this route -- caught before
# any real caller existed: that watchdog directly indexes r["lastActivity"] and
# record["storageDir"] on every entry it sweeps, and calls chat_sessions.set_reserved()
# against storageDir on timeout, both of which this route's own entries never had
# (session storage now lives in the plugin repo's own process, not reachable by path
# from here) -- the very next sweep after this route created its first real entry would
# have KeyError'd that background thread. Keyed by the plugin's own opaque
# reservationId -> {"fh", "lastActivity"}.
_internal_chat_reservations = {}
_internal_chat_reservations_lock = threading.Lock()
INTERNAL_CHAT_RESERVATION_IDLE_TIMEOUT_S = 600  # same 10-minute window app.py's own uses


def _internal_chat_reservation_watchdog():
    """Own sweep loop, independent of app.py's _chat_reservation_watchdog -- releases
    the OS-level single-flight lock on a reservation nobody has refreshed in 10 minutes
    (a crashed/forgotten toggle). Does NOT reach into the plugin's own session storage
    to clear its `reserved` flag the way the in-tree watchdog does for its own dict --
    that storage is a different process's, not this one's, to write into. The plugin
    repo's own chat_sessions.py must poll or otherwise notice the lock is gone on its
    next call if it wants to keep that flag honest; a stale `reserved: true` badge in
    the UI after an idle timeout is a cosmetic gap, not a functional one (the underlying
    lock IS actually released, which is the part that matters for GPU contention)."""
    import single_flight_lock
    while True:
        time.sleep(60)
        now = time.time()
        with _internal_chat_reservations_lock:
            stale_ids = [rid for rid, r in _internal_chat_reservations.items()
                         if now - r["lastActivity"] > INTERNAL_CHAT_RESERVATION_IDLE_TIMEOUT_S]
            stale_records = [_internal_chat_reservations.pop(rid) for rid in stale_ids]
        for record in stale_records:
            single_flight_lock.release(record["fh"])


def start_internal_chat_reservation_watchdog():
    """NOT started at module import time -- app.py's own _chat_reservation_watchdog is
    only started inside main(), right before app.run(), specifically so a plain `import
    app` (every test file's own setup) never spins up a real background thread. This
    mirrors that: app.py's main() must call this alongside its own watchdog start."""
    threading.Thread(target=_internal_chat_reservation_watchdog, name="internal-chat-reservation-watchdog", daemon=True).start()


def _require_internal_token():
    from app import ENV_FILE_PATH, read_env_file
    expected = os.environ.get("AGENT_MANAGER_INTERNAL_TOKEN") or read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_INTERNAL_TOKEN")
    if not expected:
        abort(500, description="AGENT_MANAGER_INTERNAL_TOKEN is not configured -- the internal chat API cannot authorize callers")
    got = request.headers.get("X-Internal-Token", "")
    if not hmac.compare_digest(got, expected):
        abort(403, description="missing or invalid X-Internal-Token")


@internal_chat_bp.route("/api/internal/chat/roots", methods=["GET"])
def api_internal_chat_roots():
    """Wraps _chat_roots() -- the ordered, deduped list of every repo the Chat plugin
    can touch (this repo + every enabled plugin's repo + every registered project)."""
    _require_internal_token()
    from app import _chat_roots
    return jsonify({"roots": _chat_roots()})


@internal_chat_bp.route("/api/internal/chat/preempt", methods=["POST"])
def api_internal_chat_preempt():
    """Wraps _preempt_pipeline_for_chat() -- kills the worker lanes' in-flight draft
    (unconditionally) and the reviewer's (age-gated) to free the GPU for a local-provider
    chat turn. See chat_preempt.py's own header for the full rationale. Returns
    {preempted: [...]} -- an empty list if preemption is disabled
    (AGENT_MANAGER_CHAT_PREEMPT=false) or nothing was in flight."""
    _require_internal_token()
    from app import _chat_preempt_enabled, _preempt_pipeline_for_chat
    if not _chat_preempt_enabled():
        return jsonify({"preempted": []})
    try:
        preempted = _preempt_pipeline_for_chat()
    except Exception as e:  # noqa: BLE001 -- best-effort, never fail the caller's turn on this
        return jsonify({"preempted": [], "error": str(e)})
    return jsonify({"preempted": preempted})


@internal_chat_bp.route("/api/internal/chat/reserve", methods=["POST"])
def api_internal_chat_reserve():
    """Wraps single_flight_lock's reservation toggle -- holding the local model's own
    per-model lock across turns, not just for the span of one call (Brain Dump #153).
    Body: {reservationId: string, model: string, on: bool}. reservationId is the
    plugin's own session id, opaque to this route -- just a key into
    _internal_chat_reservations (see this module's own header for why that is a
    SEPARATE registry from app.py's in-tree _chat_reservations, not a shared one).

    Calling again with on:true while already on is a valid, expected refresh -- not a
    no-op -- it re-touches lastActivity so this module's own idle-timeout watchdog
    doesn't release the lock out from under an active conversation; routes/chat.py's own
    in-tree equivalent does this same refresh on every real message."""
    _require_internal_token()
    from app import instances_dir
    import single_flight_lock

    body = request.get_json(silent=True) or {}
    reservation_id = (body.get("reservationId") or "").strip()
    model = (body.get("model") or "").strip()
    want_on = bool(body.get("on"))
    if not reservation_id:
        abort(400, description="reservationId is required")

    # Same two-short-critical-sections shape as the in-tree route's own comment: acquire()
    # BLOCKS (the real GPU/model mutex), so it must never run while holding
    # _internal_chat_reservations_lock, or every other Chat request would stall for the
    # same duration.
    with _internal_chat_reservations_lock:
        already_on = reservation_id in _internal_chat_reservations
        claiming = want_on and not already_on
        releasing_record = _internal_chat_reservations.pop(reservation_id) if (not want_on and already_on) else None
        if already_on and want_on:
            _internal_chat_reservations[reservation_id]["lastActivity"] = time.time()
        if claiming:
            _internal_chat_reservations[reservation_id] = {"fh": None, "lastActivity": time.time()}

    if releasing_record is not None:
        single_flight_lock.release(releasing_record["fh"])
    if claiming:
        if not model:
            with _internal_chat_reservations_lock:
                _internal_chat_reservations.pop(reservation_id, None)
            abort(400, description="model is required when reserving")
        inst_dir = instances_dir()
        if not inst_dir:
            with _internal_chat_reservations_lock:
                _internal_chat_reservations.pop(reservation_id, None)
            abort(500, description="no active project's instances dir resolvable")
        fh = single_flight_lock.acquire(inst_dir, model)  # blocking
        with _internal_chat_reservations_lock:
            _internal_chat_reservations[reservation_id] = {"fh": fh, "lastActivity": time.time()}

    return jsonify({"reservationId": reservation_id, "reserved": want_on})


@internal_chat_bp.route("/api/internal/chat/local-turn", methods=["POST"])
def api_internal_chat_local_turn():
    """Wraps local_tool_client.stream_plan_with_tools() -- the local model's multi-turn
    tool-calling loop, streamed back as SSE in the exact same {"type": "chunk"|"final",
    ...} chunk shape that function itself yields. The caller (the plugin repo's own
    chat_sessions.py) is responsible for calling /preempt first and holding a reservation
    if it wants one -- this route does not do either implicitly, so a caller that already
    holds the GPU lock via /reserve doesn't pay for a redundant preempt call on every turn.

    Body: {messages?, prompt?, maxTurns, source?, allowWrite?, primaryRoot?, extraRoots?,
    forceSummaryOnCap?, allowAmplification?, contextLogSessionId?} -- same fields
    local_tool_client.py's own stream_plan_with_tools() already takes, passed straight
    through.

    2026-09-15 fix (caught before this route had any real caller yet -- see the plan's
    Phase 3 progress log): the in-tree feature this route replaces held
    single_flight_lock.priority_marker() for the WHOLE turn (refreshed by a daemon
    thread), not just the initial preempt call -- see that context manager's own header.
    Without it, a worker/reviewer daemon respawns and reclaims the GPU BETWEEN this
    tool-loop's own turns, and the call starves with no output (confirmed live
    2026-09-02, the original incident this mechanism exists for). This route's first
    draft omitted it entirely."""
    _require_internal_token()
    import contextlib

    import single_flight_lock
    from app import instances_dir
    from local_tool_client import LocalToolClientError, stream_plan_with_tools

    body = request.get_json(silent=True) or {}
    inst_dir = instances_dir()

    def generate():
        marker_cm = single_flight_lock.priority_marker(inst_dir) if inst_dir else contextlib.nullcontext()
        with marker_cm:
            try:
                for event in stream_plan_with_tools(
                    messages=body.get("messages"),
                    prompt=body.get("prompt"),
                    max_turns=body.get("maxTurns", 5),
                    source=body.get("source"),
                    allow_write=bool(body.get("allowWrite")),
                    primary_root=body.get("primaryRoot"),
                    extra_roots=body.get("extraRoots"),
                    force_summary_on_cap=bool(body.get("forceSummaryOnCap")),
                    allow_amplification=bool(body.get("allowAmplification")),
                    context_log_session_id=body.get("contextLogSessionId"),
                ):
                    yield f"data: {json.dumps(event)}\n\n"
            except LocalToolClientError as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
            except (TimeoutError, ConnectionError, OSError) as e:
                yield f"data: {json.dumps({'type': 'error', 'error': f'local model call failed ({e})'})}\n\n"

    return Response(stream_with_context(generate()), mimetype="text/event-stream")
