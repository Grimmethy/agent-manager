"""The Workers tab's Stalled-task worker panel payload (agent-manager-pipeline-ops, 2026-11-02).

The worker is NOT a lane (a stalled-task decision has no code diff, so it cannot ride the draft/review/apply pipeline): it is a CLI that the agent-manager watchdog triggers (a `watchdogScripts` entry in plugins.json starts a detached drain when its input changed),
with its own Sonnet gateway. This route is what makes it visible: it only READS what the worker leaves behind and asks the gateway for its meter.

  ledger  JSONL, append-only: an 'intent' line per decision and, when the action ran, a 'result' line that replaces it (dry-run writes only the intent)
  index   the worker's incremental index of every stalled task (counts, buckets)
  meter   GET <gateway>/meter -> tokenBudget {perHour, used, remaining}, provider, model

Event, not poll (ADR-0024): no timer of its own; it reads files the worker rewrites on each tick, once per Workers-tab refresh. Fails soft everywhere: a missing file, a torn
ledger line, a down gateway or an unreadable trigger state each just leave that part out, and with nothing at all the payload is {configured: False} and the panel stays hidden.
"""
import json
import os
import time
import urllib.request
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from routes.worker_trigger import read_trigger

stalled_worker_bp = Blueprint("stalled-worker-bp", __name__)

LEDGER_TAIL_BYTES = 256 * 1024
METER_TIMEOUT_S = 3
DEFAULT_MODEL_URL = "http://127.0.0.1:7475"
RECENT_COUNT = 8
TOP_BUCKETS = 5
HOLD_CAP = 10

_index_cache = {"key": None, "value": None}


def ledger_path(env=None):
    env = os.environ if env is None else env
    return env.get("STALLED_LEDGER_PATH") or os.path.join(os.path.expanduser("~"), ".local", "state", "pipeline-ops", "stalled-ledger.jsonl")


def index_path(env=None):
    env = os.environ if env is None else env
    return env.get("STALLED_INDEX_PATH") or os.path.join(os.path.expanduser("~"), ".local", "state", "pipeline-ops", "stalled-index.json")


def model_url(env=None):
    env = os.environ if env is None else env
    return str(env.get("STALLED_MODEL_URL") or DEFAULT_MODEL_URL).rstrip("/")


def switch_path(env=None):
    """The worker's on/off marker. The SAME file agent-manager-pipeline-ops src/switch.js reads first thing each tick (pinned by a test in both repos)."""
    env = os.environ if env is None else env
    return str(env.get("STALLED_DISABLED_PATH") or "").strip() or os.path.join(os.path.expanduser("~"), ".local", "state", "pipeline-ops", "stalled-disabled")


def read_switch(env=None):
    """{disabled, disabledAt}: the marker file is present = switched off. Any error reading it means ON (a broken switch must never look like a stopped worker)."""
    path = switch_path(env)
    if not os.path.isfile(path):          # False for a missing path, a directory, a path below a file or an unreadable parent: all mean ON (isfile never raises)
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


def read_ledger_tail(path, max_bytes=LEDGER_TAIL_BYTES):
    """The last `max_bytes` of the ledger as parsed rows. A first partial line (from the seek) and any torn or non-object line are skipped; unreadable = []."""
    try:
        with open(path, "rb") as f:
            size = f.seek(0, os.SEEK_END)
            start = max(0, size - max_bytes)
            f.seek(start)
            raw = f.read()
    except OSError:
        return []
    rows = []
    for line in raw.split(b"\n"):      # a seek that lands mid-line leaves a fragment that does not parse as an object, so it is skipped like any torn line
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
    """One decision per task action: a 'result' line replaces the still-open 'intent' line of the same task (same pairing as pipeline-ops src/metrics.js)."""
    out, open_intent = [], {}
    for r in rows:
        if not r.get("taskId") or not r.get("outcome"):
            continue
        tid = r["taskId"]
        if r.get("phase") == "result" and tid in open_intent:
            out[open_intent.pop(tid)] = r
        else:
            out.append(r)
            if r.get("phase") == "intent":
                open_intent[tid] = len(out) - 1
    return out


