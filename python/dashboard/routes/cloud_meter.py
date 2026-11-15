from flask import Blueprint, jsonify

import json
import urllib.request

# app.py helpers (worker_lane_defs) are imported lazily inside the view, same circular-import pattern as routes/capability.py.

cloud_meter_bp = Blueprint("cloud-meter-bp", __name__)

METER_TIMEOUT_S = 3


def _http_get_json(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _switched_off(lane_id, disabled):
    """True when the lane's worker is switched off. `disabled` is a callable returning the set of switched-off worker ids (worker_switch.disabled_workers); it is only called when the
    meter could not be read, so a healthy gateway costs nothing extra. Fails open: anything odd means 'not switched off', i.e. the old error text."""
    if not lane_id:
        return False
    try:
        return lane_id in disabled()      # disabled=None (no lookup given) raises TypeError here and means 'not switched off'
    except Exception:  # noqa: BLE001
        return False


def _unavailable(base, error, disabled):
    out = {**base, "available": False, "error": error}
    if _switched_off(base.get("laneId"), disabled):
        out["switchedOff"] = True
    return out


def build_cloud_meter(lanes, fetch, disabled=None):
    """The Workers tab's Cloud spend panel payload. `lanes` are the lane definitions (src/lanes.js, via worker_lane_defs()); `fetch(url, timeout)` returns
    the parsed JSON of a GET. With no cloud lane it says so ({cloudLane: False}) and the panel stays hidden. The meter is read from the cloud lane's own
    endpoint (the cloud-providers gateway), so the lane registry stays the single source for where it lives. A gateway that is down, slow or answers
    garbage yields {available: False, error} -- never an exception, so the tab never shows an error page for a plugin that is simply not running. When the lane's worker is
    switched off (the Workers-tab Turn off button) and the meter cannot be read, the payload also carries switchedOff: True and the panel says the lane is switched off instead of
    calling a gateway that was stopped on purpose "not reachable" (2026-11-02). A refused connection is instant, so the gateway is still tried: if someone starts it while the lane is
    off, the real spend shows."""
    lane = next((l for l in lanes or [] if l.get("cloud") is True), None)
    if lane is None:
        return {"cloudLane": False, "available": False}
    base = {"cloudLane": True, "laneId": lane.get("id")}
    endpoint = str((lane.get("env") or {}).get("OLLAMA_URL") or "").rstrip("/")
    if not endpoint:
        return _unavailable(base, "the cloud lane has no endpoint", disabled)
    try:
        meter = fetch(endpoint + "/meter", METER_TIMEOUT_S)
    except Exception as exc:  # down, timed out, refused, or not JSON: all mean "not available right now"
        return _unavailable(base, str(exc)[:200], disabled)
    if not isinstance(meter, dict):
        return _unavailable(base, "the gateway answered with something that is not a meter", disabled)
    return {**meter, **base, "available": True}


@cloud_meter_bp.route("/api/cloud-meter")
def api_cloud_meter():
    """Month-to-date and today's cloud spend, the cap state and the gateway's provider and model, for the Workers tab. See build_cloud_meter."""
    from app import worker_lane_defs
    from worker_switch import disabled_workers
    return jsonify(build_cloud_meter(worker_lane_defs(), _http_get_json, disabled=disabled_workers))
