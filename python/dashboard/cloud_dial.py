"""The cloud-agent dial as the dashboard sees it: per-lane states and the counts, built from three plain inputs so nothing here touches node, the filesystem or the network
(feature cloud-agent-pool, FF-3c). The dial rule and the lane order live ONCE, in src/cloud-dial.js; its `status` command hands this module `lanes: [{id, rank, off}]`.

lane_states(dial_lanes, heartbeats, disabled, now) -> [{id, rank, state}] where state is, in this order of precedence:
  switchedOff  the operator's Turn off marker is set for the worker (src/worker-switch.js)
  dialOff      the dial turns the lane off (off is true in the dial status)
  stale        the heartbeat is missing, unreadable or older than its threshold: the process is not running or not reporting; counted in no bucket below
  heldForRam   status paused with pass ram: the lane yields its tick to the memory guard (scripts/local-worker.sh)
  active       status working, checking or queued: a task is in flight or waiting its turn
  idle         anything else that is alive (idle, warming, a GPU-session pause, ...)
`limited` (the plan limit) stays 0 until a gateway meter exposes it. Fail open: a malformed input row is skipped, never an exception.

counts(lanes) -> {active, idle, dialOff, switchedOff, heldForRam, limited, stale}
"""
from datetime import datetime, timezone

WORKING_STALE_S = 600       # a lane mid-task heartbeats rarely; same spirit as app.WORKING_STALE_SECONDS
OTHER_STALE_S = 180         # an idle or paused lane heartbeats every tick
ACTIVE_STATUSES = ("working", "checking", "queued")
BUCKETS = ("active", "idle", "dialOff", "switchedOff", "heldForRam", "limited", "stale")


def _parse_ts(value):
    """ISO-8601 (node's toISOString, 'Z' suffix) -> aware datetime, or None."""
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _is_stale(hb, now):
    if not isinstance(hb, dict):
        return True
    seen = _parse_ts(hb.get("lastHeartbeat"))
    if seen is None:
        return True
    limit = WORKING_STALE_S if hb.get("status") == "working" else OTHER_STALE_S
    return (now - seen).total_seconds() > limit


def lane_state(lane_id, off, hb, switched_off, now):
    """The one state of one lane (see the module header for the precedence)."""
    if switched_off:
        return "switchedOff"
    if off:
        return "dialOff"
    if _is_stale(hb, now):
        return "stale"
    status = hb.get("status")
    if status == "paused" and hb.get("currentPass") == "ram":
        return "heldForRam"
    if status in ACTIVE_STATUSES:
        return "active"
    return "idle"


def lane_states(dial_lanes, heartbeats, disabled, now=None):
    """`dial_lanes` is the `lanes` list of `node src/cloud-dial.js status`; `heartbeats` maps instance id -> heartbeat dict; `disabled` is the set of switched-off worker ids."""
    now = now or datetime.now(timezone.utc)
    beats = heartbeats if isinstance(heartbeats, dict) else {}
    off_ids = disabled if disabled is not None else set()
    out = []
    for lane in dial_lanes if isinstance(dial_lanes, list) else []:
        if not isinstance(lane, dict) or not isinstance(lane.get("id"), str):
            continue
        rank = lane.get("rank")
        out.append({
            "id": lane["id"],
            "rank": rank if isinstance(rank, int) and not isinstance(rank, bool) else None,
            "state": lane_state(lane["id"], lane.get("off") is True, beats.get(lane["id"]), lane["id"] in off_ids, now),
        })
    return out


def counts(lanes):
    """How many lanes are in each state. `limited` is always 0 for now (no gateway reports the plan limit yet)."""
    totals = {name: 0 for name in BUCKETS}
    for lane in lanes if isinstance(lanes, list) else []:
        state = lane.get("state") if isinstance(lane, dict) else None
        if state in totals:
            totals[state] += 1
    return totals
