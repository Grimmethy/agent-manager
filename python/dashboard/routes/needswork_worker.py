"""The Workers tab's Needs-Work worker card payload (agent-manager-pipeline-ops docs/needs-work-worker.md, 2026-11-03).

Like the branch verifier, the Needs-Work worker is NOT a lane: a CLI that the agent-manager watchdog triggers (a `watchdogScripts` entry in plugins.json starts a detached drain when its
input changed). It drains the Needs Work bucket by deciding one outcome per branch (REDRAFT-DELEGATED, FILE-REPLACEMENT-TASK, ESCALATE-MECHANISM, HOLD-FOR-OWNER). This route only READS
what it leaves behind:

  ledger  JSONL, append-only: an 'intent' line per decision it is about to act on and a 'result' line when it ran; a HOLD line carries the one question and a recommendation
  marker  the on/off file its tick checks first (the card's Turn off/on button writes it)
  trigger the same <name>-trigger.json / .beat / drain.lock files the other workers leave (routes/worker_trigger.py, name 'needswork')

Event, not poll (ADR-0024): no timer of its own; it reads files the worker rewrites on each tick, once per Workers-tab refresh. Fails soft everywhere: a missing file, a torn ledger
line or an unreadable trigger state each just leave that part out, and with nothing at all the payload is {configured: False} and the card stays hidden.
"""
import json
import os
import time
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from routes.verifier_worker import _parse_ts, read_ledger_tail
from routes.worker_trigger import read_trigger

needswork_worker_bp = Blueprint("needswork-worker-bp", __name__)

RECENT_COUNT = 8
HOLDS_CAP = 50
HOLD = "HOLD-FOR-OWNER"


def _state_file(env, var, name):
    env = os.environ if env is None else env
    return str(env.get(var) or "").strip() or os.path.join(env.get("HOME") or os.path.expanduser("~"), ".local", "state", "pipeline-ops", name)


def ledger_path(env=None):
    return _state_file(env, "NEEDSWORK_LEDGER_PATH", "needswork-ledger.jsonl")


def switch_path(env=None):
    """The worker's on/off marker: the SAME file agent-manager-pipeline-ops src/nw-switch.js reads first thing each tick (each repo pins its default path in its own test)."""
    return _state_file(env, "NEEDSWORK_DISABLED_PATH", "needswork-disabled")


def read_switch(env=None):
    """{disabled, disabledAt}: the marker file is present = switched off. Any error reading it means ON (a broken switch must never look like a stopped worker)."""
    path = switch_path(env)
    if not os.path.isfile(path):
        return {"disabled": False, "disabledAt": None}
    disabled_at = None
    try:
        with open(path) as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("disabledAt"), str):
            disabled_at = data["disabledAt"]
    except (OSError, ValueError):
        pass
    return {"disabled": True, "disabledAt": disabled_at}


