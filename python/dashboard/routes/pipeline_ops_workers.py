"""The Workers tab's cards for the agent-manager-pipeline-ops workers built on src/worker-kit.js: the poll scout (`scout`) and, as they are built, the merge-ready checker (`checker`), the
merger (`merger`), the idle-cost steward (`steward`), the hub worker (`hub`) and the task atomizer (`atomizer`, docs/task-atomizer.md in that repo, 2026-11-13) (docs/poll-scout-worker.md
in that repo, 2026-11-04).

Like the branch verifier and the Needs-Work worker they are NOT lanes: each is a CLI that the agent-manager watchdog triggers (a `watchdogScripts` entry in plugins.json starts a detached
drain when its input changed). One generic route reads what they leave behind, keyed by worker name, so a new worker is a name in WORKERS, not a new route:

  ledger   <state dir>/<name>-ledger.jsonl, append-only (src/worker-kit.js): one 'intent' row then one 'result' row per decision, or a single 'result' row for a no-action decision.
           A row is {at, mode, key, version, outcome, reason, evidence_keys, factsKey, phase, action, result, ...extra}; a HOLD-FOR-OWNER row carries the one question and a recommendation.
  marker   <state dir>/<name>-disabled (the on/off file the worker's tick checks first; <NAME>_DISABLED_PATH overrides it; the card's Turn off button writes it)
  trigger  <name>-trigger.json / .beat / -drain.lock (routes/worker_trigger.py)

State directory: $HOME/.local/state/pipeline-ops (each repo pins the same default in its own test). Event, not poll (ADR-0024): no timer of its own; it reads files the workers rewrite on
each tick, once per Workers-tab refresh. Fails soft everywhere; a worker with no trace at all has {configured: False} and its card stays hidden. GET never writes.
"""
import json
import os
import time
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from routes.verifier_worker import _parse_ts, read_ledger_tail
from routes.worker_trigger import read_trigger

pipeline_ops_workers_bp = Blueprint("pipeline-ops-workers-bp", __name__)

WORKERS = ("scout", "checker", "merger", "steward", "hub", "atomizer")
RECENT_COUNT = 8
HOLDS_CAP = 50
HOLD = "HOLD-FOR-OWNER"
FAILED = ("failed", "refused", "ledger unwritable")


def _home(env):
    return env.get("HOME") or os.path.expanduser("~")


def _state_dir(env):
    return os.path.join(_home(env), ".local", "state", "pipeline-ops")


def _env(env):
    return os.environ if env is None else env


def ledger_path(name, env=None):
    env = _env(env)
    return str(env.get(f"{name.upper()}_LEDGER_PATH") or "").strip() or os.path.join(_state_dir(env), f"{name}-ledger.jsonl")


def switch_path(name, env=None):
    """The worker's on/off marker: the SAME file agent-manager-pipeline-ops src/worker-kit.js markerPath reads first thing each tick."""
    env = _env(env)
    return str(env.get(f"{name.upper()}_DISABLED_PATH") or "").strip() or os.path.join(_state_dir(env), f"{name}-disabled")


def read_switch(name, env=None):
    """{disabled, disabledAt}: the marker file is present = switched off. Any error reading it means ON (a broken switch must never look like a stopped worker)."""
    path = switch_path(name, env)
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


def set_enabled(name, enabled, env=None, now=None):
    """Switch the worker on (remove the marker, idempotent) or off (write it atomically). Raises OSError on a filesystem failure; returns the new switch state."""
    path = switch_path(name, env)
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
    """The decisions: every RESULT row (an intent row alone is not a decision). Rows without a key are ignored."""
    return [r for r in rows if r.get("phase") == "result" and isinstance(r.get("key"), str) and isinstance(r.get("result"), str)]


def _failed(row):
    return str(row.get("result") or "").startswith(FAILED)