def read_index_summary(path):
    """{total, projects, builtAt, topBuckets[{state, signature, count}]} from the worker's index file, cached by (mtime, size); None when absent or unreadable."""
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
    buckets = {}
    projects = set()
    for e in entries:
        if not isinstance(e, dict):
            continue
        projects.add(e.get("project"))
        k = (e.get("state"), e.get("failureSignature") or "")
        buckets[k] = buckets.get(k, 0) + 1
    top = sorted(buckets.items(), key=lambda kv: (-kv[1], str(kv[0][1])))[:TOP_BUCKETS]
    value = {"total": len(entries), "projects": len(projects), "builtAt": data.get("builtAt"),
             "topBuckets": [{"state": s, "signature": sig, "count": n} for (s, sig), n in top]}
    _index_cache["key"], _index_cache["value"] = key, value
    return value


def _http_get_json(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _parse_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def build_stalled_worker(env=None, now=None, read_rows=read_ledger_tail, read_index=read_index_summary, fetch=_http_get_json, trigger=None, read_sw=read_switch):
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
    trigger_state = safe(trigger or (lambda: read_trigger('stalled', env, now)), None)
    gateway = {"available": False}
    meter = None
    try:
        meter = fetch(model_url(env) + "/meter", METER_TIMEOUT_S)
        if isinstance(meter, dict):
            gateway = {"available": True}
        else:
            gateway, meter = {"available": False, "error": "the gateway answered with something that is not a meter"}, None
    except Exception as exc:   # noqa: BLE001 -- down, timed out, refused or not JSON
        gateway = {"available": False, "error": str(exc)[:200]}

    switch = safe(lambda: read_sw(env), {"disabled": False, "disabledAt": None})
    if not rows and not index and trigger_state is None and not gateway["available"] and not switch.get("disabled"):
        return {"configured": False}

    ds = safe(lambda: decisions(rows), [])
    last_ts = max([t for t in (_parse_ts(r.get("at")) for r in rows) if t is not None], default=None)
    if last_ts is None and index:
        last_ts = _parse_ts(index.get("builtAt"))
    today = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
    today_counts = {}
    for r in ds:
        if str(r.get("at", ""))[:10] == today:
            today_counts[r["outcome"]] = today_counts.get(r["outcome"], 0) + 1
    holds = []
    for r in ds:
        if r.get("outcome") == "HOLD-FOR-OWNER":
            ts = _parse_ts(r.get("at"))
            holds.append({"taskId": r.get("taskId"), "project": r.get("project"), "question": r.get("question"), "dryRun": r.get("mode") != "on",
                          "ageHours": round((now - ts) / 3600, 1) if ts is not None else None, "ageS": max(0, int(now - ts)) if ts is not None else None})
    holds.sort(key=lambda h: -(h["ageS"] if h["ageS"] is not None else -1))
    budget = (meter or {}).get("tokenBudget") if isinstance(meter, dict) else None
    last_mode = next((r.get("mode") for r in reversed(rows) if r.get("mode")), None)
    return {
        "configured": True,
        "mode": last_mode,
        "switch": switch,
        "trigger": trigger_state,
        "lastTickAt": datetime.fromtimestamp(last_ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if last_ts is not None else None,
        "lastTickAgeS": max(0, int(now - last_ts)) if last_ts is not None else None,
        "stalled": index,
        "today": today_counts,
        "decisions": len(ds),
        "holds": holds[:HOLD_CAP],
        "recent": [{"at": r.get("at"), "project": r.get("project"), "taskId": r.get("taskId"), "outcome": r.get("outcome"), "mode": r.get("mode"), "result": r.get("result")}
                   for r in ds[-RECENT_COUNT:]][::-1],
        "budget": budget if isinstance(budget, dict) else None,
        "provider": (meter or {}).get("provider") if isinstance(meter, dict) else None,
        "model": (meter or {}).get("model") if isinstance(meter, dict) else None,
        "gateway": gateway,
    }


@stalled_worker_bp.route("/api/stalled-worker")
def api_stalled_worker():
    """Status of the stalled-task worker for the Workers tab. See build_stalled_worker."""
    return jsonify(build_stalled_worker())


@stalled_worker_bp.route("/api/stalled-worker/enabled", methods=["POST"])
def api_stalled_worker_enabled():
    """The panel's Turn on / Turn off button: body {enabled: bool}. Off writes the marker the worker's tick checks first; on removes it. A bad body is a 400 and writes nothing."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
        return jsonify({"error": "body must be {\"enabled\": true|false}"}), 400
    try:
        switch = set_enabled(body["enabled"])
    except OSError as exc:
        return jsonify({"error": f"could not change the switch: {exc}"[:240]}), 500
    return jsonify({"enabled": body["enabled"], "switch": switch})
