from flask import Blueprint, jsonify

import json
import urllib.request

# app.py helpers (worker_lane_defs) are imported lazily inside the view, same circular-import pattern as routes/capability.py.

cloud_meter_bp = Blueprint("cloud-meter-bp", __name__)

METER_TIMEOUT_S = 3


def _http_get_json(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_cloud_meter(lanes, fetch):
    """The Workers tab's Cloud spend panel payload. `lanes` are the lane definitions (src/lanes.js, via worker_lane_defs()); `fetch(url, timeout)` returns
    the parsed JSON of a GET. With no cloud lane it says so ({cloudLane: False}) and the panel stays hidden. The meter is read from the cloud lane's own
    endpoint (the cloud-providers gateway), so the lane registry stays the single source for where it lives. A gateway that is down, slow or answers
    garbage yields {available: False, error} -- never an exception, so the tab never shows an error page for a plugin that is simply not running."""
    lane = next((l for l in lanes or [] if l.get("cloud") is True), None)
    if lane is None:
        return {"cloudLane": False, "available": False}
    base = {"cloudLane": True, "laneId": lane.get("id")}
    endpoint = str((lane.get("env") or {}).get("OLLAMA_URL") or "").rstrip("/")
    if not endpoint:
        return {**base, "available": False, "error": "the cloud lane has no endpoint"}
    try:
        meter = fetch(endpoint + "/meter", METER_TIMEOUT_S)
    except Exception as exc:  # down, timed out, refused, or not JSON: all mean "not available right now"
        return {**base, "available": False, "error": str(exc)[:200]}
    if not isinstance(meter, dict):
        return {**base, "available": False, "error": "the gateway answered with something that is not a meter"}
    return {**meter, **base, "available": True}


@cloud_meter_bp.route("/api/cloud-meter")
def api_cloud_meter():
    """Month-to-date and today's cloud spend, the cap state and the gateway's provider and model, for the Workers tab. See build_cloud_meter."""
    from app import worker_lane_defs
    return jsonify(build_cloud_meter(worker_lane_defs(), _http_get_json))
