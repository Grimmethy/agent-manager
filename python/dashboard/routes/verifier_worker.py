"""The Workers tab's Branch-verifier panel payload (agent-manager-pipeline-ops, 2026-11-02).

The verifier is NOT a lane (it produces a verdict, not a code diff): it is a CLI that the agent-manager watchdog triggers (a `watchdogScripts` entry in plugins.json starts a detached drain when its input changed) and that records `source: "worker"`
verdicts through this dashboard's own verdict route. This route only READS what it leaves behind:

  ledger  JSONL, append-only: an 'intent' line per verdict it is about to post and a 'result' line when it ran (dry-run writes only the intent)
  index   its incremental index of applied tasks that pushed a branch (count only)
  marker  the on/off file its tick checks first (the panel's Turn off/on button writes it)

Event, not poll (ADR-0024): no timer of its own; it reads files the verifier rewrites on each tick, once per Workers-tab refresh. Fails soft everywhere: a missing file, a
torn ledger line or an unreadable trigger state each just leave that part out, and with nothing at all the payload is {configured: False} and the card stays hidden.
"""
import json
import os
import time
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from routes.worker_trigger import read_trigger

verifier_worker_bp = Blueprint("verifier-worker-bp", __name__)

LEDGER_TAIL_BYTES = 256 * 1024
RECENT_COUNT = 8

_index_cache = {"key": None, "value": None}


def _state_file(env, var, name):
    env = os.environ if env is None else env
    return str(env.get(var) or "").strip() or os.path.join(os.path.expanduser("~"), ".local", "state", "pipeline-ops", name)


def ledger_path(env=None):
    return _state_file(env, "VERIFIER_LEDGER_PATH", "verifier-ledger.jsonl")


def index_path(env=None):
    return _state_file(env, "VERIFIER_INDEX_PATH", "branch-index.json")


def switch_path(env=None):
    """The verifier's on/off marker: the SAME file agent-manager-pipeline-ops src/verifier-switch.js reads first thing each tick (pinned by a test in both repos)."""
    return _state_file(env, "VERIFIER_DISABLED_PATH", "verifier-disabled")


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
    """Switch the verifier on (remove the marker, idempotent) or off (write it atomically). Raises OSError on a filesystem failure; returns the new switch state."""
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


def read_ledger_tail(path, max_bytes=LEDGER_TAIL_BYTES):
    """The last `max_bytes` of the ledger as parsed rows. A first partial line (from the seek) and any torn or non-object line are skipped; unreadable = []."""
    try:
        with open(path, "rb") as f:
            size = f.seek(0, os.SEEK_END)
            f.seek(max(0, size - max_bytes))
            raw = f.read()
    except OSError:
        return []
    rows = []
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def decisions(rows):
    """One decision per branch+sha: a 'result' line replaces the still-open 'intent' line of the same branch and head."""
    out, open_intent = [], {}
    for r in rows:
        if not r.get("branch"):
            continue
        key = (r["branch"], r.get("sha"))
        if r.get("phase") == "result" and key in open_intent:
            out[open_intent.pop(key)] = r
        else:
            out.append(r)
            if r.get("phase") == "intent":
                open_intent[key] = len(out) - 1
    return out


def read_index_count(path):
    """How many applied tasks with a pushed branch the verifier has indexed, cached by (mtime, size); None when absent or unreadable."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (path, st.st_mtime_ns, st.st_size)
    if _index_cache["key"] == key:
        return _index_cache["value"]
    try:
        with open(path) as f:
            data = json.load(f)
        entries = data.get("entries") if isinstance(data, dict) else None
        if not isinstance(entries, list):
            return None
    except (OSError, ValueError):
        return None
    value = {"branches": len(entries), "builtAt": data.get("builtAt")}
    _index_cache["key"], _index_cache["value"] = key, value
    return value


def _parse_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def build_verifier_worker(env=None, now=None, read_rows=read_ledger_tail, read_index=read_index_count, trigger=None, read_sw=read_switch):
    """The panel payload. See the module docstring. Never raises."""
    env = os.environ if env is None else env
    now = time.time() if now is None else now

    def safe(fn, default):
        try:
            return fn()
        except Exception:   # noqa: BLE001 -- the Workers tab must never fail because of this panel
            return default

    rows = safe(lambda: read_rows(ledger_path(env)), [])
    index = safe(lambda: read_index(index_path(env)), None)
    trigger_state = safe(trigger or (lambda: read_trigger('verifier', env, now)), None)
    switch = safe(lambda: read_sw(env), {"disabled": False, "disabledAt": None})
    if not rows and not index and trigger_state is None and not switch.get("disabled"):
        return {"configured": False}

    ds = safe(lambda: decisions(rows), [])
    last_ts = max([t for t in (_parse_ts(r.get("at")) for r in rows) if t is not None], default=None)
    today = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
    today_counts, recorded_today, failed_today = {}, 0, 0
    for r in ds:
        if str(r.get("at", ""))[:10] != today or r.get("mode") != "on" or r.get("phase") != "result":
            continue
        label = r.get("verdict") or "no verdict"
        today_counts[label] = today_counts.get(label, 0) + 1
        res = str(r.get("result") or "")
        if res.startswith("recorded"):
            recorded_today += 1
        elif res.startswith(("failed", "refused", "head moved")):
            failed_today += 1
    last_mode = next((r.get("mode") for r in reversed(rows) if r.get("mode")), None)
    return {
        "configured": True,
        "mode": last_mode,
        "switch": switch,
        "trigger": trigger_state,
        "lastTickAt": datetime.fromtimestamp(last_ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if last_ts is not None else None,
        "lastTickAgeS": max(0, int(now - last_ts)) if last_ts is not None else None,
        "indexed": index,
        "today": today_counts,
        "recordedToday": recorded_today,
        "failedToday": failed_today,
        "decisions": len(ds),
        "recent": [{"at": r.get("at"), "project": r.get("project"), "branch": r.get("branch"), "verdict": r.get("verdict"), "mode": r.get("mode"), "result": r.get("result"),
                    "reason": (r.get("reasons") or [None])[0]} for r in ds[-RECENT_COUNT:]][::-1],
    }


@verifier_worker_bp.route("/api/branch-verifier")
def api_branch_verifier():
    """Status of the branch verifier for the Workers tab. See build_verifier_worker."""
    return jsonify(build_verifier_worker())


@verifier_worker_bp.route("/api/branch-verifier/enabled", methods=["POST"])
def api_branch_verifier_enabled():
    """The card's Turn on / Turn off button: body {enabled: bool}. Off writes the marker the verifier's tick checks first; on removes it. A bad body is a 400 and writes nothing."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
        return jsonify({"error": "body must be {\"enabled\": true|false}"}), 400
    try:
        switch = set_enabled(body["enabled"])
    except OSError as exc:
        return jsonify({"error": f"could not change the switch: {exc}"[:240]}), 500
    return jsonify({"enabled": body["enabled"], "switch": switch})
