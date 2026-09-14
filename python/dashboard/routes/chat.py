from flask import Blueprint, Response, abort, jsonify, request, session, stream_with_context

import contextlib
import json
import sys
import time

# The app.py helpers these views call (CHAT_STORAGE_DIR, _call_chat, _chat_preempt_enabled, _chat_reservations, _chat_reservations_lock, _chat_roots, _discuss_provider_args, _preempt_pipeline_for_chat, instances_dir) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

chat_bp = Blueprint("chat-bp", __name__)

@chat_bp.route("/api/chat/active", methods=["GET"])
def api_chat_active():
    """Loads (or creates, if none exists yet) the single ongoing system-wide
    conversation -- called on dashboard load so the panel shows where you left off."""
    from app import CHAT_STORAGE_DIR, _call_chat, _chat_roots, instances_dir
    from chat_sessions import get_active_session, PROVIDER_LOCAL
    session = _call_chat(get_active_session, CHAT_STORAGE_DIR, _chat_roots(),
                           instances_dir(), provider=PROVIDER_LOCAL)
    return jsonify(session)


@chat_bp.route("/api/chat/new", methods=["POST"])
def api_chat_new():
    """Starts a fresh conversation, ending whatever's currently active. Body:
    {provider?, model?, effort?} -- same _discuss_provider_args fallback (local by
    default) every other Discuss-family start route already uses."""
    from app import CHAT_STORAGE_DIR, _call_chat, _chat_roots, _discuss_provider_args, instances_dir
    from chat_sessions import start_new_conversation
    provider, model, effort = _discuss_provider_args()
    session = _call_chat(start_new_conversation, CHAT_STORAGE_DIR, _chat_roots(),
                           instances_dir(), provider=provider, model=model, effort=effort)
    return jsonify(session)


@chat_bp.route("/api/chat/inject", methods=["POST"])
def api_chat_inject():
    """Appends a chunk of text as a user message into a dashboard chat session for
    follow-up -- the single endpoint the dashboard's "Send to chat" buttons (task
    detail, Brain Dump) POST the task log / brain-dump text to. It only RECORDS the
    user turn (persisted, visible in the panel); it deliberately does NOT call the
    model -- the user reads the injected context and then sends their own follow-up
    question via the normal /api/chat/<session_id>/message route.

    Body: {text: string, sessionId?: string}. Without sessionId: the currently active
    session is used (get_active_session creates one if none exists yet, matching what
    /api/chat/active does on panel load); if that still yields nothing a brand-new
    conversation is started. Either way the resulting session id comes back in the
    response so the button's caller can link back to it."""
    from app import CHAT_STORAGE_DIR, _call_chat, _chat_roots, _discuss_provider_args, instances_dir
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        abort(400, description="text is required")

    from chat_sessions import get_active_session, get_session, inject_user_message
    from chat_sessions import start_new_conversation, PROVIDER_LOCAL

    session_id = (body.get("sessionId") or "").strip()
    if session_id:
        existing = get_session(CHAT_STORAGE_DIR, session_id)
        if not existing or existing.get("status") != "active":
            abort(404, description="no active chat session with that id")
    else:
        session = _call_chat(get_active_session, CHAT_STORAGE_DIR, _chat_roots(),
                             instances_dir(), provider=PROVIDER_LOCAL)
        session_id = (session or {}).get("id") or (session or {}).get("session_id")
        if not session_id:
            provider, model, effort = _discuss_provider_args()
            session = _call_chat(start_new_conversation, CHAT_STORAGE_DIR, _chat_roots(),
                                 instances_dir(), provider=provider, model=model, effort=effort)
            session_id = (session or {}).get("id") or (session or {}).get("session_id")
        if not session_id:
            abort(500, description="could not resolve or start a chat session")

    injected = _call_chat(inject_user_message, CHAT_STORAGE_DIR, session_id, text)
    if not injected:
        abort(404, description="no active chat session with that id")
    return jsonify({"session": injected, "sessionId": injected.get("id") or session_id})


