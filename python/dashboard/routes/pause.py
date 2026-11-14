"""Machine pause routes: GET /api/pause, POST /api/pause/<scope>, POST /api/resume/<scope> (scope node or global). A thin view over src/worker-switch.js, like the
per-worker switch in routes/instances.py (this blueprint is nested under instances_bp there, so app.py needs no change). See docs/agents/lanes.md
"Pausing a machine"."""
from flask import Blueprint, abort, jsonify, request

pause_bp = Blueprint("pause-bp", __name__)


@pause_bp.route("/api/pause")
def api_pause_status():
    """Machine pauses (src/worker-switch.js `_pause-node` / `_pause-global`): {node, global, workers}. Read in-process, never starts node."""
    from worker_switch import pause_status
    return jsonify(pause_status())


@pause_bp.route("/api/pause/<scope>", methods=["POST"])
def api_pause_set(scope):
    """Pause this machine (scope node) or the whole system (scope global): body {"reason": text?, "ttlMin": positive number?}. Without ttlMin the pause lasts
    until resumed. Like the worker switch it only writes a marker file; the pipeline is not touched and running tasks finish. Source is recorded as `dashboard`."""
    from worker_switch import PAUSE_SCOPES, pause_status, set_pause
    if scope not in PAUSE_SCOPES:
        abort(400, description=f"scope must be one of {', '.join(PAUSE_SCOPES)}")
    body = request.get_json(silent=True) or {}
    reason = body.get("reason")
    if reason is not None and not isinstance(reason, str):
        abort(400, description="reason must be text")
    ttl = body.get("ttlMin")
    if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not 0 < ttl <= 10080):
        abort(400, description="ttlMin must be a number of minutes between 0 and 10080")
    ok, error = set_pause(scope, (reason or "")[:200], ttl)
    if not ok:
        abort(500, description=error)
    return jsonify(pause_status())


@pause_bp.route("/api/resume/<scope>", methods=["POST"])
def api_pause_clear(scope):
    """Resume this machine (scope node) or the whole system (scope global): removes the pause marker, whoever set it (an automatic source pauses again by itself if its condition still holds)."""
    from worker_switch import PAUSE_SCOPES, clear_pause, pause_status
    if scope not in PAUSE_SCOPES:
        abort(400, description=f"scope must be one of {', '.join(PAUSE_SCOPES)}")
    ok, error = clear_pause(scope)
    if not ok:
        abort(500, description=error)
    return jsonify(pause_status())