def build_worker(name, env=None, now=None, read_rows=read_ledger_tail, trigger=None, read_sw=read_switch):
    """The card payload for worker `name`. See the module docstring. Never raises."""
    env = _env(env)
    now = time.time() if now is None else now

    def safe(fn, default):
        try:
            return fn()
        except Exception:   # noqa: BLE001 -- the Workers tab must never fail because of this panel
            return default

    rows = safe(lambda: read_rows(ledger_path(name, env)), [])
    trigger_state = safe(trigger or (lambda: read_trigger(name, env, now)), None)
    switch = safe(lambda: read_sw(name, env), {"disabled": False, "disabledAt": None})
    if not rows and trigger_state is None and not switch.get("disabled"):
        return {"configured": False, "name": name}

    ds = safe(lambda: decisions(rows), [])
    last_ts = max([t for t in (_parse_ts(r.get("at")) for r in rows) if t is not None], default=None)
    today = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
    today_counts, acted_today, failed_today = {}, 0, 0
    for r in ds:
        if str(r.get("at", ""))[:10] != today:
            continue
        label = r.get("outcome") or "no outcome"
        today_counts[label] = today_counts.get(label, 0) + 1
        if _failed(r):
            failed_today += 1
        elif r.get("mode") == "on" and r.get("action") not in (None, "none"):
            acted_today += 1
    latest = {}
    for r in ds:
        latest[r["key"]] = r
    by_outcome = {}
    for r in latest.values():
        label = r.get("outcome") or "no outcome"
        by_outcome[label] = by_outcome.get(label, 0) + 1
    holds = []
    for r in latest.values():
        if r.get("outcome") != HOLD:
            continue
        t = _parse_ts(r.get("at"))
        holds.append({"key": r["key"], "question": r.get("question") or r.get("reason"), "recommendation": r.get("recommendation"), "at": r.get("at"),
                      "ageS": max(0, int(now - t)) if t is not None else None})
    holds.sort(key=lambda h: (-(h["ageS"] if h["ageS"] is not None else -1), str(h["key"])))
    last_mode = next((r.get("mode") for r in reversed(rows) if r.get("mode")), None)
    return {
        "configured": True,
        "name": name,
        "mode": last_mode,
        "switch": switch,
        "trigger": trigger_state,
        "lastTickAt": datetime.fromtimestamp(last_ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if last_ts is not None else None,
        "lastTickAgeS": max(0, int(now - last_ts)) if last_ts is not None else None,
        "today": today_counts,
        "actedToday": acted_today,
        "failedToday": failed_today,
        "decisions": len(ds),
        "items": {"total": len(latest), "byOutcome": by_outcome},
        "holdCount": len(holds),
        "holds": holds[:HOLDS_CAP],
        "recent": [{"at": r.get("at"), "key": r.get("key"), "outcome": r.get("outcome"), "mode": r.get("mode"), "action": r.get("action"), "result": r.get("result"),
                    "reason": r.get("reason")} for r in ds[-RECENT_COUNT:]][::-1],
    }


@pipeline_ops_workers_bp.route("/api/pipeline-ops-workers")
def api_pipeline_ops_workers():
    """The card payloads of every pipeline-ops worker for the Workers tab: {workers: {<name>: payload}}. See build_worker."""
    return jsonify({"workers": {name: build_worker(name) for name in WORKERS}})


@pipeline_ops_workers_bp.route("/api/pipeline-ops-workers/<name>/enabled", methods=["POST"])
def api_pipeline_ops_worker_enabled(name):
    """The card's Turn on / Turn off button: body {enabled: bool}. Off writes the marker the worker's tick checks first; on removes it. An unknown worker is a 404 and a bad body a 400; neither writes."""
    if name not in WORKERS:
        return jsonify({"error": f"unknown worker: {name}"[:120]}), 404
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
        return jsonify({"error": "body must be {\"enabled\": true|false}"}), 400
    try:
        switch = set_enabled(name, body["enabled"])
    except OSError as exc:
        return jsonify({"error": f"could not change the switch: {exc}"[:240]}), 500
    return jsonify({"name": name, "enabled": body["enabled"], "switch": switch})
