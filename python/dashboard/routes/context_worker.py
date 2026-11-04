"""The Workers tab's payload for the two CONTEXT workers: the codebase-map worker (`map`) and the memory-index worker (`memory`)
(agent-manager-context-ops docs/context-workers-spec.md, 2026-11-04).

Like the branch verifier and the Needs-Work worker, they are NOT lanes: each is a CLI that the agent-manager watchdog triggers (a `watchdogScripts` entry in plugins.json starts a
detached drain when its input changed). This route only READS what they leave behind and writes ONE thing, the on/off marker the Turn off button owns:

  ledger   JSONL, append-only, <state dir>/context-<name>-ledger.jsonl: an 'intent' line then a 'result' line per decision, {kind, at, loop, item, outcome, detail}. The intent's detail
           carries {mode, factsKey, ...}; a HOLD-FOR-OWNER decision carries the one question and a recommendation. A DRY-RUN decision is a pair whose result detail is {executed: false}.
  marker   <name> -> context-<name>-disabled (the on/off file the worker's tick checks first)
  trigger  the <worker>-trigger.json / .beat / -drain.lock files (routes/worker_trigger.py, worker 'context-<name>')

State directory: AGENT_MANAGER_CONTEXT_OPS_STATE_DIR when set, else $HOME/.local/state/pipeline-ops (the same rule as agent-manager-context-ops src/memory/run.js proposalDirFor). The
marker does NOT follow that override: it is CONTEXT_MAP_DISABLED_PATH / CONTEXT_MEMORY_DISABLED_PATH or $HOME/.local/state/pipeline-ops/context-<name>-disabled, exactly the default of
src/worker/switch.js there (each repo pins the default in its own test).

Event, not poll (ADR-0024): no timer of its own; it reads files the workers rewrite on each tick, once per Workers-tab refresh. Fails soft everywhere; with nothing at all the payload is
{configured: False} and the card stays hidden. GET never writes.
"""
import json
import os
import time
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from routes.verifier_worker import _parse_ts, read_ledger_tail
from routes.worker_trigger import read_trigger

context_worker_bp = Blueprint("context-worker-bp", __name__)

WORKERS = {"map": "codebase-map", "memory": "memory-index"}
RECENT_COUNT = 8
HOLDS_CAP = 50
HOLD = "HOLD-FOR-OWNER"


def _home(env):
    return env.get("HOME") or os.path.expanduser("~")


def state_dir(env=None):
    env = os.environ if env is None else env
    return str(env.get("AGENT_MANAGER_CONTEXT_OPS_STATE_DIR") or "").strip() or os.path.join(_home(env), ".local", "state", "pipeline-ops")


def ledger_path(name, env=None):
    return os.path.join(state_dir(env), f"context-{name}-ledger.jsonl")


def switch_path(name, env=None):
    env = os.environ if env is None else env
    override = str(env.get(f"CONTEXT_{name.upper()}_DISABLED_PATH") or "").strip()
    return override or os.path.join(_home(env), ".local", "state", "pipeline-ops", f"context-{name}-disabled")


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


def decisions(rows, item):
    """The decisions for one item, oldest first: a 'result' line paired with the 'intent' line written just before it for the same item. An intent without a result is not a decision."""
    out, pending = [], None
    for r in rows:
        if r.get("item") != item:
            continue
        if r.get("kind") == "intent":
            pending = r
        elif r.get("kind") == "result":
            idetail = pending.get("detail") if pending and isinstance(pending.get("detail"), dict) else {}
            rdetail = r.get("detail") if isinstance(r.get("detail"), dict) else {}
            out.append({"at": r.get("at"), "outcome": r.get("outcome"), "mode": idetail.get("mode") if isinstance(idetail.get("mode"), str) else None,
                        "executed": rdetail.get("executed") is not False, "error": r.get("outcome") == "error", "intentDetail": idetail, "resultDetail": rdetail})
            pending = None
    return out


def _dry(d):
    return d["mode"] == "dry-run" or not d["executed"]


def _summary(d):
    detail = d["intentDetail"]
    if isinstance(detail.get("findings"), int):
        return f"{detail['findings']} findings ({detail.get('fixRanges', 0)} fix, {detail.get('rewriteRows', 0)} rewrite)"
    if isinstance(detail.get("outcomes"), list) and detail["outcomes"]:
        return ", ".join(str(o) for o in detail["outcomes"][:4])
    if d["error"]:
        return str(d["resultDetail"].get("error") or "error")[:120]
    return str(d["outcome"] or "")