def set_enabled(enabled, env=None, now=None):
    """Switch the worker on (remove the marker, idempotent) or off (write it atomically). Raises OSError on a filesystem failure; returns the new switch state."""
    path = switch_path(env)
    if enabled:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return {"disabled": False, "disabledAt": None}
    stamp = datetime.fromtimestamp(time.time() if now is None else now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump({"disabledAt": stamp}, f)
        f.write("\n")
    os.replace(tmp, path)
    return {"disabled": True, "disabledAt": stamp}


def decisions(rows):
    """One decision per project+branch+sha: a 'result' line replaces the still-open 'intent' line of the same key."""
    out, open_intent = [], {}
    for r in rows:
        if not r.get("branch"):
            continue
        key = (r.get("project"), r["branch"], r.get("sha"))
        if r.get("phase") == "result" and key in open_intent:
            out[open_intent.pop(key)] = r
        else:
            out.append(r)
            if r.get("phase") == "intent":
                open_intent[key] = len(out) - 1
    return out


def _newest_per_branch(ds):
    """The latest decision of each project+branch (the ledger is append-only, so later rows win)."""
    latest = {}
    for r in ds:
        latest[(r.get("project"), r["branch"])] = r
    return latest


def build_needswork_worker(env=None, now=None, read_rows=read_ledger_tail, trigger=None, read_sw=read_switch):
    """The panel payload. See the module docstring. Never raises."""
    env = os.environ if env is None else env
    now = time.time() if now is None else now

    def safe(fn, default):
        try:
            return fn()
        except Exception:   # noqa: BLE001 -- the Workers tab must never fail because of this panel
            return default

    rows = safe(lambda: read_rows(ledger_path(env)), [])
    trigger_state = safe(trigger or (lambda: read_trigger('needswork', env, now)), None)
    switch = safe(lambda: read_sw(env), {"disabled": False, "disabledAt": None})
    if not rows and trigger_state is None and not switch.get("disabled"):
        return {"configured": False}

    ds = safe(lambda: decisions(rows), [])
    last_ts = max([t for t in (_parse_ts(r.get("at")) for r in rows) if t is not None], default=None)
    today = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
    today_counts, acted_today, failed_today = {}, 0, 0
    for r in ds:
        if str(r.get("at", ""))[:10] != today or r.get("phase") != "result":
            continue
        label = r.get("outcome") or "no action"
        today_counts[label] = today_counts.get(label, 0) + 1
        res = str(r.get("result") or "")
        if r.get("mode") == "on" and not res.startswith(("failed", "refused")):
            acted_today += 1
        if res.startswith(("failed", "refused")):
            failed_today += 1
    latest = _newest_per_branch(ds)
    by_outcome = {}
    for r in latest.values():
        if r.get("outcome"):
            by_outcome[r["outcome"]] = by_outcome.get(r["outcome"], 0) + 1
    holds = []
    for r in latest.values():
        if r.get("outcome") != HOLD or r.get("phase") != "result":
            continue
        t = _parse_ts(r.get("at"))
        holds.append({"branch": r.get("branch"), "project": r.get("project"), "question": r.get("question") or r.get("reason"), "recommendation": r.get("recommendation"),
                      "at": r.get("at"), "ageS": max(0, int(now - t)) if t is not None else None})
    holds.sort(key=lambda h: (-(h["ageS"] if h["ageS"] is not None else -1), str(h["branch"])))
    last_mode = next((r.get("mode") for r in reversed(rows) if r.get("mode")), None)
    return {
        "configured": True,
        "mode": last_mode,
        "switch": switch,
        "trigger": trigger_state,
        "lastTickAt": datetime.fromtimestamp(last_ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if last_ts is not None else None,
        "lastTickAgeS": max(0, int(now - last_ts)) if last_ts is not None else None,
        "today": today_counts,
        "actedToday": acted_today,
        "failedToday": failed_today,
        "decisions": len(ds),
        "backlog": {"total": sum(by_outcome.values()), "byOutcome": by_outcome},
        "holdCount": len(holds),
        "holds": holds[:HOLDS_CAP],
        "recent": [{"at": r.get("at"), "project": r.get("project"), "branch": r.get("branch"), "outcome": r.get("outcome"), "mode": r.get("mode"), "result": r.get("result"),
                    "reason": r.get("reason")} for r in ds[-RECENT_COUNT:]][::-1],
    }


@needswork_worker_bp.route("/api/needswork-worker")
def api_needswork_worker():
    """Status of the Needs-Work worker for the Workers tab. See build_needswork_worker."""
    return jsonify(build_needswork_worker())


@needswork_worker_bp.route("/api/needswork-worker/enabled", methods=["POST"])
def api_needswork_worker_enabled():
    """The card's Turn on / Turn off button: body {enabled: bool}. Off writes the marker the worker's tick checks first; on removes it. A bad body is a 400 and writes nothing."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
        return jsonify({"error": "body must be {\"enabled\": true|false}"}), 400
    try:
        switch = set_enabled(body["enabled"])
    except OSError as exc:
        return jsonify({"error": f"could not change the switch: {exc}"[:240]}), 500
    return jsonify({"enabled": body["enabled"], "switch": switch})