@chat_bp.route("/api/chat/<session_id>/message", methods=["POST"])
def api_chat_message(session_id):
    """The actual chat turn.

    2026-08-24 -- this used to wrap the WHOLE call in the same git-safety mutex the
    merge-branch endpoint uses (_acquire_apply_lock/_release_apply_lock,
    app.py:3979-3999). Caught live within minutes of shipping: a local-provider turn can
    legitimately wait minutes just for the GPU lock (a busy worker lane), and held the
    apply-lock that entire time even though most turns never touch git at all -- a second,
    completely unrelated Chat message (or a real click from Grimmethy, confirmed live)
    got "the pipeline is mid-apply right now" while nothing was actually applying,
    because THIS request was sitting on the mutex for no reason. Exactly the lesson
    single-flight-lock.js's own header already documents from an earlier incident:
    holding a lock across a call's ENTIRE span instead of just the piece that needs it
    turns a narrow, real protection into broad, needless contention.

    Fix: git safety now lives at the point a git-mutating command actually runs, not
    here. local-tool-client.js's runBashTool acquires the SAME apply-task.lock (flock,
    cross-language-compatible, same file apply-task.sh/api_git_merge_branch already use)
    for just the span of each individual command -- see that function's own comment.
    Claude's own Edit/Write/Bash tool calls happen inside the `claude` CLI's own internal
    tool loop, which this codebase has no hook into at the per-call level, so they are
    NOT covered by this -- a known, real, narrower gap (git's own index.lock still turns
    a genuine collision into a clean failure to retry, not silent corruption) rather than
    a solved one; revisit if it causes a real incident."""
    from app import CHAT_STORAGE_DIR, _chat_preempt_enabled, _chat_reservations, _chat_reservations_lock, _preempt_pipeline_for_chat, instances_dir
    body = request.get_json(silent=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        abort(400, description="message is required")

    from chat_sessions import get_session
    existing = get_session(CHAT_STORAGE_DIR, session_id)
    if not existing or existing.get("status") != "active":
        abort(404)

    # 2026-08-26 (Open WebUI investigation, Grimmethy: "vastly improve the chat
    # system... streaming"): this used to be a single blocking send_message() call
    # returning the whole updated session as one JSON body -- the user stared at nothing
    # until the model finished (or the turn budget ran out), which is exactly why the
    # "ran out of its turn budget" explainer had to exist in the first place. Now
    # streamed as SSE: one `data:` frame per {"type":"chunk"} as text arrives, then one
    # {"type":"final","session":{...}} carrying the same shape this route used to return
    # in one shot, so the frontend still ends up with the same authoritative session.
    from chat_sessions import stream_message, PROVIDER_LOCAL
    from claude_client import ClaudeClientError
    from local_tool_client import LocalToolClientError
    import single_flight_lock

    is_local_turn = existing.get("provider") == PROVIDER_LOCAL
    inst_dir = instances_dir()

    # Make GPU space for a local-provider turn: kill both worker lanes' in-flight draft
    # (chat precludes workers), the reviewer's only if < ~3 min in. Synchronous, before the
    # SSE generator / node child runs. Claude-provider turns don't touch the local model.
    preempted = []
    if is_local_turn and _chat_preempt_enabled():
        try:
            preempted = _preempt_pipeline_for_chat()
        except Exception as e:  # noqa: BLE001 -- never block a chat turn on this
            print(f"[chat-preempt] failed (non-fatal): {e}", file=sys.stderr, flush=True)

    def generate():
        # Priority marker held for the WHOLE turn (model call + every tool-loop iteration in
        # the node child) and kept fresh by priority_marker's own daemon thread, so worker/
        # reviewer acquire() keeps yielding the GPU the entire time -- not just the ~8s the
        # bare marker used to cover. Killing a worker (above) only frees the GPU for an
        # instant; without this the worker daemon respawns and reclaims it between the
        # chat's tool-loop turns, and the turn starves with no output (confirmed live
        # 2026-09-02). Inside generate() so its teardown is bound to the SSE generator's
        # lifecycle (client disconnect -> GeneratorExit -> finally).
        marker_cm = (single_flight_lock.priority_marker(inst_dir)
                     if (is_local_turn and inst_dir) else contextlib.nullcontext())
        with marker_cm:
            if preempted:
                yield f"data: {json.dumps({'type': 'preempt', 'lanes': preempted})}\n\n"
            try:
                for event in stream_message(CHAT_STORAGE_DIR, session_id, message):
                    yield f"data: {json.dumps(event)}\n\n"
            except ClaudeClientError as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
            except LocalToolClientError as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
            except (TimeoutError, ConnectionError, OSError) as e:
                yield f"data: {json.dumps({'type': 'error', 'error': f'local model call failed ({e}) -- it may be busy with an active worker-lane task; try again shortly.'})}\n\n"

    # Reserved sessions refresh their own idle clock on every real message -- same
    # liveness-refresh shape a worker instance's own heartbeat already follows.
    with _chat_reservations_lock:
        if session_id in _chat_reservations:
            _chat_reservations[session_id]["lastActivity"] = time.time()

    return Response(stream_with_context(generate()), mimetype="text/event-stream")


@chat_bp.route("/api/chat/<session_id>/reserve", methods=["POST"])
def api_chat_reserve(session_id):
    """Toggles "fully reserving the reasoning model" (Brain Dump #153) for this session --
    holding the reasoning model's own per-model lock (instances/.pipeline-single-flight.
    <model>.lock -- see single_flight_lock.py's own header for the 2026-08-25 per-model
    keying this relies on) across turns, not just for the span of one call. Since
    2026-08-25 this only idles whatever else is contending for THAT specific model
    (worker-reasoning, local-tool-client.js's arch_discovery/Chat-with-tools calls,
    Discuss's local provider) -- a cheap-model lane like worker-1's brain_dump_sort
    traffic keeps running unaffected, unlike before this locking was split per-model.
    Body: {on: bool}. Only meaningful for the local provider (Claude has no shared-
    resource lock, per the earlier decision not to lock Claude calls against each
    other)."""
    from app import CHAT_STORAGE_DIR, _chat_reservations, _chat_reservations_lock, instances_dir
    from chat_sessions import get_session, set_reserved, PROVIDER_LOCAL
    import single_flight_lock

    session = get_session(CHAT_STORAGE_DIR, session_id)
    if not session:
        abort(404)
    if session.get("provider") != PROVIDER_LOCAL:
        abort(400, description="reservation only applies to the local provider")

    body = request.get_json(silent=True) or {}
    want_on = bool(body.get("on"))

    # single_flight_lock.acquire() BLOCKS (it's the real GPU/model mutex, can wait as
    # long as a worker lane's current call takes) -- must never be called while holding
    # _chat_reservations_lock, or every other Chat request (another session's own
    # message, another reserve toggle) would stall for the same duration. Two short,
    # separate critical sections instead: check-and-claim first, do the real (possibly
    # slow) acquire/release outside the lock, then record the result.
    with _chat_reservations_lock:
        already_on = session_id in _chat_reservations
        claiming = want_on and not already_on
        releasing_record = _chat_reservations.pop(session_id) if (not want_on and already_on) else None
        if claiming:
            # Reserve the dict slot now (before the blocking acquire below) so a second,
            # concurrent toggle-on request for the SAME session can't also start
            # acquiring -- filled in with the real fh once acquire() returns.
            _chat_reservations[session_id] = {"fh": None, "lastActivity": time.time(), "storageDir": CHAT_STORAGE_DIR}

    if releasing_record is not None:
        single_flight_lock.release(releasing_record["fh"])
    if claiming:
        inst_dir = instances_dir()
        if not inst_dir:
            with _chat_reservations_lock:
                _chat_reservations.pop(session_id, None)
            abort(500, description="no active project's instances dir resolvable")
        import ollama_client
        fh = single_flight_lock.acquire(inst_dir, ollama_client.MODEL)  # blocking -- may wait for a worker lane's current call on this same model
        with _chat_reservations_lock:
            _chat_reservations[session_id] = {"fh": fh, "lastActivity": time.time(), "storageDir": CHAT_STORAGE_DIR}

    session = set_reserved(CHAT_STORAGE_DIR, session_id, want_on)
    return jsonify(session)