def build_context_worker(name, env=None, now=None, read_rows=read_ledger_tail, trigger=None, read_sw=read_switch):
    """The panel payload for worker `name` ('map' or 'memory'). See the module docstring. Never raises."""
    env = os.environ if env is None else env
    now = time.time() if now is None else now

    def safe(fn, default):
        try:
            return fn()
        except Exception:   # noqa: BLE001 -- the Workers tab must never fail because of this panel
            return default

    item = WORKERS[name]
    rows = safe(lambda: read_rows(ledger_path(name, env)), [])
    trigger_state = safe(trigger or (lambda: read_trigger(f"context-{name}", env, now)), None)
    switch = safe(lambda: read_sw(name, env), {"disabled": False, "disabledAt": None})
    if not rows and trigger_state is None and not switch.get("disabled"):
        return {"configured": False}

    ds = safe(lambda: decisions(rows, item), [])
    last_ts = max([t for t in (_parse_ts(r.get("at")) for r in rows) if t is not None], default=None)
    today = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
    by_outcome, dry_by_outcome, acted = {}, {}, 0
    for d in ds:
        if str(d.get("at", ""))[:10] != today:
            continue
        label = d["outcome"] or "no action"
        target = dry_by_outcome if _dry(d) else by_outcome
        target[label] = target.get(label, 0) + 1
        if not _dry(d) and not d["error"]:
            acted += 1
    last = ds[-1] if ds else None
    holds = []
    if last is not None and last["outcome"] == HOLD:
        t = _parse_ts(last["at"])
        holds.append({"question": last["intentDetail"].get("question") or last["resultDetail"].get("question"), "recommendation": last["intentDetail"].get("recommendation") or last["resultDetail"].get("recommendation"),
                      "at": last["at"], "ageS": max(0, int(now - t)) if t is not None else None})
    errors = [d for d in ds if d["error"]]
    findings = None
    for r in reversed(rows):
        d = r.get("detail") if r.get("kind") == "intent" and r.get("item") == item and isinstance(r.get("detail"), dict) else None
        if d is not None and "hash" in d:
            findings = {"hash": d.get("hash"), "findings": d.get("findings"), "fixRanges": d.get("fixRanges"), "rewriteRows": d.get("rewriteRows"), "suggestions": d.get("suggestions"), "at": r.get("at")}
            break
    last_mode = next((r["detail"]["mode"] for r in reversed(rows) if r.get("kind") == "intent" and isinstance(r.get("detail"), dict) and isinstance(r["detail"].get("mode"), str)), None)
    return {
        "configured": True,
        "name": name,
        "worker": f"context-{name}",
        "mode": last_mode,
        "enabled": not switch.get("disabled"),
        "switch": switch,
        "trigger": trigger_state,
        "lastTickAt": datetime.fromtimestamp(last_ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if last_ts is not None else None,
        "lastTickAgeS": max(0, int(now - last_ts)) if last_ts is not None else None,
        "today": {"decisions": sum(by_outcome.values()), "byOutcome": by_outcome, "dryRun": {"decisions": sum(dry_by_outcome.values()), "byOutcome": dry_by_outcome}},
        "actedToday": acted,
        "decisions": len(ds),
        "lastDecision": {"at": last["at"], "outcome": last["outcome"], "mode": last["mode"], "executed": last["executed"], "summary": _summary(last)} if last else None,
        "holdCount": len(holds),
        "holds": holds[:HOLDS_CAP],
        "errors": {"count": len(errors), "last": {"at": errors[-1]["at"], "error": str(errors[-1]["resultDetail"].get("error") or "")[:240]} if errors else None},
        "findings": findings,
        "recent": [{"at": d["at"], "outcome": d["outcome"], "mode": d["mode"], "executed": d["executed"], "summary": _summary(d)} for d in ds[-RECENT_COUNT:]][::-1],
    }


@context_worker_bp.route("/api/context-worker/<name>")
def api_context_worker(name):
    """Status of a context worker for the Workers tab. See build_context_worker."""
    if name not in WORKERS:
        return jsonify({"error": f"unknown context worker {name!r}"}), 404
    return jsonify(build_context_worker(name))


@context_worker_bp.route("/api/context-worker/<name>/enabled", methods=["POST"])
def api_context_worker_enabled(name):
    """The card's Turn on / Turn off button: body {enabled: bool}. Off writes the marker the worker's tick checks first; on removes it. A bad body is a 400 and writes nothing."""
    if name not in WORKERS:
        return jsonify({"error": f"unknown context worker {name!r}"}), 404
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
        return jsonify({"error": "body must be {\"enabled\": true|false}"}), 400
    try:
        switch = set_enabled(name, body["enabled"])
    except OSError as exc:
        return jsonify({"error": f"could not change the switch: {exc}"[:240]}), 500
    return jsonify({"enabled": body["enabled"], "switch": switch})
