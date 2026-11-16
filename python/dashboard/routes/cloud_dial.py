"""GET and POST /api/cloud-dial: the cloud-agent dial for the Workers tab (feature cloud-agent-pool, FF-3c).

GET answers {available, requested, mode, lanes: [{id, rank, state}], counts: {active, idle, dialOff, switchedOff, heldForRam, limited, stale}, rates: {callsPerHour, tokensPerHour},
unavailable: [lane ids whose gateway could not be read], limit}. The dial state and the lane order come from `node src/cloud-dial.js status` (the one place that defines both);
lane states and counts from cloud_dial.py (heartbeats plus the switched-off markers); rates from cloud_dial_rates.py (every cloud gateway's /meter, summed, over the last 10 minutes of
GET calls: the ring lives in this process, so a rate is null until two readings exist). `limit` stays null until a gateway meter exposes the plan limit. Anything unreadable gives
{available: false, error} or a null/empty part, never a 500.

POST takes exactly one of {"count": integer >= 0 or null (null unsets the dial)} or {"mode": "manual" | "auto"}; no upper bound on the count. It writes by running `node src/cloud-dial.js
set|unset|mode` and answers with the same payload as GET. Like the other switch routes (routes/pause.py, routes/instances.py) it only writes a state file: the pipeline is not touched and
running tasks finish; lanes obey the dial on their next tick.
"""
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint, abort, jsonify, request

import cloud_dial
import cloud_dial_rates
from routes.cloud_meter import _http_get_json

cloud_dial_bp = Blueprint("cloud-dial-bp", __name__)

DIAL_JS = Path(__file__).resolve().parent.parent.parent.parent / "src" / "cloud-dial.js"
NODE_TIMEOUT_S = 10
MODES = ("manual", "auto")
RING = cloud_dial_rates.RateRing()   # readings of this process; rates are null until two GET calls have been made


def _run_node(*args):
    return subprocess.run(["node", str(DIAL_JS), *args], capture_output=True, text=True, timeout=NODE_TIMEOUT_S, env=os.environ.copy())


def read_status(run=None):
    """`node src/cloud-dial.js status` as a dict, or (None, error text). Never raises. `run` defaults to _run_node, looked up at call time."""
    try:
        done = (run or _run_node)("status")
        if done.returncode != 0:
            return None, (done.stderr or "cloud-dial.js status failed").strip()[:200]
        data = json.loads(done.stdout)
        if not isinstance(data, dict) or not isinstance(data.get("lanes"), list):
            return None, "cloud-dial.js status answered something else"
        return data, None
    except Exception as exc:  # noqa: BLE001 - node missing, timed out, not JSON
        return None, str(exc)[:200]


def read_heartbeats(instances_dir, read_json):
    """{instanceId: heartbeat dict} from the instances directory; {} when it cannot be read."""
    out = {}
    try:
        for f in sorted(Path(instances_dir).glob("*.json")):
            data = read_json(f)
            if isinstance(data, dict) and isinstance(data.get("instanceId"), str):
                out[data["instanceId"]] = data
    except (OSError, TypeError):
        return {}
    return out


def build_payload(status, error, heartbeats, disabled, lane_defs, fetch, ring, now_s, now_dt=None):
    """The GET payload from injected inputs (no node, filesystem or network inside)."""
    if status is None:
        return {"available": False, "error": error or "the dial is not readable"}
    states = cloud_dial.lane_states(status.get("lanes"), heartbeats, disabled, now_dt)
    gateways = cloud_dial_rates.read_gateways(lane_defs, fetch)
    ring.add(now_s, gateways["readings"])
    rate = ring.rates(now_s)
    return {
        "available": True,
        "requested": status.get("count"),
        "mode": status.get("mode"),
        "setAt": status.get("setAt"),
        "setBy": status.get("setBy"),
        "lanes": states,
        "counts": cloud_dial.counts(states),
        "rates": {"callsPerHour": rate["callsPerHour"], "tokensPerHour": rate["tokensPerHour"]},
        "unavailable": gateways["unavailable"],
        "limit": None,
    }


def validate_change(body):
    """The node arguments for a POST body, or abort(400) with a clear message. Exactly one of count or mode."""
    if not isinstance(body, dict):
        abort(400, description='send a JSON body: {"count": <integer >= 0 or null>} or {"mode": "manual" | "auto"}')
    has_count, has_mode = "count" in body, "mode" in body
    if has_count == has_mode:
        abort(400, description='send exactly one of "count" or "mode"')
    extra = set(body) - {"count", "mode"}
    if extra:
        abort(400, description=f"unknown field(s): {', '.join(sorted(extra))}")
    if has_mode:
        if body["mode"] not in MODES:
            abort(400, description=f"mode must be one of {', '.join(MODES)}")
        return ["mode", body["mode"]]
    count = body["count"]
    if count is None:
        return ["unset"]
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        abort(400, description="count must be a whole number of agents, 0 or more (or null to unset the dial)")
    return ["set", str(count)]


def _payload_now():
    from app import instances_dir, read_json_safe, worker_lane_defs
    from worker_switch import disabled_workers
    status, error = read_status()
    inst = instances_dir()
    return build_payload(status, error, read_heartbeats(inst, read_json_safe) if inst else {}, disabled_workers(), worker_lane_defs(),
                         _http_get_json, RING, time.time(), datetime.now(timezone.utc))


@cloud_dial_bp.route("/api/cloud-dial")
def api_cloud_dial():
    """The cloud-agent dial: requested count, mode, per-lane states, counts and rates. See the module header."""
    return jsonify(_payload_now())


@cloud_dial_bp.route("/api/cloud-dial", methods=["POST"])
def api_cloud_dial_set():
    """Set the dial count (null unsets it) or its mode. See the module header."""
    args = validate_change(request.get_json(silent=True))
    try:
        done = _run_node(*args)
    except Exception as exc:  # noqa: BLE001
        abort(500, description=f"could not run the dial command: {str(exc)[:200]}")
    if done.returncode != 0:
        abort(500, description=(done.stderr or "the dial command failed").strip()[:200])
    return jsonify(_payload_now())
