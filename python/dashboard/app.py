#!/usr/bin/env python3
"""Read-only monitoring dashboard for the agent-manager pipeline. No database, no build
step -- reads queue/*.json and instances/*.json directly off disk, the same filesystem
state every other part of this package already uses.

Usage: python dashboard/app.py
Reads AGENT_MANAGER_PIPELINE_DIR (or AGENT_MANAGER_REPO_ROOT as a fallback) for where
queue/ and instances/ live, same as every other script in this package.
AGENT_MANAGER_DASHBOARD_PORT (default 7420) picks the port.

Binds 127.0.0.1 by default. AGENT_MANAGER_DASHBOARD_HOST opts into binding 0.0.0.0 or a
specific LAN IP (see README's Dashboard section for the auth token this requires and the
TLS options -- AGENT_MANAGER_DASHBOARD_CERT/_KEY for direct HTTPS, or a reverse proxy).
"""

import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import string
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, abort, request, Response, stream_with_context
from werkzeug.exceptions import HTTPException

# build_graph.py / visualize_graph.py live one directory up (python/), not inside
# dashboard/ -- added explicitly rather than relying on an installed package, matching
# this whole project's no-build-step, run-from-source philosophy.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import build_graph  # noqa: E402
import visualize_graph  # noqa: E402

import hardware_stats

app = Flask(__name__)
# Re-reads templates/index.html per-request instead of caching it at first load -- the
# dashboard's own templates/index.html edits went unseen for hours tonight because nothing
# here ever restarted the process. Independent of the reloader below (this one's Jinja2's
# own cache, not Werkzeug's process-restart-on-.py-change).
app.config["TEMPLATES_AUTO_RELOAD"] = True


@app.errorhandler(HTTPException)
def handle_http_exception(e):
    # Every route here is called by the dashboard's fetch()-based JS, which always does
    # res.json() on the response. Flask's default abort() page is HTML, so without this
    # handler a 400/404/etc surfaces to the user as "Unexpected token '<'" instead of
    # the actual description passed to abort().
    return jsonify(description=e.description), e.code


# --- LAN access (companion app) -------------------------------------------------------
# Historically this server bound 127.0.0.1 and loopback WAS the trust boundary: every
# write endpoint (including the claude-token setter) assumes anyone reaching the port is
# the owner. AGENT_MANAGER_DASHBOARD_HOST=0.0.0.0 opts into LAN binding for the Android
# companion app -- and because that widens who can reach the port, mutating verbs from
# NON-loopback callers then REQUIRE a shared secret (AGENT_MANAGER_DASHBOARD_TOKEN as
# "Authorization: Bearer <token>"). Loopback keeps working untouched either way, and
# GET/HEAD/OPTIONS are never gated (reads only). With no token configured, non-loopback
# mutating requests are refused outright rather than silently allowed -- the historical
# trust boundary is preserved, never weakened by the host flag alone.
LAN_TOKEN = (os.environ.get("AGENT_MANAGER_DASHBOARD_TOKEN") or "").strip()


def _is_loopback_caller() -> bool:
    ip = request.remote_addr or ""
    return ip in ("127.0.0.1", "::1", "::ffff:127.0.0.1", "")


@app.before_request
def lan_mutation_gate():
    if request.method in ("GET", "HEAD", "OPTIONS") or _is_loopback_caller():
        return None
    supplied = request.headers.get("Authorization", "")
    if LAN_TOKEN and supplied == f"Bearer {LAN_TOKEN}":
        return None
    if not LAN_TOKEN:
        abort(403, description=(
            "Mutating requests from other machines need AGENT_MANAGER_DASHBOARD_TOKEN "
            "set on the dashboard and supplied as a Bearer token."
        ))
    abort(401, description="Bad or missing Bearer token.")


@app.route("/api/ping")
def api_ping():
    # Identity endpoint for the companion app's server-list health check. Shape mirrors
    # TheAgent's /api/ping ({app, name, version}) so one client convention covers both.
    return jsonify({"app": "agent-manager", "name": socket.gethostname(), "version": "1"})


import logging

logger = logging.getLogger(__name__)


_NEEDS_CLARIFICATION_REASON_TEXT = {
    "no-match": "No matching file found for this change.",
    "ambiguous": "Multiple candidate files found -- needs a human pick.",
}


def _alert_last_seen_path() -> Path | None:
    """Last-seen alert-ids store for the /api/alerts webhook notifier -- the same
    pipeline-dir derivation queue_dir()/alerts_path() already use (see
    get_pipeline_dir()), so no extra config knob: <pipeline>/alert_last_seen_ids.json."""
    d = get_pipeline_dir()
    return (d / "alert_last_seen_ids.json") if d else None


def _fire_alert_webhook(alerts: list) -> None:
    """Notify a configured webhook target about alerts not seen on the previous
    /api/alerts response (design decision 2026-08-24: webhook, not Web Push).

    Fully opt-in -- a no-op unless AGENT_MANAGER_ALERT_WEBHOOK_URL is set. The target
    is POSTed ntfy-style (plain-text body + Title/Priority headers), which is just a
    plain HTTP POST, so swapping to Pushover or any other endpoint is a config change,
    not a code change. Best-effort by contract: never raises, so a notification
    failure can never break the alert feed itself. Only successfully-delivered ids are
    recorded as seen; undelivered ones are retried on the next poll."""
    url = (os.environ.get("AGENT_MANAGER_ALERT_WEBHOOK_URL") or "").strip()
    if not url:
        return
    p = _alert_last_seen_path()
    if not p:
        return

    seen: list = []
    if p.is_file():
        data = read_json_safe(p) or {}
        if isinstance(data, dict):
            candidate = data.get("seen_ids")
            if isinstance(candidate, list):
                seen = [s for s in candidate if isinstance(s, str)]
    seen_set = set(seen)

    new = [
        a for a in alerts
        if isinstance(a, dict) and isinstance(a.get("id"), str) and a["id"] not in seen_set
    ]
    if not new:
        return

    import urllib.request
    import concurrent.futures

    def _post_one(a: dict) -> tuple:
        title = (a.get("title") or "Agent Manager alert")[:200]
        body = a.get("body") or a.get("title") or a.get("id") or ""
        # ntfy priority mapping: error-level alerts are high, everything else default.
        priority = "high" if a.get("level") in ("error", "critical") else "default"
        req = urllib.request.Request(
            url,
            data=body.encode("utf-8"),
            headers={"Title": title, "Priority": priority},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
            return (a["id"], True, None)
        except Exception as exc:
            logger.warning("Alert webhook POST failed for %s (%s): %s", a.get("id"), url, exc)
            return (a.get("id"), False, str(exc))

    delivered: list = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(new), 8)) as pool:
        futures = [pool.submit(_post_one, a) for a in new]
        try:
            for fut in concurrent.futures.as_completed(futures, timeout=10):
                alert_id, ok, _err = fut.result()
                if ok:
                    delivered.append(alert_id)
        except concurrent.futures.TimeoutError:
            logger.warning("Alert webhook: some alerts not confirmed delivered within 10s")
            for fut in futures:
                fut.cancel()
    if not delivered:
        return

    try:
        merged = list(dict.fromkeys(seen + delivered))[-2000:]
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(
            json.dumps({
                "seen_ids": merged,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }),
            encoding="utf-8",
        )
        os.replace(str(tmp), str(p))
    except OSError as exc:
        logger.warning("Alert last-seen store write failed: %s (%s)", p, exc)


@app.route("/api/alerts")
def api_alerts():
    """Companion app's notification-bell feed (Android: AlertPoller.kt polls this every
    ~15 min while a machine's bell is on). Surfaces exactly the "needs a human" states
    the dashboard's own nav badges already flag -- blocked/needs-clarification/
    awaiting-confirm queue tasks, plus a stuck-actioned Brain Dump entry
    (BRAIN_DUMP_NEEDS_ATTENTION_STATES, the same set _brain_dump_needs_attention_count
    already uses) -- as individually-id'd alerts.

    Always returns the CURRENT full set, not a delta: the client already owns
    de-duplication and backlog suppression (a freshly-linked machine swallows existing
    history silently, only notifies from the next genuinely-new id onward -- see
    AlertPoller.pollAll's own comment), so this endpoint just needs to be an honest,
    stable-id snapshot of what's actually outstanding right now. Read-only, never gated
    (see lan_mutation_gate above -- GET is always ungated regardless of caller)."""
    alerts = []
    qdir = queue_dir()
    if qdir:
        for state, level in (
            ("blocked", "error"),
            ("needs-clarification", "warn"),
            ("awaiting-confirm", "error"),
        ):
            state_dir = qdir / state
            if not state_dir.is_dir():
                continue
            for f in state_dir.glob("*.json"):
                data = read_json_safe(f)
                if not data:
                    continue
                task_id = data.get("id", f.stem)
                title = (data.get("title") or task_id)[:120]
                if state == "blocked":
                    body = data.get("blockedReason") or "Blocked -- see dashboard for details."
                elif state == "needs-clarification":
                    reason = (data.get("needsClarification") or {}).get("reason")
                    body = _NEEDS_CLARIFICATION_REASON_TEXT.get(
                        reason, "Needs clarification -- see dashboard for details.")
                elif data.get("source") == "pipeline_forensics":
                    body = "Forensic root-cause report ready -- review it, then Confirm to file a pipeline-fix candidate."
                else:
                    body = "A delete-containing change is held for confirmation."
                alerts.append({
                    "id": f"task:{state}:{task_id}",
                    "title": title,
                    "level": level,
                    "body": body[:200],
                })

    for e in _brain_dump_entries_with_task_status():
        if e.get("status") == "actioned" and e.get("taskStatus") in BRAIN_DUMP_NEEDS_ATTENTION_STATES:
            entry_id = e.get("id")
            if not entry_id:
                continue
            alerts.append({
                "id": f"brain-dump:{entry_id}",
                "title": (e.get("rawText") or "Brain dump entry")[:120],
                "level": "warn",
                "body": f"Actioned entry's task is {e.get('taskStatus')} -- needs a look.",
            })

    # National-backfill event feed (progress-report.js writes alerts.json; see
    # alerts_path()). Was its own duplicate @app.route("/api/alerts") definition after
    # the 2026-08-22 master merge landed both this queue-derived feed (2c66a17) and the
    # file-based one (6de654c) -- Flask refuses to even start with two routes on one
    # rule, so the two sources are merged into this single endpoint instead. File
    # entries already carry their own stable ids ({id, at, level, title, body}), so the
    # client's id-based dedupe works unchanged across both sources.
    generated_at = None
    p = alerts_path()
    if p and p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            generated_at = data.get("generatedAt")
            alerts.extend(data.get("alerts") or [])
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Alert feed read failed: %s (%s)", p, exc)
        except Exception:
            logger.exception("Alert feed read failed unexpectedly: %s", p)

    # Webhook notification side-effect (see _fire_alert_webhook): fires for alerts not
    # seen on the previous call. No-op unless AGENT_MANAGER_ALERT_WEBHOOK_URL is set;
    # it never raises by contract, this guard is belt-and-suspenders so the feed itself
    # can't 500 over a notification bug.
    try:
        _fire_alert_webhook(alerts)
    except Exception:
        logger.exception("Alert webhook side-effect failed")

    return jsonify({"generatedAt": generated_at, "alerts": alerts})


QUEUE_STATES = ["pending", "review", "approved", "blocked", "done", "needs-clarification", "awaiting-confirm", "coordinating"]

# dashboard/ -> python/ -> package root (where agent-manager.env, launch.bat, and src/ live).
PACKAGE_ROOT = Path(__file__).resolve().parent.parent.parent
ENV_FILE_PATH = PACKAGE_ROOT / "agent-manager.env"
SRC_DIR = PACKAGE_ROOT / "src"
# Which AGENT_MANAGER_REGISTER_PATH plugins are installed / enabled. Read by src/config.js's
# ensureRegistered() (JS side: src/plugins-manifest.js) and by the Plugins tab here. Lives
# beside agent-manager.env; seeded from AGENT_MANAGER_REGISTER_PATH on first read.
PLUGINS_MANIFEST_PATH = PACKAGE_ROOT / "plugins.json"
# Where installed plugins live (overridable for tests), and the static marketplace
# catalog file (plugins-catalog.json) at the package root. The dashboard only reads
# and validates the catalog -- it never fetches or writes it.
PLUGINS_INSTALL_DIR_ENV = "AGENT_MANAGER_PLUGINS_DIR"
PLUGINS_INSTALL_DIR_DEFAULT = PACKAGE_ROOT / "plugins"
PLUGIN_CATALOG_PATH = PACKAGE_ROOT / "plugins-catalog.json"

# Project tab's "previously loaded projects" dropdown/search-list. Separate from
# agent-manager.env (which only ever holds the CURRENT project) -- this is a small,
# append-only-ish history so the Project tab can offer past paths without you re-typing
# or re-browsing them every time. Recorded whenever a path is actually used for something
# real (Start Pipeline or Build Graph), not on every keystroke/browse.
PROJECT_HISTORY_PATH = PACKAGE_ROOT / "project-history.json"
MAX_PROJECT_HISTORY = 25


def read_project_history() -> list:
    """Most-recently-used first. Corrupt/missing file -> empty list, never a 500 --
    this is a convenience list, not state anything else depends on."""
    if not PROJECT_HISTORY_PATH.is_file():
        return []
    try:
        data = json.loads(PROJECT_HISTORY_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def record_project_used(path: str):
    """Moves `path` to the front if already present (so re-using a project bumps it back
    to most-recent, rather than accumulating duplicate stale entries), otherwise inserts
    it, then truncates to MAX_PROJECT_HISTORY. Best-effort -- a write failure here should
    never break the actual Start Pipeline / Build Graph action it's attached to.

    Confirmed live (2026-07-22): the same TaxHarvest path got stored twice -- once with
    backslashes (typed/browsed via the UI, Windows-native) and once with forward slashes
    (this session's own API calls) -- because the old dedup compared raw strings. Both
    forms mean the identical directory; normalize with os.path.normpath before comparing
    or storing, so they collapse into one entry instead of silently accumulating
    look-alike duplicates."""
    try:
        normalized = os.path.normpath(path)
        history = read_project_history()
        history = [p for p in history if os.path.normpath(p) != normalized]
        history.insert(0, normalized)
        history = history[:MAX_PROJECT_HISTORY]
        PROJECT_HISTORY_PATH.write_text(json.dumps(history, indent=2), encoding="utf-8")
    except OSError as exc:
        logging.warning("Failed to persist project history to %s: %s", PROJECT_HISTORY_PATH, exc, exc_info=exc)


# Live dashboard settings a user changes by clicking in the UI, not by editing
# agent-manager.env -- that file only takes effect on the next pipeline restart (every
# daemon sources it once at launch, see stop.sh/launch.sh), which is the wrong shape for
# "pick a model for the conversation I'm about to start." Same "small JSON file next to
# the other small state files" convention as PROJECT_HISTORY_PATH above, not a database,
# since this is a handful of scalar preferences.
DASHBOARD_SETTINGS_PATH = PACKAGE_ROOT / "dashboard-settings.json"
CLAUDE_MODEL_CHOICES = ["sonnet", "opus", "haiku", "fable"]
CLAUDE_EFFORT_CHOICES = ["low", "medium", "high", "xhigh", "max"]


def read_dashboard_settings() -> dict:
    if not DASHBOARD_SETTINGS_PATH.is_file():
        return {}
    try:
        data = json.loads(DASHBOARD_SETTINGS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def write_dashboard_settings(patch: dict):
    """Merges `patch` into the existing settings file rather than overwriting it --
    other, unrelated settings (present or future) must survive a write to just the
    Claude defaults, same reasoning server-managed settings merging documents for its
    own env-block precedence elsewhere in this codebase."""
    current = read_dashboard_settings()
    current.update(patch)
    DASHBOARD_SETTINGS_PATH.write_text(json.dumps(current, indent=2), encoding="utf-8")


def claude_defaults() -> dict:
    settings = read_dashboard_settings()
    return {
        "model": settings.get("claudeDefaultModel") or "sonnet",
        "effort": settings.get("claudeDefaultEffort") or "high",
    }


def _discuss_provider_args(body: dict = None):
    """Reads {provider, model, effort} for a discuss/start call: per-call override from
    the request body when the toggle in the UI picked one, else the Models tab's saved
    Claude defaults (only consulted when provider is actually "claude" -- a local-model
    call has no use for them). Centralized here so all three discuss/start routes
    (brain-dump, needs-clarification, second-brain) apply the exact same fallback."""
    if body is None:
        body = request.get_json(silent=True) or {}
    provider = (body.get("provider") or "local").strip().lower()
    if provider not in ("local", "claude"):
        provider = "local"
    model = body.get("model")
    effort = body.get("effort")
    if provider == "claude":
        defaults = claude_defaults()
        model = model or defaults["model"]
        effort = effort or defaults["effort"]
    else:
        model = None
        effort = None
    return provider, model, effort


def _call_discuss(fn, *args, **kwargs):
    """Runs a discuss_sessions.py call (start_session/send_message/end_session) and
    turns claude_client.ClaudeClientError into a clean 4xx/5xx JSON response instead of
    an unhandled-exception 500 -- confirmed live: a Claude-provider discuss/start with
    CLAUDE_CODE_OAUTH_TOKEN unset previously surfaced as Flask's generic "internal
    error" page with no indication of what actually went wrong or how to fix it.

    2026-08-24 -- caught live via an actual Discuss click on the local provider: worker-1
    was mid-draft on the same Ollama model at that exact moment (Discuss has no
    coordination with the worker lanes' own use of it -- see the standing, deliberately-
    deferred discussion on adding a shared lock), the reply call queued behind it and hit
    ollama_client.py's own 240s timeout, and that raised a bare TimeoutError with no
    handling here at all -- same raw-500-with-no-explanation failure mode this function
    already exists to prevent for the Claude side, just never extended to Ollama's own
    connection/timeout errors."""
    from claude_client import ClaudeClientError
    try:
        return fn(*args, **kwargs)
    except ClaudeClientError as e:
        abort(502, description=str(e))
    except (TimeoutError, ConnectionError, OSError) as e:
        abort(502, description=f"local model call failed ({e}) -- it may be busy with an active worker-lane task; try again shortly or switch to Claude.")


def is_claude_token_configured() -> bool:
    """Checks both the current process env (set by _start_pipeline-style mutation, or by
    however this dashboard itself was launched) and agent-manager.env on disk (set by
    api_set_claude_token below, or by hand) -- either one is enough for claude-client.js
    to actually pick it up at the next daemon launch. Never returns the token itself,
    only whether one is present -- see api_set_claude_token's own header for why."""
    return bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or read_env_file(ENV_FILE_PATH).get("CLAUDE_CODE_OAUTH_TOKEN"))


@app.route("/api/settings/claude", methods=["GET"])
def api_get_claude_settings():
    return jsonify({
        **claude_defaults(),
        "modelChoices": CLAUDE_MODEL_CHOICES,
        "effortChoices": CLAUDE_EFFORT_CHOICES,
        "tokenConfigured": is_claude_token_configured(),
    })


@app.route("/api/settings/claude-token", methods=["POST"])
def api_set_claude_token():
    """Write-only, deliberately -- CLAUDE_CODE_OAUTH_TOKEN is a real, ~1-year-lived
    credential for the user's own Claude subscription (see claude-client.js's own header
    for the billing-safety reasoning it exists for). This endpoint accepts it and never
    echoes it back in any response; api_get_claude_settings above reports only whether
    one is configured, never its value. Same "loopback-only dashboard, plaintext POST is
    fine" trust boundary as every other write endpoint here (app.run(host="127.0.0.1")).

    Writes to agent-manager.env (same helper /api/pipeline/start already uses for
    AGENT_MANAGER_REPO_ROOT) so it survives every future restart, not just this one --
    then mutates os.environ so THIS dashboard process's own env reflects it immediately
    (same reasoning _start_pipeline's own os.environ mutation comment gives for
    AGENT_MANAGER_REPO_ROOT), and restarts the pipeline if one is currently configured
    so the change takes effect right away instead of silently waiting for some future
    manual restart the user has no reason to think is still needed."""
    body = request.get_json(silent=True) or {}
    raw_token = body.get("token") or ""
    # Strip ALL whitespace, not just leading/trailing -- a real token
    # (sk-ant-oat01-...) never legitimately contains any. Confirmed live 2026-08-16: a
    # token pasted from a terminal that had wrapped it across two lines picked up an
    # extra space or two at the wrap point, producing a value that looked plausible
    # (right length, right prefix) but failed Claude's own auth check with a 401 "OAuth
    # access token is invalid" -- silent and confusing from the user's side, since
    # nothing here validated the shape before saving it. Removing internal whitespace
    # rather than rejecting it: the corruption is common enough (long tokens + wrapped
    # terminals) that silently fixing it is more useful than making the user notice,
    # copy again, and hope it doesn't wrap the same way a second time.
    token = re.sub(r"\s+", "", raw_token)
    if not token:
        abort(400, description="token is required")
    if not token.startswith("sk-ant-oat"):
        abort(400, description="that doesn't look like a Claude Code OAuth token (expected it to start with \"sk-ant-oat\") -- double check what was pasted")
    write_env_value(ENV_FILE_PATH, "CLAUDE_CODE_OAUTH_TOKEN", token)
    os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = token
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True
    return jsonify({"saved": True, "restarted": restarted})


@app.route("/api/settings/claude-token", methods=["DELETE"])
def api_clear_claude_token():
    """Removes the token from agent-manager.env and this process's own env -- e.g. to
    revoke a compromised token or switch to a different subscription account. Does NOT
    restart the pipeline: an already-running claude-client.js call in flight should be
    allowed to finish rather than be killed mid-call by a credential removal, and the
    next call after this will fail its own auth guard cleanly (see that module's header)
    rather than silently keep using a token that's supposed to be gone."""
    write_env_value(ENV_FILE_PATH, "CLAUDE_CODE_OAUTH_TOKEN", "")
    os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
    return jsonify({"cleared": True})


@app.route("/api/settings/claude", methods=["POST"])
def api_set_claude_settings():
    body = request.get_json(silent=True) or {}
    patch = {}
    model = (body.get("model") or "").strip()
    effort = (body.get("effort") or "").strip()
    if model:
        if model not in CLAUDE_MODEL_CHOICES:
            abort(400, description=f"model must be one of {CLAUDE_MODEL_CHOICES}")
        patch["claudeDefaultModel"] = model
    if effort:
        if effort not in CLAUDE_EFFORT_CHOICES:
            abort(400, description=f"effort must be one of {CLAUDE_EFFORT_CHOICES}")
        patch["claudeDefaultEffort"] = effort
    if patch:
        write_dashboard_settings(patch)
    return jsonify(claude_defaults())


@app.route("/api/claude-usage", methods=["GET"])
def api_claude_usage():
    """Wraps budget-monitor.js's isBudgetHealthy() -- see that module's own header for
    exactly what signal this is (and isn't): Claude Code itself only ever tells you a
    rate limit was hit, reactively, via an error event in its local session transcripts
    -- there's no live "you've used N% of your 5-hour window" API to poll. What this
    surfaces is real: the last actual rate-limit hit and its reset time (if any), token
    and call counts since the current window's real start (`sinceLastLimit` -- anchored to
    the last reset, not a generic trailing lookback) plus a 7d rolling volume trend, and
    (Brain Dump #89, 2026-08-18) an
    `estimate` object with a used/ceiling percentage and a projected time-to-cap -- see
    budget-monitor.js's own estimateBudgetCeiling()/estimateTimeToCap() for how that's
    derived ENTIRELY from real past rate-limit hits, never an invented number; `estimate`
    is null when no real hit has been observed yet in the lookback window. None of this is
    a precise live quota gauge. Scans ~/.claude/projects, so headless calls this pipeline
    makes via claude-client.js show up in the same rolling counts as any interactive
    `claude` session on this machine, since both write to the same transcript directory."""
    script_path = PACKAGE_ROOT / "budget-monitor.js"
    try:
        result = subprocess.run(["node", str(script_path)], capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return jsonify({"available": False, "reason": "budget-monitor.js timed out"}), 504
    if result.returncode != 0:
        return jsonify({"available": False, "reason": (result.stderr or "budget-monitor.js exited non-zero").strip()[:500]})
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return jsonify({"available": False, "reason": "budget-monitor.js returned non-JSON output"})
    return jsonify({"available": True, **data})


PROJECT_REGISTRY_PATH = PACKAGE_ROOT / "projects.json"


def read_project_registry() -> list:
    """List of {repoRoot, pipelineDir, domainsPath, label} for every project ever started
    via the Project tab -- project-history.json only stores a bare repo path, which isn't
    enough to locate a non-active project's queue/task-domains.json later. Corrupt/missing
    file -> empty list, never a 500."""
    if not PROJECT_REGISTRY_PATH.is_file():
        return []
    try:
        data = json.loads(PROJECT_REGISTRY_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def record_project_registry_entry(repo_root: str, pipeline_dir: str, domains_path: str):
    """Upserts one entry keyed by normalized repoRoot (moves it to the front if already
    present, same normalize-before-compare reasoning as record_project_used, so a
    backslash vs forward-slash path for the same directory collapses to one entry).
    Best-effort -- a write failure here must never break Start Pipeline."""
    try:
        normalized_root = os.path.normpath(repo_root)
        entries = read_project_registry()
        entries = [e for e in entries if os.path.normpath(e.get("repoRoot", "")) != normalized_root]
        entries.insert(0, {
            "repoRoot": normalized_root,
            "pipelineDir": os.path.normpath(pipeline_dir),
            "domainsPath": os.path.normpath(domains_path),
            "label": Path(normalized_root).name,
        })
        PROJECT_REGISTRY_PATH.write_text(json.dumps(entries, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.warning("Failed to write project registry at %s: %s", PROJECT_REGISTRY_PATH, exc)

# Project tab: browsing/graphing an arbitrary codebase is decoupled from whichever repo
# the live worker/review-runner/apply-runner/queue-watchdog loops are actually pointed at
# (that's still controlled by agent-manager.env + launch.bat) -- this lets you explore any
# project's structure without touching, or needing, a running pipeline for it.
#
# The cache itself lives INSIDE the browsed project (`.agent-manager-cache/<slug>/`), not
# here -- so the same layout (including manual community drags) is available no matter
# which agent-manager install/machine browses that project, not just this one. This is
# the *old* (pre-2026-07-18) location: kept around purely as a migration source and a
# write-failure fallback (see _migrate_legacy_cache_if_needed and the mkdir try/except at
# each write site) -- never written to directly for a project going forward.
PROJECT_CACHE_DIR = Path(__file__).resolve().parent / "project_cache"

# In-memory only -- background-build progress/status for whichever project(s) a build was
# triggered for THIS server process's lifetime. Deliberately not persisted: a build in
# progress when the server restarts should just be re-triggered, not resumed.
_build_state = {}
_build_lock = threading.Lock()

# Chat panel "fully reserve the reasoning model" (Brain Dump #153) -- in-memory only,
# same "server restart just drops it" reasoning as _build_state above: an open flock file
# handle isn't meaningfully persistable anyway. Keyed by chat session id ->
# {"fh": <open file object from single_flight_lock.acquire()>, "lastActivity": float,
# "storageDir": Path}. _chat_reservations_lock guards concurrent access from the
# request-handling thread (toggling on/off, refreshing lastActivity) and the watchdog
# thread below (sweeping for staleness) -- Flask runs threaded=True, so these genuinely
# race without it.
_chat_reservations = {}
_chat_reservations_lock = threading.Lock()
# 10 minutes (Grimmethy's choice, discussed live): long enough that a normal pause
# between messages never trips it, short enough that a crashed tab or forgotten toggle
# can't starve the pipeline for more than this -- same staleness-window reasoning as
# worker-instance liveness checks elsewhere in this pipeline.
CHAT_RESERVATION_IDLE_TIMEOUT_S = 600


def _chat_reservation_watchdog():
    """Started once at process init (see the bottom of this file) -- no existing
    scheduler/timer infrastructure runs inside this Flask process to piggyback on
    (confirmed: the only other background thread here, _run_build, is a one-shot
    fire-and-forget worker, not periodic), so this is a small standalone sleep-and-sweep
    loop, same daemon=True fire-and-forget shape as that one."""
    import chat_sessions
    import single_flight_lock
    while True:
        time.sleep(60)
        now = time.time()
        with _chat_reservations_lock:
            stale_ids = [sid for sid, r in _chat_reservations.items()
                         if now - r["lastActivity"] > CHAT_RESERVATION_IDLE_TIMEOUT_S]
            for sid in stale_ids:
                record = _chat_reservations.pop(sid)
                single_flight_lock.release(record["fh"])
                try:
                    chat_sessions.set_reserved(record["storageDir"], sid, False)
                except Exception as exc:
                    logger.warning("Failed to clear reserved flag for session %s in %s: %s: %s", sid, record["storageDir"], type(exc).__name__, exc)  # best-effort -- logged, not re-raised; lock already released


def project_slug(path_str: str) -> str:
    """Old (pre-2026-07-18) hashing scheme -- only used now to locate a legacy cache to
    migrate from, since the cache is no longer keyed by path (it lives inside that exact
    path now, so there's nothing left to disambiguate at that level)."""
    return hashlib.sha256(path_str.encode("utf-8")).hexdigest()[:16]


def _grepdirs_slug(grep_dirs: list[str]) -> str:
    """'default' for the common no-grepDirs case (readable, not an opaque hash) --
    otherwise a short hash of the sorted list, so browsing the same project with
    different grepDirs gets separate cache entries instead of silently overwriting one
    with the other (a real collision in the old path-only-keyed scheme)."""
    if not grep_dirs:
        return "default"
    key = ",".join(sorted(grep_dirs))
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def _cache_paths_for_dir(cache_dir: Path) -> dict:
    return {
        "dir": cache_dir,
        "graph": cache_dir / "graph.json",
        "coverage": cache_dir / "coverage.json",
        "meta": cache_dir / "meta.json",
        "positions": cache_dir / "positions.json",
        # 2026-08-24 (Brain Dump #155: "Every time I build a project graph it starts from
        # scratch... build on diff's") -- per-file mtime/size -> resolved-edges cache, see
        # build_graph.py's build_import_graph. Build-process bookkeeping, not graph data
        # any consumer reads, same reasoning as build_graph.py's own .graph-file-cache.json
        # living under instances/ rather than next to graph.json.
        "file_cache": cache_dir / "file-cache.json",
    }


def project_cache_paths(path_str: str, grep_dirs: list[str] | None = None) -> dict:
    return _cache_paths_for_dir(Path(path_str) / ".agent-manager-cache" / _grepdirs_slug(grep_dirs or []))


def _fallback_cache_paths(path_str: str, grep_dirs: list[str] | None = None) -> dict:
    """Used only when writing into the project itself fails (read-only mount,
    permissions) -- the old dashboard-side location as a last resort so a build/save
    doesn't just fail outright."""
    return _cache_paths_for_dir(PROJECT_CACHE_DIR / project_slug(path_str) / _grepdirs_slug(grep_dirs or []))


def resolve_writable_cache(path_str: str, grep_dirs: list[str] | None = None) -> dict:
    """The one place both write sites (_run_build, api_project_positions) go through,
    instead of each inlining its own copy of the same mkdir-try/except/fallback dance.
    Returns project_cache_paths(...) with its directory already created, falling back to
    the old dashboard-side location (creating THAT instead) if the project-local one
    can't be created (read-only mount, permissions) -- a build/save doesn't just fail
    outright on a read-only project."""
    cache = project_cache_paths(path_str, grep_dirs)
    try:
        cache["dir"].mkdir(parents=True, exist_ok=True)
        return cache
    except OSError:
        fallback = _fallback_cache_paths(path_str, grep_dirs)
        logger.warning(
            "Cache mkdir failed for %s; falling back to %s",
            cache["dir"], fallback["dir"],
            exc_info=True,
        )
        fallback["dir"].mkdir(parents=True, exist_ok=True)
        return fallback


def _migrate_legacy_cache_if_needed(path_str: str, cache: dict) -> None:
    """One-time, best-effort copy from the old dashboard-side cache (keyed by path only,
    no grepDirs distinction) into the new project-local location. No-ops once the new
    location already has a graph (whether from migration or a fresh build), so this is
    cheap to call on every read. Copies, never moves -- the old cache is left alone in
    case something goes wrong partway through."""
    if cache["graph"].is_file():
        return
    legacy_dir = PROJECT_CACHE_DIR / project_slug(path_str)
    if not legacy_dir.is_dir():
        return
    try:
        cache["dir"].mkdir(parents=True, exist_ok=True)
        for key in ("graph", "coverage", "meta", "positions"):
            legacy_file = legacy_dir / cache[key].name
            if legacy_file.is_file():
                shutil.copy2(legacy_file, cache[key])
    except OSError:
        pass  # best-effort -- a failed migration just means one more fresh layout run

# Same staleness thresholds an earlier version of this dashboard already used: a 'working'
# instance legitimately takes many minutes between heartbeats (a single model call can run
# long), so it gets a generous threshold; anything else stale after 3 minutes means the
# instance stopped progressing.
WORKING_STALE_SECONDS = 1200
OTHER_STALE_SECONDS = 180


def read_env_file(env_path: Path) -> dict:
    """Same KEY=VALUE, comment/blank-line-skipping shape launch.bat's own .env parser
    reads -- kept as plain text, not JSON, so both the dashboard and launch.bat agree on
    one file format."""
    result = {}
    if not env_path.is_file():
        return result
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        result[key.strip()] = value.strip()
    return result


def backfill_env_from_file(env_path: Path) -> list:
    """os.environ.setdefault() every KEY=VALUE from agent-manager.env -- never overriding an
    explicitly-exported value. scripts/launch.sh does `set -a; source agent-manager.env` so
    daemons it starts inherit AGENT_MANAGER_REPO_ROOT et al, and the dashboard passes its
    own environment straight through to the node children it shells out to
    (local-tool-client.js for Chat, ...). Started any other way those vars are absent and
    Chat breaks first (local-tool-client.js's getConfig() aborts, the turn comes back
    empty -- confirmed live 2026-09-02). Returns the keys it actually filled in."""
    filled = []
    for k, v in read_env_file(env_path).items():
        if v and k not in os.environ:
            os.environ[k] = v
            filled.append(k)
    return filled


def write_env_value(env_path: Path, key: str, value: str):
    """Updates one KEY=VALUE line in place if it already exists (preserving every other
    line, comments included), or appends it if not. Used by /api/pipeline/start so
    picking a project from the Project tab's browser persists across dashboard restarts
    the same way hand-editing agent-manager.env always has."""
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.is_file() else []
    found = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        existing_key = stripped.partition("=")[0].strip()
        if existing_key == key:
            lines[i] = f"{key}={value}"
            found = True
            break
    if not found:
        lines.append(f"{key}={value}")
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _active_project_setting(key: str) -> str | None:
    """Which project the dashboard is showing, and where its queue/state lives. The
    agent-manager.env FILE wins over os.environ for these -- inverted from the usual
    "env overrides file" precedence (2026-08-30, live incident: the dashboard silently
    served the wrong project's queue after a hot-reload).

    Rationale: the ONLY way the dashboard switches project is Project tab -> _start_pipeline(),
    which always writes the new value to agent-manager.env. os.environ, by contrast, goes
    STALE: Werkzeug's reloader re-execs this process on every .py change from the reloader
    SUPERVISOR's launch-time environment, discarding the os.environ mutation _start_pipeline
    made in the (now-dead) child -- so after any hot-reload the env var holds whatever
    project the dashboard was FIRST launched against, while the file holds the truth. The
    4 pipeline loop scripts are unaffected: they `source` agent-manager.env directly and
    never call this. os.environ stays as the fallback for a dashboard started before
    anything was written to the file."""
    v = read_env_file(ENV_FILE_PATH).get(key)
    if v:
        return v
    return os.environ.get(key)


def get_active_repo_root() -> str | None:
    return _active_project_setting("AGENT_MANAGER_REPO_ROOT")


def get_active_grep_dirs() -> str | None:
    """The one other setting Ornith's harness-mediated retrieval needs (discuss_sessions.py's
    _local_harness_context) -- grep-codebase-tool.js/arch-import-fetch.js's own repoRoot-
    relative search scope. Unset means grep_fetch_client falls back to the same
    'frontend/src,backend/src' default src/config.js's getConfig() already uses for every
    other AGENT_MANAGER_GREP_DIRS consumer. Same file-first resolution as
    get_active_repo_root() -- see _active_project_setting()."""
    return _active_project_setting("AGENT_MANAGER_GREP_DIRS")


def get_pipeline_dir() -> Path | None:
    pipeline_dir = _active_project_setting("AGENT_MANAGER_PIPELINE_DIR")
    if pipeline_dir:
        return Path(pipeline_dir)
    repo_root = get_active_repo_root()
    return Path(repo_root) if repo_root else None


def queue_dir() -> Path | None:
    d = get_pipeline_dir()
    return (d / "queue") if d else None


def alerts_path() -> Path | None:
    """Alert feed for the companion app's background poller. Explicit override first;
    otherwise the national backfill loop's conventional location relative to the pipeline
    dir (<pipeline>/../../national-coverage/alerts.json — see NATIONAL-BACKFILL-LOOP.md
    in the TaxHarvest repo). None when neither exists: /api/alerts then returns an empty
    feed rather than 404, so the app's poller needs no per-server capability check."""
    override = os.environ.get("AGENT_MANAGER_ALERTS_PATH") or read_env_file(ENV_FILE_PATH).get(
        "AGENT_MANAGER_ALERTS_PATH"
    )
    if override:
        return Path(override)
    d = get_pipeline_dir()
    if not d:
        return None
    candidate = d.parent.parent / "national-coverage" / "alerts.json"
    return candidate if candidate.exists() else None


def instances_dir() -> Path | None:
    d = get_pipeline_dir()
    return (d / "instances") if d else None


def deep_dive_coverage_path() -> Path | None:
    override = os.environ.get("AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH")
    if override:
        return Path(override)
    d = get_pipeline_dir()
    return (d / "deep-dive-coverage.json") if d else None


def project_search_index_path() -> Path | None:
    """Same default derivation src/config.js uses (a sibling UsefulProjectIndex directory
    next to the active project's repo root) -- kept in sync by hand since this dashboard
    is Python, not Node, and can't require() that file directly."""
    override = os.environ.get("AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH")
    if override:
        return Path(override)
    repo_root = get_active_repo_root()
    if not repo_root:
        return None
    return Path(repo_root).parent / "UsefulProjectIndex" / "INDEX.md"


def deep_dive_analysis_dir() -> Path | None:
    override = os.environ.get("AGENT_MANAGER_DEEP_DIVE_ANALYSIS_DIR")
    if override:
        return Path(override)
    idx = project_search_index_path()
    return (idx.parent / "analysis") if idx else None


def model_stats_db_path() -> Path | None:
    override = os.environ.get("AGENT_MANAGER_MODEL_STATS_DB_PATH")
    if override:
        return Path(override)
    d = get_pipeline_dir()
    return (d / "model-stats.db") if d else None


def _has_cost_usd_column(conn: sqlite3.Connection) -> bool:
    """cost_usd (2026-08-23, Grimmethy: "Do we have any way of knowing how much these
    tasks would cost using anthropic API?") -- model-stats-db.js's own ALTER TABLE
    migration only runs the next time a real recordCall() fires from the Node side; this
    Python reader can be hit BEFORE that ever happens (a fresh db, or an old one nobody's
    written to yet today), so every query touching cost_usd guards on this first rather
    than crashing with 'no such column' the moment someone opens the Models tab."""
    row = conn.execute("SELECT COUNT(*) FROM pragma_table_info('model_calls') WHERE name = 'cost_usd'").fetchone()
    return bool(row and row[0])


def _has_instance_id_column(conn: sqlite3.Connection) -> bool:
    """Same guard as _has_cost_usd_column above, for the instance_id column (2026-08-23,
    "Where else would it make sense to track it?" -> Workers tab, per-instance cost) --
    added in the same migration pass as cost_usd, but guarded independently since a
    caller should never assume two separate ALTER TABLE statements landed atomically."""
    row = conn.execute("SELECT COUNT(*) FROM pragma_table_info('model_calls') WHERE name = 'instance_id'").fetchone()
    return bool(row and row[0])


def _has_hypothetical_cost_column(conn: sqlite3.Connection) -> bool:
    """Same guard as _has_cost_usd_column above, for hypothetical_cost_usd (2026-08-23,
    Grimmethy: "Clarification on the anthropic costs. I'd like estimates for if we had
    used the API. Even if we used the local models.") -- unlike cost_usd (real spend,
    null for a local call), this column is always populated (the real cost for an actual
    Claude call, a token-based estimate via anthropic-pricing.js otherwise), so
    SUM(hypothetical_cost_usd) alone answers "what if everything had gone through the API."
    """
    row = conn.execute("SELECT COUNT(*) FROM pragma_table_info('model_calls') WHERE name = 'hypothetical_cost_usd'").fetchone()
    return bool(row and row[0])


def second_brain_dir() -> Path | None:
    """Same SECOND_BRAIN_DIR env var local-worker.ps1 / src/config.js already read --
    kept in sync by hand since this dashboard is Python, not Node. Falls back to reading
    agent-manager.env directly, same as get_active_repo_root(), since the dashboard is
    often started with no env vars pre-set at all."""
    v = os.environ.get("SECOND_BRAIN_DIR")
    if v:
        return Path(v)
    v = read_env_file(ENV_FILE_PATH).get("SECOND_BRAIN_DIR")
    return Path(v) if v else None


# GitHub projects root: PACKAGE_ROOT (this file's own install location) is always
# F:\GitHub\agent-manager (or equivalent), one level under the user's real GitHub folder,
# regardless of which OTHER project is currently active -- unlike deriving it from
# get_active_repo_root(), which can point anywhere (e.g. TaxHarvest lives nested under
# F:\GitHub\TaxHarvest-GrimmethyLocal\, not directly under F:\GitHub).
GITHUB_PROJECTS_ROOT = PACKAGE_ROOT.parent


def discover_github_repos() -> list[dict]:
    """Every immediate subdirectory of GITHUB_PROJECTS_ROOT that looks like a git repo
    (has a .git dir or worktree-link file). Best-effort: an unreadable root just yields
    an empty list rather than a 500."""
    try:
        candidates = sorted(GITHUB_PROJECTS_ROOT.iterdir(), key=lambda p: p.name.lower())
    except OSError as exc:
        logger.warning("Failed to list GitHub projects root %s: %s", GITHUB_PROJECTS_ROOT, exc)
        return []
    repos = []
    for child in candidates:
        try:
            if child.is_dir() and (child / ".git").exists():
                repos.append({"name": child.name, "path": str(child)})
        except OSError as exc:
            logger.warning("Skipping unreadable entry %s under %s: %s", child, GITHUB_PROJECTS_ROOT, exc)
            continue
    return repos


def second_brain_project_links_path() -> Path | None:
    """Lives inside the second brain vault itself (not the pipeline dir) -- this index is
    metadata ABOUT the vault's own notes, so it travels with the vault rather than with
    whichever project's pipeline happens to be active."""
    root = second_brain_dir()
    return (root / ".agent-manager-project-links.json") if root else None


def read_project_links() -> dict:
    """Maps a second-brain note's path (relative to SECOND_BRAIN_DIR, forward slashes) to
    the absolute repo path it represents -- built by /api/second-brain/sync-github-projects,
    consulted by /api/second-brain/browse so the frontend can offer a "Set as Active
    Project" button on the right file without re-reading every note's content on every
    browse call."""
    p = second_brain_project_links_path()
    if not p:
        return {}
    return read_json_safe(p) or {}


def write_project_links(links: dict):
    p = second_brain_project_links_path()
    if not p:
        return
    p.write_text(json.dumps(links, indent=2), encoding="utf-8")


def brain_dump_path() -> Path | None:
    override = os.environ.get("AGENT_MANAGER_BRAIN_DUMP_PATH") or read_env_file(ENV_FILE_PATH).get(
        "AGENT_MANAGER_BRAIN_DUMP_PATH"
    )
    if override:
        return Path(override)
    d = get_pipeline_dir()
    return (d / "brain-dump.json") if d else None


def job_type_counters_path() -> Path | None:
    """Mirrors src/config.js's jobTypeCountersPath default -- job-type-counters.json in
    pipelineDir, same env-override convention (AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH) as
    every other pipelineDir-relative state file above."""
    override = os.environ.get("AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH")
    if override:
        return Path(override)
    d = get_pipeline_dir()
    return (d / "job-type-counters.json") if d else None


def read_job_type_counters() -> dict:
    p = job_type_counters_path()
    if not p:
        return {}
    return read_json_safe(p) or {}


def read_json_safe(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


# Matches a `.` + at least 7 digits and captures the first 6 -- PowerShell's `Get-Date
# -Format 'o'` (used for every heartbeat/stateSince timestamp the *.ps1 scripts write)
# emits 7-digit fractional seconds (100ns ticks), e.g. "...33.6859854-06:00". Python's own
# datetime.fromisoformat only accepts EXACTLY 3 or 6 fractional digits before 3.11 -- this
# machine's dashboard runs under Python 3.10 (PowerShell's `python` resolves to a
# different, older interpreter than other shells here), so every such timestamp raised
# ValueError, silently caught by each call site's `except (ValueError, KeyError)`, and
# _pipeline_running() always returned False regardless of the real pipeline state.
# Confirmed live (2026-07-22): datetime.fromisoformat('...6859854-06:00') raises
# "Invalid isoformat string" under 3.10.11, parses fine under 3.12. Truncating to 6
# digits here makes this correct on any Python 3.x runtime, not just 3.11+.
_EXCESS_FRACTIONAL_SECONDS_RE = re.compile(r"(\.\d{6})\d+")


def parse_hb_timestamp(ts: str):
    """Parses a PowerShell-emitted ISO timestamp into a tz-aware UTC datetime, or None on
    any failure. Centralizes the Z-replacement + fractional-seconds-truncation + naive-to-
    UTC handling that was previously duplicated (inconsistently) at three call sites."""
    if not ts:
        return None
    normalized = _EXCESS_FRACTIONAL_SECONDS_RE.sub(r"\1", ts.replace("Z", "+00:00"))
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def task_summary(data: dict, filename: str) -> dict:
    """Deliberately excludes planResponse/implementResponse/promptContext -- those can
    carry tens of thousands of characters of embedded file content (arch_discovery
    especially) and would make the list view slow to load for no benefit; the detail
    endpoint returns the full task."""
    return {
        "id": data.get("id", filename),
        "title": data.get("title"),
        "domain": data.get("domain"),
        "source": data.get("source"),
        "status": data.get("status"),
        "blockedReason": data.get("blockedReason"),
        "blockedStage": data.get("blockedStage"),
        "branch": data.get("branch"),
        "compareUrl": data.get("compareUrl"),
        "doneMarker": data.get("doneMarker"),
        "createdAt": data.get("createdAt"),
        "reviewedAt": data.get("reviewedAt"),
        "appliedAt": data.get("appliedAt"),
        "localRejectCount": data.get("localRejectCount", data.get("ornithRejectCount")),
        # Small (a reason string + a handful of short candidate paths at most) -- nothing
        # like the promptContext/planResponse bulk excluded above, and the needs-
        # clarification row rendering needs it to show WHICH kind of hold this is without
        # a second round-trip per row.
        "needsClarification": data.get("needsClarification"),
        # Small {reason,disposition,confidence,evidence[],flaggedAt} object stamped by
        # adhoc-staleness-flag.js / staleness-auto-archive.js -- the row shows a chip +
        # Archive/Keep buttons so a human can retire a dead adhoc task without opening it.
        "stalenessFlag": data.get("stalenessFlag"),
        # Coordinator (decomposed parent) checklist -- a small [{id,title,status}] list plus
        # a {done,total} rollup, stamped by coordinator-sweep.js. The Coordinating list row
        # shows the "N of M" from `progress` without a per-row round-trip.
        "subTasks": data.get("subTasks"),
        "progress": data.get("progress"),
        # coordinator-sweep.js stamps this on a hub whose remaining sub-tasks can't proceed
        # (a child stuck in needs-clarification/blocked, or a sibling waiting on one). The
        # Coordinating row shows ⛔ + the reason instead of the plain progress count.
        "coordinatorBlocked": data.get("coordinatorBlocked"),
    }


@app.route("/api/tokenfold/stats")
def api_tokenfold_stats():
    # Thin same-origin proxy to the TokenFold proxy's own stats endpoint (launch.sh starts
    # TokenFold on TOKENFOLD_PORT, default 9339) -- the dashboard page can't fetch the
    # 9339 origin directly without CORS. "available": False (never an HTTP error) when the
    # proxy isn't running, so the tab can render a quiet "not running" state instead of
    # tripping the generic error path.
    import urllib.request

    port = os.environ.get("TOKENFOLD_PORT", "9339")
    try:
        with urllib.request.urlopen(
                f"http://localhost:{port}/tokenfold/stats", timeout=3) as r:
            data = json.loads(r.read().decode())
        return jsonify({"available": True, "port": port, "stats": data})
    except Exception:
        return jsonify({"available": False, "port": port})


@app.route("/api/promptforge/config")
def api_promptforge_config():
    # PromptForge is a separate local app (its own Flask server). The dashboard just
    # tells the browser where to point the embedded iframe -- PROMPTFORGE_URL, else the
    # convention :7430. No proxy: the iframe loads that origin directly.
    return jsonify({"url": os.environ.get("PROMPTFORGE_URL", "http://localhost:7430")})


@app.route("/api/adforge/config")
def api_adforge_config():
    # AdForge is a separate local app (its own Flask server), same as PromptForge above.
    # Just tells the browser where to point the embedded iframe -- ADFORGE_URL, else the
    # convention :7431. No proxy.
    return jsonify({"url": os.environ.get("ADFORGE_URL", "http://localhost:7431")})


@app.route("/api/scriptforge/config")
def api_scriptforge_config():
    # ScriptForge is a separate local app (phase 1 of the AdForge pipeline), same shape
    # as the two above -- SCRIPTFORGE_URL, else the convention :7432.
    return jsonify({"url": os.environ.get("SCRIPTFORGE_URL", "http://localhost:7432")})


def _hardware_history_averages(history: list) -> dict:
    """Current-vs-average is computed here rather than in hardware_stats.py -- that
    module only knows about individual samples, "average over the retention window" is
    a view concern for this endpoint's caller (the hardware graph), not something the
    collector itself needs. None (not 0) when a field has no samples yet, same
    fail-open convention as every field in hardware_stats.get_snapshot()."""

    def avg(get):
        values = [v for v in (get(entry) for entry in history) if v is not None]
        return sum(values) / len(values) if values else None

    return {
        "cpuPercent": avg(lambda e: e["cpuPercent"]),
        "cpuTemperatureCelsius": avg(lambda e: e["cpuTemperatureCelsius"]),
        "ramUsedBytes": avg(lambda e: e["ram"]["usedBytes"] if e["ram"] else None),
        "diskUsedBytes": avg(lambda e: e["disk"]["usedBytes"] if e["disk"] else None),
        "gpuUtilizationPercent": avg(lambda e: e["gpu"]["utilizationPercent"] if e["gpu"] else None),
        "gpuVramUsedMiB": avg(lambda e: e["gpu"]["vramUsedMiB"] if e["gpu"] else None),
        "gpuTemperatureCelsius": avg(lambda e: e["gpu"]["temperatureCelsius"] if e["gpu"] else None),
    }


@app.route("/api/hardware/stats")
def api_hardware_stats():
    # hardware_stats' own functions never raise (see that module's fail-open docstring --
    # every field independently degrades to None instead), so there's no try/except here:
    # a fresh dashboard with an empty/nonexistent hardware-stats.db and no GPU still
    # returns 200 with "history": [] and "gpu"/averages fields as None, never an error.
    snapshot = hardware_stats.get_snapshot()
    history = hardware_stats.get_history()
    return jsonify({
        "current": snapshot,
        "history": history,
        "averages": _hardware_history_averages(history),
    })


@app.route("/")
def index():
    return render_template("index.html")


def _expected_instance_ids() -> list[str]:
    """The daemons scripts/launch.sh always starts (worker-1, reviewer, queue-watchdog),
    plus worker-reasoning whenever it would actually be launched (gated on the same
    CLAUDE_CODE_OAUTH_TOKEN check launch.sh itself uses). apply-task-loop is deliberately
    excluded -- it's a single-shot pass with no heartbeat file of its own (see launch.sh's
    own comment), so it never has a slot to be "offline" in."""
    ids = ["worker-1", "reviewer", "watchdog"]
    if is_claude_token_configured():
        ids.append("worker-reasoning")
    return ids


@app.route("/api/instances")
def api_instances():
    results = []
    seen_ids = set()
    inst_dir = instances_dir()
    if inst_dir and inst_dir.is_dir():
        for f in sorted(inst_dir.glob("*.json")):
            data = read_json_safe(f)
            if not data or not data.get("instanceId") or not data.get("lastHeartbeat"):
                continue
            seen_ids.add(data["instanceId"])
            last_hb = parse_hb_timestamp(data["lastHeartbeat"])
            age = (datetime.now(timezone.utc) - last_hb).total_seconds() if last_hb else None
            threshold = WORKING_STALE_SECONDS if data.get("status") == "working" else OTHER_STALE_SECONDS
            # stateSince is written by Write-HeartbeatFile on every state transition
            # (status/pass/task change); age it server-side so the first paint is right
            # even before the client's 1s ticker takes over.
            state_age = None
            if data.get("stateSince"):
                since = parse_hb_timestamp(data["stateSince"])
                if since:
                    state_age = (datetime.now(timezone.utc) - since).total_seconds()
            results.append({
                **data,
                "heartbeatAgeSeconds": round(age) if age is not None else None,
                "stateAgeSeconds": round(state_age) if state_age is not None else None,
                "stale": age is not None and age > threshold,
                "staleThresholdSeconds": threshold,
            })
    # Fill in a placeholder "offline" card for every daemon launch.sh would normally start
    # but that has no (fresh-enough) heartbeat file on disk -- previously the Workers tab
    # went entirely blank ("No instances found -- is the pipeline running?") whenever the
    # pipeline was stopped from a clean state, instead of showing operators which workers
    # exist and that they're simply not running.
    if inst_dir is not None:
        for instance_id in _expected_instance_ids():
            if instance_id in seen_ids:
                continue
            results.append({
                "instanceId": instance_id,
                "status": "offline",
                "pid": None,
                "model": None,
                "currentTaskId": None,
                "currentPass": None,
                "lastHeartbeat": None,
                "heartbeatAgeSeconds": None,
                "stateAgeSeconds": None,
                "stale": False,
                "staleThresholdSeconds": None,
            })
    results.sort(key=lambda r: r.get("instanceId") or "")
    return jsonify(results)


@app.route("/api/models")
def api_models():
    """Aggregate per-model stats for the implement-pass A/B test (see model-stats-db.js).
    Outcome and performance are joined in one query -- a fast-but-always-rejected model
    must not look like a winner in a raw tok/s-only view.

    Also includes every locally-available-but-never-called Ollama model with zeroed/null
    stats (2026-08-24, Grimmethy: "I need all models available to show here even if we
    haven't run them yet") -- reuses _fetch_ollama_models(), the SAME real symbol
    /api/benchmark/models already calls, rather than a second model-listing mechanism.
    This table has no concept of a fixed Claude-model roster (Claude models aren't
    locally enumerable the way Ollama's /api/tags is), so only Ollama models get a
    zero-stats placeholder row here; a Claude model still only appears once it has a
    real model_calls row, same as before."""
    ollama_models = set(_fetch_ollama_models())
    db_path = model_stats_db_path()
    if not db_path or not db_path.is_file():
        return jsonify([_zero_stats_model_row(m) for m in sorted(ollama_models)])

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        has_cost = _has_cost_usd_column(conn)
        cost_select = "SUM(cost_usd) AS total_cost_usd," if has_cost else "NULL AS total_cost_usd,"
        rows = conn.execute(f"""
            SELECT model,
                   COUNT(*) AS call_count,
                   SUM(CASE WHEN outcome = 'approved' THEN 1 ELSE 0 END) AS approved,
                   SUM(CASE WHEN outcome IN ('rejected', 'blocked_apply') THEN 1 ELSE 0 END) AS rejected,
                   AVG(latency_ms) AS avg_latency_ms,
                   AVG(CASE WHEN eval_count IS NOT NULL AND eval_duration_ns > 0
                            THEN eval_count * 1.0 / (eval_duration_ns / 1e9) END) AS avg_tokens_per_sec,
                   MIN(CASE WHEN eval_count IS NOT NULL AND eval_duration_ns > 0
                            THEN eval_count * 1.0 / (eval_duration_ns / 1e9) END) AS min_tokens_per_sec,
                   MAX(CASE WHEN eval_count IS NOT NULL AND eval_duration_ns > 0
                            THEN eval_count * 1.0 / (eval_duration_ns / 1e9) END) AS max_tokens_per_sec,
                   SUM(CASE WHEN degenerate IS NOT NULL THEN 1 ELSE 0 END) AS degenerate_count,
                   SUM(CASE WHEN call_error IS NOT NULL THEN 1 ELSE 0 END) AS error_count,
                   {cost_select}
                   1 AS _dummy
            FROM model_calls
            WHERE stage = 'implement'
            GROUP BY model
            ORDER BY model
        """).fetchall()
    finally:
        conn.close()

    results = []
    for model, call_count, approved, rejected, avg_latency_ms, avg_tok_s, min_tok_s, max_tok_s, degenerate_count, error_count, total_cost_usd, _dummy in rows:
        decided = (approved or 0) + (rejected or 0)
        results.append({
            "model": model,
            "callCount": call_count,
            "approved": approved or 0,
            "rejected": rejected or 0,
            "approveRate": (approved / decided) if decided else None,
            "avgLatencyMs": avg_latency_ms,
            "avgTokensPerSec": avg_tok_s,
            "minTokensPerSec": min_tok_s,
            "maxTokensPerSec": max_tok_s,
            "degenerateCount": degenerate_count or 0,
            "errorCount": error_count or 0,
            "totalCostUsd": total_cost_usd,
        })

    seen = {r["model"] for r in results}
    for model in sorted(ollama_models - seen):
        results.append(_zero_stats_model_row(model))
    return jsonify(results)


def _zero_stats_model_row(model: str) -> dict:
    """A placeholder row for a model api_models() knows is available but has never been
    called -- same field shape as a real row, with every stat null/zero rather than the
    row being absent entirely."""
    return {
        "model": model, "callCount": 0, "approved": 0, "rejected": 0, "approveRate": None,
        "avgLatencyMs": None, "avgTokensPerSec": None, "minTokensPerSec": None,
        "maxTokensPerSec": None, "degenerateCount": 0, "errorCount": 0, "totalCostUsd": None,
    }


@app.route("/api/models/cost-summary")
def api_models_cost_summary():
    """Anthropic-API-equivalent cost estimate, aggregated across EVERY stage (not just
    'implement' -- a review-pass majority vote can be a real Claude call too). Same
    underlying data model-stats-db.js's own `cost-summary` CLI event exposes, queried
    directly here (read-only sqlite connection, same pattern every other endpoint in this
    file already uses against this db) rather than shelling out to Node for a page load.
    Grimmethy, 2026-08-23: "Do we have any way of knowing how much these tasks would cost
    using anthropic API?" -- claude-client.js's call() had always computed this
    (Claude Code CLI's own total_cost_usd, a client-side estimate against real Anthropic
    API pricing, independent of subscription billing); nothing ever stored or surfaced it
    until now."""
    db_path = model_stats_db_path()
    empty_hypothetical = {"totalCostUsd": 0, "totalCalls": 0, "byModel": [], "byDay": []}
    empty = {"totalCostUsd": 0, "callsWithCost": 0, "freeCalls": 0, "byModel": [], "byDay": [], "byInstance": [], "hypothetical": empty_hypothetical}
    if not db_path or not db_path.is_file():
        return jsonify(empty)

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if not _has_cost_usd_column(conn):
            total_calls = conn.execute("SELECT COUNT(*) FROM model_calls").fetchone()[0]
            return jsonify({**empty, "freeCalls": total_calls})

        total_row = conn.execute(
            "SELECT COALESCE(SUM(cost_usd), 0), COUNT(*) FROM model_calls WHERE cost_usd IS NOT NULL"
        ).fetchone()
        free_calls = conn.execute("SELECT COUNT(*) FROM model_calls WHERE cost_usd IS NULL").fetchone()[0]
        by_model = conn.execute("""
            SELECT model, COALESCE(SUM(cost_usd), 0) AS total_cost, COUNT(*) AS calls
            FROM model_calls WHERE cost_usd IS NOT NULL GROUP BY model ORDER BY total_cost DESC
        """).fetchall()
        by_day = conn.execute("""
            SELECT substr(started_at, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS total_cost, COUNT(*) AS calls
            FROM model_calls WHERE cost_usd IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 30
        """).fetchall()
        by_instance = []
        if _has_instance_id_column(conn):
            by_instance = conn.execute("""
                SELECT COALESCE(instance_id, '(unknown)') AS instance_id, COALESCE(SUM(cost_usd), 0) AS total_cost, COUNT(*) AS calls
                FROM model_calls WHERE cost_usd IS NOT NULL GROUP BY instance_id ORDER BY total_cost DESC
            """).fetchall()

        # Hypothetical: "what if EVERY call -- including the local ones -- had gone
        # through the Anthropic API" (2026-08-23, Grimmethy: "I'd like estimates for if
        # we had used the API. Even if we used the local models."). Covers every row
        # with a hypothetical_cost_usd value, always populated per model-stats-client.js's
        # own recordCall() (real cost for an actual Claude call, a token-based estimate
        # via anthropic-pricing.js otherwise).
        hypothetical = empty_hypothetical
        if _has_hypothetical_cost_column(conn):
            h_total_row = conn.execute(
                "SELECT COALESCE(SUM(hypothetical_cost_usd), 0), COUNT(*) FROM model_calls WHERE hypothetical_cost_usd IS NOT NULL"
            ).fetchone()
            h_by_model = conn.execute("""
                SELECT model, COALESCE(SUM(hypothetical_cost_usd), 0) AS total_cost, COUNT(*) AS calls
                FROM model_calls WHERE hypothetical_cost_usd IS NOT NULL GROUP BY model ORDER BY total_cost DESC
            """).fetchall()
            h_by_day = conn.execute("""
                SELECT substr(started_at, 1, 10) AS day, COALESCE(SUM(hypothetical_cost_usd), 0) AS total_cost, COUNT(*) AS calls
                FROM model_calls WHERE hypothetical_cost_usd IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 30
            """).fetchall()
            hypothetical = {
                "totalCostUsd": h_total_row[0],
                "totalCalls": h_total_row[1],
                "byModel": [{"model": m, "totalCost": c, "calls": n} for m, c, n in h_by_model],
                "byDay": [{"day": d, "totalCost": c, "calls": n} for d, c, n in h_by_day],
            }
    finally:
        conn.close()

    return jsonify({
        "totalCostUsd": total_row[0],
        "callsWithCost": total_row[1],
        "freeCalls": free_calls,
        "byModel": [{"model": m, "totalCost": c, "calls": n} for m, c, n in by_model],
        "byDay": [{"day": d, "totalCost": c, "calls": n} for d, c, n in by_day],
        "byInstance": [{"instanceId": i, "totalCost": c, "calls": n} for i, c, n in by_instance],
        "hypothetical": hypothetical,
    })


@app.route("/api/instances/<instance_id>/recent-tasks")
def api_instance_recent_tasks(instance_id):
    """Last 10 tasks a given instance actually completed (2026-08-23, Workers tab:
    "When I click on a worker to expand it's information I'd like to see a list of the
    last 10 tasks it completed."). model_calls is the only place that ties a task_id to
    the instance that drafted it (see model-stats-db.js's own instance_id migration) --
    'completed' here means outcome='approved' on that instance's own call for the task
    (review-task.js's recordModelOutcome stamps that onto the drafting instance's own
    call_id via task.abCallId), same shipped-vs-not distinction the rest of this file's
    cost tracking already relies on. GROUP BY task_id since a task can carry several calls
    (retries/revisions) from the same instance; ordered by whichever timestamp is freshest.

    reviewer (2026-08-24, Grimmethy: "add reviewer's reviewed tasks too") is a special
    case, not just the branch below with a different verdict word: review-task.js never
    calls recordCall for its own majorityVote() calls at all, only recordModelOutcome
    against the DRAFTER's own call_id -- so instance_id='reviewer' never matches a single
    row in this table, the drafting worker's instance_id does. This deployment only ever
    runs ONE reviewer instance (dead-process-check.js's restartTargetFor() has no
    "reviewer-N" concept, unlike worker-N), so outcome_stage='review' alone unambiguously
    means "the reviewer decided this" regardless of which worker drafted it -- no need to
    join against instance_id at all for this branch. Includes both verdicts (approved AND
    rejected both count as "reviewed"), unlike the draft branch below which only counts
    approved as "completed"."""
    db_path = model_stats_db_path()
    if not db_path or not db_path.is_file():
        return jsonify({"tasks": []})
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if not _has_instance_id_column(conn):
            return jsonify({"tasks": []})
        if instance_id == "reviewer":
            rows = conn.execute("""
                SELECT task_id, MAX(outcome_at) AS at, MAX(model) AS model, MAX(outcome) AS outcome
                FROM model_calls
                WHERE outcome_stage = 'review' AND outcome IS NOT NULL
                GROUP BY task_id
                ORDER BY at DESC
                LIMIT 10
            """).fetchall()
            return jsonify({"tasks": [{"taskId": t, "completedAt": at, "model": m, "outcome": o} for t, at, m, o in rows]})
        rows = conn.execute("""
            SELECT task_id, MAX(COALESCE(outcome_at, started_at)) AS at, MAX(model) AS model
            FROM model_calls
            WHERE instance_id = ? AND outcome = 'approved'
            GROUP BY task_id
            ORDER BY at DESC
            LIMIT 10
        """, (instance_id,)).fetchall()
    finally:
        conn.close()
    return jsonify({"tasks": [{"taskId": t, "completedAt": at, "model": m} for t, at, m in rows]})


@app.route("/api/models/usage")
def api_models_usage():
    """Per-model call volume across EVERY stage, not just 'implement' -- api_models()
    above is specifically about drafting-pass quality (approved/rejected against a real
    review verdict), which an interactive Discuss/Grill session has no equivalent of
    (there's no reviewer voting on a conversation). This is the simpler "how much did I
    actually use each model" view claude_client.py's/model_stats_client.py's Discuss-
    session recording feeds into, covering both providers on equal footing -- before
    those existed, only the Node pipeline's own implement-pass calls were tracked at
    all, so interactive sessions (on ANY model) were invisible here regardless."""
    db_path = model_stats_db_path()
    if not db_path or not db_path.is_file():
        return jsonify([])

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute("""
            SELECT model, stage,
                   COUNT(*) AS call_count,
                   AVG(latency_ms) AS avg_latency_ms,
                   MAX(started_at) AS last_used_at
            FROM model_calls
            GROUP BY model, stage
            ORDER BY model, stage
        """).fetchall()
    finally:
        conn.close()

    return jsonify([
        {"model": model, "stage": stage, "callCount": call_count,
         "avgLatencyMs": avg_latency_ms, "lastUsedAt": last_used_at}
        for model, stage, call_count, avg_latency_ms, last_used_at in rows
    ])


# Per-instance model override for the Workers tab's dropdown (Grimmethy, 2026-08-18: "I
# need to be able to manually select which model to use for each worker type"). Lives in
# dashboard-settings.json alongside claudeDefaultModel/claudeDefaultEffort -- same "takes
# effect without a pipeline restart" shape those already have, since agent-manager.env's
# LOCAL_MODEL/CLAUDE_MODEL only apply at daemon launch. local-worker.sh/review-runner.sh
# re-read this file once per tick (get_model_override in agent-manager-common.sh) so a
# change here reaches a running worker within one tick, no restart needed. watchdog has no
# entry -- it never calls a model at all (queue-watcher.sh always heartbeats model="").
@app.route("/api/worker-models")
def api_worker_models():
    overrides = read_dashboard_settings().get("workerModelOverrides", {})
    ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    ollama_models = []
    try:
        import urllib.request
        with urllib.request.urlopen(f"{ollama_url}/api/tags", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        ollama_models = sorted(m["name"] for m in data.get("models", []))
    except Exception:
        pass  # Ollama unreachable -- dropdown just shows the Claude lane / empty, not a 500.
    return jsonify({
        "overrides": overrides,
        "ollamaModels": ollama_models,
        "claudeModels": CLAUDE_MODEL_CHOICES,
        "claudePaused": read_dashboard_settings().get("claudePaused", False) is True,
    })


@app.route("/api/worker-models/<instance_id>", methods=["POST"])
def api_set_worker_model(instance_id):
    """model: "" or omitted clears the override, reverting that instance to its
    agent-manager.env default (LOCAL_MODEL or CLAUDE_MODEL) on its next tick."""
    body = request.get_json(silent=True) or {}
    model = (body.get("model") or "").strip()
    overrides = dict(read_dashboard_settings().get("workerModelOverrides", {}))
    if model:
        overrides[instance_id] = model
    else:
        overrides.pop(instance_id, None)
    write_dashboard_settings({"workerModelOverrides": overrides})
    return jsonify({"instanceId": instance_id, "model": model or None})


# Manual "pause Claude" kill switch (Grimmethy, 2026-08-25: "I need a way to pause the
# claude use... preserve the tokens since I know I'm very likely to hit my weekly
# limit"). Distinct from budget-monitor.js's own reactive rate-limit detection -- this is
# a deliberate, proactive stop a human can flip from the Workers tab before actually
# hitting the cap. Global (not per-instance): src/claude-pause.js's own header explains
# why -- adhoc's real Claude spend happens on whichever lane's task escalates there, not
# exclusively worker-reasoning, so a per-instance checkbox would leave a real spend path
# unprotected. Read via src/claude-pause.js (Node call sites) and
# agent-manager-common.sh's get_claude_paused (bash call sites) -- both read this exact
# same dashboard-settings.json field, no separate plumbing.
@app.route("/api/claude-pause", methods=["POST"])
def api_set_claude_paused():
    body = request.get_json(silent=True) or {}
    paused = body.get("paused") is True
    write_dashboard_settings({"claudePaused": paused})
    return jsonify({"claudePaused": paused})


# Model benchmark panel (Models tab, 2026-08-19, Grimmethy: "benchmarking needs to be a
# part of the models tab UI... exhaustive... each benchmark test response should be saved
# in second brain and accessible to the user in app, same as reading any other task").
# This whole feature is a thin Python wrapper around src/reasoning-bench.js -- ALL grading/
# metrics/persistence logic lives there (see that file's own header), Python only launches
# it as a detached background process (same subprocess.Popen(..., start_new_session=True)
# pattern _start_pipeline() already uses for the daemons themselves) and polls a progress
# file, since a real multi-model, multi-run benchmark can take many minutes -- far too long
# to run inside a single Flask request/response cycle.
BENCHMARK_STATE_DIR = PACKAGE_ROOT / ".agent-manager-cache" / "benchmarks"
BENCHMARK_CURRENT_POINTER = BENCHMARK_STATE_DIR / "current-run-id.txt"


def _fetch_ollama_models() -> list:
    ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    try:
        import urllib.request
        with urllib.request.urlopen(f"{ollama_url}/api/tags", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return sorted(m["name"] for m in data.get("models", []))
    except Exception:
        return []


def _benchmark_run_dir(run_id: str) -> Path:
    return BENCHMARK_STATE_DIR / run_id


def _second_brain_bench_dir(run_id: str | None = None) -> Path | None:
    sb = second_brain_dir()
    if not sb:
        return None
    return (sb / "Model Benchmarks" / run_id) if run_id else (sb / "Model Benchmarks")


def _safe_run_id(run_id: str) -> str:
    """Both the state dir and the SecondBrain dir key off this value as a literal path
    segment -- reject anything that isn't the shape reasoning-bench.js's own runId slugging
    produces, rather than trust a client-supplied path segment outright (path traversal via
    '../' in a run_id query param)."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", run_id or ""):
        abort(400, description="invalid run id")
    return run_id


def _case_result_score(result: dict) -> float | None:
    """One response's score as a 0.0-1.0 float, regardless of grader shape: an objective
    grader's boolean pass becomes 1.0/0.0, a judge grader's own 0.0-1.0 score is used
    directly. None (not 0.0) for an ungraded/ambiguous response -- excluded from the
    average entirely rather than silently counted as a 0, which would wrongly punish a
    model for a judge call that failed (e.g. hit a Claude rate limit) rather than for
    actually answering wrong."""
    grade = result.get("grade") or {}
    if grade.get("score") is not None:
        return float(grade["score"])
    if grade.get("pass") is True:
        return 1.0
    if grade.get("pass") is False:
        return 0.0
    return None


def _compute_case_stats() -> dict:
    """For each test case, the best- and worst-scoring model ACROSS EVERY SAVED RUN (not
    just the most recently viewed one) -- Grimmethy, 2026-08-19: "each test needs to show
    the current worst and best model scoring models in line on the main models page."
    Scans every _summary.json's raw `results` (not the already-per-run `summary`, which is
    grouped by category, not by individual case) and pools every response for a given
    (caseId, model) pair across all runs into one average score. Returns
    {caseId: {best: {model, score, sampleCount}, worst: {...}, modelCount}} -- a case with
    fewer than 2 distinct scored models has no meaningful "worst" (nothing to contrast
    against) and is simply omitted from the response for that case's key gaps."""
    bench_root = _second_brain_bench_dir()
    if not bench_root or not bench_root.is_dir():
        return {}

    # {caseId: {model: [scores...]}}
    scores_by_case_model: dict = {}
    for entry in bench_root.iterdir():
        summary_path = entry / "_summary.json"
        if not entry.is_dir() or not summary_path.is_file():
            continue
        data = read_json_safe(summary_path)
        if not data:
            continue
        for result in data.get("results", []):
            score = _case_result_score(result)
            if score is None:
                continue
            case_id = result.get("caseId")
            model = result.get("model")
            if not case_id or not model:
                continue
            scores_by_case_model.setdefault(case_id, {}).setdefault(model, []).append(score)

    stats = {}
    for case_id, by_model in scores_by_case_model.items():
        averages = [
            {"model": model, "score": sum(vals) / len(vals), "sampleCount": len(vals)}
            for model, vals in by_model.items()
        ]
        if len(averages) < 2:
            continue  # nothing to contrast a single tested model against
        averages.sort(key=lambda a: a["score"])
        stats[case_id] = {"worst": averages[0], "best": averages[-1], "modelCount": len(averages)}
    return stats


@app.route("/api/benchmark/cases")
def api_benchmark_cases():
    """Case bank metadata (id/category/grader) for the Models tab's test picker -- read
    live from reasoning-bench-cases.js via node rather than hand-duplicated here, so the
    two can never drift out of sync with each other. Each case is annotated with `stats`
    (best/worst scoring model pooled across every saved run, see _compute_case_stats) so
    the picker can show it inline without a separate round-trip."""
    script = (
        "const {CASES} = require(process.argv[1]);"
        "console.log(JSON.stringify(CASES.map(c => ({id: c.id, category: c.category, grader: c.grader, prompt: c.prompt, description: c.description}))));"
    )
    try:
        result = subprocess.run(
            ["node", "-e", script, str(SRC_DIR / "reasoning-bench-cases.js")],
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        logger.warning("reasoning-bench-cases node script timed out after 15s")
        return jsonify([])
    if result.returncode != 0:
        logger.warning("reasoning-bench-cases node script exited with code %d: %s", result.returncode, result.stderr[:500])
        return jsonify([])
    try:
        cases = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        logger.warning("case-list: subprocess output was not valid JSON (%s); returning empty list. Raw output (first 500 chars): %r", exc, result.stdout[:500])
        return jsonify([])

    stats = _compute_case_stats()
    for c in cases:
        c["stats"] = stats.get(c["id"])
    return jsonify(cases)


@app.route("/api/benchmark/models")
def api_benchmark_models():
    return jsonify({"ollamaModels": _fetch_ollama_models()})


@app.route("/api/benchmark/run", methods=["POST"])
def api_benchmark_run():
    body = request.get_json(silent=True) or {}
    models = [m.strip() for m in (body.get("models") or []) if m.strip()]
    case_ids = [c.strip() for c in (body.get("caseIds") or []) if c.strip()]
    runs = max(1, min(20, int(body.get("runs") or 1)))
    include_judge = bool(body.get("includeJudge"))
    if not models:
        abort(400, description="at least one model is required")
    if not case_ids:
        abort(400, description="at least one test case is required")

    # One benchmark run at a time -- a second concurrent run would double-claim the same
    # Ollama model slot this box can only hold one of anyway (see model-inflight-lock.js's
    # own header for why), and would silently interleave two runs' progress into the same
    # "current" pointer.
    BENCHMARK_STATE_DIR.mkdir(parents=True, exist_ok=True)
    if BENCHMARK_CURRENT_POINTER.is_file():
        current_id = BENCHMARK_CURRENT_POINTER.read_text(encoding="utf-8").strip()
        progress_path = _benchmark_run_dir(current_id) / "progress.json"
        if progress_path.is_file():
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
            if progress.get("status") == "running":
                abort(409, description=f"a benchmark run ('{current_id}') is already in progress")

    run_id = f"run-{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')}-{os.getpid() % 10000}"
    run_dir = _benchmark_run_dir(run_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    BENCHMARK_CURRENT_POINTER.write_text(run_id, encoding="utf-8")

    env_overrides = read_env_file(ENV_FILE_PATH)
    child_env = {**os.environ, **env_overrides}

    args = [
        "node", str(SRC_DIR / "reasoning-bench.js"),
        "--models", ",".join(models),
        "--cases", ",".join(case_ids),
        "--runs", str(runs),
        "--run-id", run_id,
        "--progress-out", str(run_dir / "progress.json"),
    ]
    sb_dir = second_brain_dir()
    if sb_dir:
        args += ["--second-brain-dir", str(sb_dir)]
    if not include_judge:
        args.append("--no-judge")

    log_path = run_dir / "run.log"
    subprocess.Popen(
        args,
        env=child_env,
        cwd=str(PACKAGE_ROOT),
        stdout=log_path.open("w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return jsonify({"runId": run_id, "started": True, "models": models, "caseIds": case_ids, "runs": runs, "includeJudge": include_judge, "savedToSecondBrain": sb_dir is not None})


@app.route("/api/benchmark/status")
def api_benchmark_status():
    """?runId=... for a specific run, else whichever run is/was most recently started."""
    run_id = request.args.get("runId")
    if not run_id:
        if not BENCHMARK_CURRENT_POINTER.is_file():
            return jsonify({"status": "idle"})
        run_id = BENCHMARK_CURRENT_POINTER.read_text(encoding="utf-8").strip()
    else:
        run_id = _safe_run_id(run_id)
    progress_path = _benchmark_run_dir(run_id) / "progress.json"
    if not progress_path.is_file():
        return jsonify({"status": "idle"})
    try:
        return jsonify(json.loads(progress_path.read_text(encoding="utf-8")))
    except json.JSONDecodeError:
        logger.warning(
            "Progress file %s is not valid JSON; reporting status as idle",
            progress_path,
            exc_info=True,
        )
        return jsonify({"status": "idle"})


@app.route("/api/benchmark/runs")
def api_benchmark_runs():
    """Past runs with a saved _summary.json, newest first -- the source of truth for
    history is SECOND_BRAIN_DIR (reasoning-bench.js's real, durable output), not
    BENCHMARK_STATE_DIR (which only ever holds transient progress/log files and is safe to
    clear at any time). Empty if SECOND_BRAIN_DIR isn't configured -- same "nothing to show,
    not an error" shape every other SECOND_BRAIN_DIR-gated endpoint in this file uses."""
    bench_root = _second_brain_bench_dir()
    if not bench_root or not bench_root.is_dir():
        return jsonify([])
    runs = []
    for entry in bench_root.iterdir():
        summary_path = entry / "_summary.json"
        if not entry.is_dir() or not summary_path.is_file():
            continue
        data = read_json_safe(summary_path)
        if not data:
            continue
        runs.append({
            "runId": data.get("runId", entry.name),
            "generatedAt": data.get("generatedAt"),
            "models": data.get("models", []),
            "caseIds": data.get("caseIds", []),
            "runs": data.get("runs", 1),
        })
    runs.sort(key=lambda r: r.get("generatedAt") or "", reverse=True)
    return jsonify(runs)


@app.route("/api/benchmark/runs/<run_id>")
def api_benchmark_run_detail(run_id):
    run_id = _safe_run_id(run_id)
    bench_dir = _second_brain_bench_dir(run_id)
    if not bench_dir:
        abort(404, description="SECOND_BRAIN_DIR is not configured")
    data = read_json_safe(bench_dir / "_summary.json")
    if not data:
        abort(404)
    return jsonify(data)


@app.route("/api/benchmark/response/<run_id>/<response_id>")
def api_benchmark_response(run_id, response_id):
    """Serves one saved response as a task-shaped JSON -- the SAME shape
    /api/task/<state>/<task_id> returns for a real pipeline task, so the frontend's
    existing renderTaskDetailModal() renders it with zero new viewer code (see
    reasoning-bench.js's writeResponseArtifact() for the field-name contract)."""
    run_id = _safe_run_id(run_id)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", response_id or ""):
        abort(400, description="invalid response id")
    bench_dir = _second_brain_bench_dir(run_id)
    if not bench_dir:
        abort(404, description="SECOND_BRAIN_DIR is not configured")
    data = read_json_safe(bench_dir / f"{response_id}.json")
    if not data:
        abort(404)
    return jsonify(data)


_REPORT_PERIODS = ("hourly", "daily", "weekly")


def _reports_root() -> Path | None:
    """Where system-report.js (src/system-report.js) writes its scheduled Markdown
    reports -- SECOND_BRAIN_DIR/Agent Manager Reports/<period>/<filename>.md, same
    'SECOND_BRAIN_DIR is the durable store, dashboard just reads it' shape as the
    benchmark endpoints above."""
    sb = second_brain_dir()
    return (sb / "Agent Manager Reports") if sb else None


def _safe_report_period(period: str) -> str:
    if period not in _REPORT_PERIODS:
        abort(400, description="invalid report period")
    return period


def _safe_report_filename(filename: str) -> str:
    """Reports are only ever named by system-report.js's own reportFilename() (a
    YYYY-MM-DD / YYYY-MM-DDThh style stem plus '.md') -- reject anything else rather than
    trust a client-supplied path segment (path traversal via '../' in the URL)."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.md", filename or ""):
        abort(400, description="invalid report filename")
    return filename


@app.route("/api/reports")
def api_reports():
    """Every generated report across all three periods, newest first -- the Time Tracking
    tab's list view. Empty (not an error) if SECOND_BRAIN_DIR isn't configured or no
    report has been generated yet, same shape every other SECOND_BRAIN_DIR-gated endpoint
    here uses."""
    root = _reports_root()
    if not root or not root.is_dir():
        return jsonify([])
    reports = []
    for period in _REPORT_PERIODS:
        period_dir = root / period
        if not period_dir.is_dir():
            continue
        for entry in period_dir.iterdir():
            if not entry.is_file() or entry.suffix != ".md":
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            reports.append({
                "period": period,
                "filename": entry.name,
                "generatedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            })
    reports.sort(key=lambda r: r["generatedAt"], reverse=True)
    return jsonify(reports)


@app.route("/api/reports/<period>/<filename>")
def api_report_detail(period, filename):
    period = _safe_report_period(period)
    filename = _safe_report_filename(filename)
    root = _reports_root()
    if not root:
        abort(404, description="SECOND_BRAIN_DIR is not configured")
    path = root / period / filename
    if not path.is_file():
        abort(404)
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        abort(404)
    return jsonify({"period": period, "filename": filename, "content": content})


@app.route("/api/queue/<state>")
def api_queue_state(state):
    """Returns {items: [...], total: N}. Incremental loading (2026-07-26, Grimmethy:
    "long task lists take a while to load"): optional ?limit=N&offset=M page the result --
    file METADATA is sorted first (cheap, no content read) and only the requested slice
    ever gets read_json_safe'd, so a 200+-item done/ folder no longer means reading and
    JSON-parsing every single file on every 5s poll, just the page actually being shown."""
    qdir = queue_dir()
    if not qdir:
        return jsonify({"items": [], "total": 0})

    if state == "drafting":
        # Never paginated -- an in-flight claim count is always small (bounded by worker
        # count), nothing like done/'s unbounded historical backlog.
        entries = []
        drafting_root = qdir / "drafting"
        if drafting_root.is_dir():
            for sub in drafting_root.iterdir():
                if not sub.is_dir():
                    continue
                for f in sub.glob("*.json"):
                    data = read_json_safe(f)
                    if data:
                        s = task_summary(data, f.stem)
                        s["claimedBy"] = sub.name
                        entries.append(s)
            for f in drafting_root.glob("*.json"):  # legacy: no subfolder
                data = read_json_safe(f)
                if data:
                    entries.append(task_summary(data, f.stem))
        return jsonify({"items": entries, "total": len(entries)})

    if state not in QUEUE_STATES:
        abort(404)

    limit = request.args.get("limit", type=int)
    offset = request.args.get("offset", default=0, type=int)
    source_filter = (request.args.get("source") or "").strip()

    entries = []
    total = 0
    state_dir = qdir / state
    if state_dir.is_dir():
        files = sorted(state_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if source_filter:
            # Filtering by task type (Job Status > Done tab, 2026-08-17: "Done is getting
            # huge, need to filter by task type") needs each file's own `source` field --
            # unlike sorting, that's not derivable from the filename/mtime alone, so this
            # reads every file in the state dir instead of just the requested page. Only
            # pays that cost when a filter is actually selected; the default unfiltered
            # request below keeps the cheap stat-only-sort-then-page-only-read behavior.
            filtered = []
            for f in files:
                data = read_json_safe(f)
                if data and data.get("source") == source_filter:
                    filtered.append((f, data))
            total = len(filtered)
            page = filtered[offset:offset + limit] if limit is not None else filtered[offset:]
            entries = [task_summary(data, f.stem) for f, data in page]
        else:
            total = len(files)
            page = files[offset:offset + limit] if limit is not None else files[offset:]
            for f in page:
                data = read_json_safe(f)
                if data:
                    entries.append(task_summary(data, f.stem))
    return jsonify({"items": entries, "total": total})


def _task_cost_summary(task_id: str) -> dict | None:
    """Estimated Anthropic API cost for ONE task, summed across every model_calls row
    for it -- a task can carry several real calls (plan, implement, critique, revision,
    or an agentic pass's own single call), and task.abCallId on the task JSON itself only
    ever holds the MOST RECENT one, so this queries by task_id directly rather than
    relying on that field. Returns None (not a zeroed dict) when the db/column isn't
    available yet, so the frontend can distinguish "no cost data at all" from "$0, no
    Claude calls for this task" -- the same distinction api_models_cost_summary's own
    freeCalls count already makes at the aggregate level.
    Grimmethy, 2026-08-23: "We should include estimated cost tracking in the job page
    itself." """
    db_path = model_stats_db_path()
    if not db_path or not db_path.is_file():
        return None
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if not _has_cost_usd_column(conn):
            return None
        row = conn.execute(
            "SELECT COALESCE(SUM(cost_usd), 0), COUNT(*), SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END), "
            "COALESCE(SUM(latency_ms), 0) "
            "FROM model_calls WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        # Hypothetical: what this SAME task would have cost if every one of its calls --
        # including any that ran locally -- had gone through the API (2026-08-23,
        # Grimmethy: "I'd like estimates for if we had used the API. Even if we used the
        # local models."). None when the column isn't migrated in yet, same "no data" vs.
        # "real $0" distinction the rest of this function already makes.
        hypothetical_cost_usd = None
        if _has_hypothetical_cost_column(conn):
            h_row = conn.execute(
                "SELECT COALESCE(SUM(hypothetical_cost_usd), 0) FROM model_calls WHERE task_id = ? AND hypothetical_cost_usd IS NOT NULL",
                (task_id,),
            ).fetchone()
            hypothetical_cost_usd = h_row[0]
    finally:
        conn.close()
    total_cost, total_calls, calls_with_cost, total_latency_ms = row
    if total_calls == 0:
        return None
    return {
        "totalCostUsd": total_cost, "totalCalls": total_calls, "callsWithCost": calls_with_cost or 0,
        "hypotheticalCostUsd": hypothetical_cost_usd,
        # Real wall-clock time spent across every model call this task made (plan,
        # implement, critique, revision, ...) -- latency_ms is recorded for local Ollama
        # calls the same as Claude ones (see model-stats-db.js), so this covers both,
        # unlike totalCostUsd which is $0 (not "no data") for an all-local task.
        "totalLatencyMs": total_latency_ms,
    }


# Task metadata (2026-08-26, Grimmethy: "At the top of every task I'd like to see a bit
# of meta data... a list of all the files it touched") -- a task's actual on-disk change
# is expressed in one of two shapes depending on which applier handles it (see
# apply-task.js's own dispatch): Group A/adhoc tasks carry a real unified diff in
# task.rawDiff (`diff --git a/X b/Y` headers); Group B tasks carry a JSON change object
# (or array of them) with a `file` field per change in task.implementResponse, same
# format apply-group-b.js itself parses. A task that never touches the filesystem at all
# (a verdict-only observability/performance audit, an arch_discovery/arch_review "split"
# proposal) legitimately has neither -- returns [] for those, not an error.
#
# Mirrors src/json-fence.js's fenced/balanced-JSON recovery (already proven live against
# real local-model drafts that wrap JSON in a code fence, or add prose before/after it)
# in Python rather than shelling out to node per task view -- keep the two in sync if
# either's recovery logic changes.
_DIFF_GIT_HEADER_RE = re.compile(r'^diff --git a/(.+?) b/(.+?)$', re.MULTILINE)
_FENCED_JSON_RE = re.compile(r'```(?:json)?\s*([\s\S]*?)```')


def _extract_balanced_json(text: str) -> str | None:
    m = re.search(r'[\[{]', text)
    if not m:
        return None
    start = m.start()
    open_ch = text[start]
    close_ch = '}' if open_ch == '{' else ']'
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == '\\':
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _parse_json_maybe_fenced(text: str | None):
    if not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    m = _FENCED_JSON_RE.search(text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    extracted = _extract_balanced_json(text)
    if extracted:
        try:
            return json.loads(extracted)
        except json.JSONDecodeError:
            pass
    return None


def _work_log_for(task_id: str) -> dict | None:
    """The per-task tool-call transcript (src/work-log.js writes queue/worklogs/<id>.json)
    for a multi-turn agentic draft -- every file read, search run, command executed, and
    edit made, so the result can be audited before it's approved/merged. None when there
    is no worklog (non-agentic task, or already pruned after the task reached done/).
    draftAttempts on the task itself only keeps a stripped summary (tool + arg keys); this
    is the full detail, lazily loaded only when a task is opened."""
    qdir = queue_dir()
    if not qdir:
        return None
    p = qdir / "worklogs" / f"{task_id}.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _files_touched_for(task: dict) -> list[str]:
    raw_diff = task.get("rawDiff")
    if raw_diff:
        seen: set[str] = set()
        out: list[str] = []
        for a, b in _DIFF_GIT_HEADER_RE.findall(raw_diff):
            # `b` is /dev/null for a deletion (the new side doesn't exist) -- fall back to
            # `a` so a deleted file still shows up in the list instead of as "dev/null".
            f = b if b and b != "/dev/null" else a
            if f and f not in seen:
                seen.add(f)
                out.append(f)
        return out

    parsed = _parse_json_maybe_fenced(task.get("implementResponse"))
    if parsed is None:
        return []
    items = parsed if isinstance(parsed, list) else [parsed]
    seen = set()
    out = []
    for item in items:
        f = item.get("file") if isinstance(item, dict) else None
        if f and f not in seen:
            seen.add(f)
            out.append(f)
    return out


# The promptContext keys that carry a task's actual INPUT -- what the drafting model was
# asked to act on. Different sources stash it under different names, and only `rawText`
# was ever surfaced in the task-detail modal, so e.g. product_spec's whole request brief
# (promptContext.requestText, ~2KB) rendered nowhere and a blocked product_spec task gave
# "no indication of what actually happened" (2026-08-30). (label, candidate keys) -- first
# non-empty key per label wins; several labels can show at once (a scanner finding's
# `detail` + its `snippet`, say).
_TASK_INPUT_FIELDS = [
    ("Request", ("requestText", "rawText", "taskText", "reason")),
    ("Finding", ("detail",)),
    ("Code snippet", ("snippet",)),
    ("Candidate", ("body",)),
    ("Open questions", ("openQuestions",)),
]


def _task_input_summary(task: dict) -> list[dict]:
    pc = task.get("promptContext") or {}
    title = (task.get("title") or "").strip()
    out: list[dict] = []
    for label, keys in _TASK_INPUT_FIELDS:
        for k in keys:
            v = pc.get(k)
            if isinstance(v, str) and v.strip() and v.strip() != title:
                out.append({"label": label, "text": v})
                break
    if task.get("source") == "product_spec":
        rel = pc.get("specRelPath")
        if rel:
            note = "updating the existing spec" if pc.get("specExists") else "new file"
            out.append({"label": "Output", "text": f"{rel} ({note})"})
    elif task.get("source") == "product_spec_outline":
        out.append({"label": "Output", "text": "PRODUCT_SPEC_OUTLINE.md (AC-NNN section candidates) + a marker skeleton for the spec doc"})
    elif task.get("source") == "product_spec_section":
        rel = pc.get("specRelPath")
        if rel:
            out.append({"label": "Output", "text": f"{rel} (fills one section's placeholder block)"})
    elif task.get("source") == "pipeline_forensics":
        # Forensics promptContext keys (subjectKind/subjectKey/signature/triggerType) don't
        # match _TASK_INPUT_FIELDS, so without this the modal has no "what did this study
        # examine" line at all -- the reader lands in the report with no framing.
        kind = pc.get("subjectKind")
        key = pc.get("subjectKey") or pc.get("signature")
        trigger = pc.get("triggerType")
        if key:
            if kind and kind != "signature":
                text = f"{kind} {key}"
            else:
                text = f'signature "{key}"'
            if trigger:
                text += f" (trigger: {trigger})"
            out.append({"label": "Study", "text": text})
    return out


@app.route("/api/task/<state>/<task_id>")
def api_task_detail(state, task_id):
    qdir = queue_dir()
    if not qdir:
        abort(404)

    if state == "drafting":
        drafting_root = qdir / "drafting"
        if drafting_root.is_dir():
            for candidate in drafting_root.rglob(f"{task_id}.json"):
                data = read_json_safe(candidate)
                if data:
                    return jsonify({**data, "_costSummary": _task_cost_summary(task_id), "_filesTouched": _files_touched_for(data), "_requestInput": _task_input_summary(data), "_workLog": _work_log_for(task_id)})
        abort(404)

    if state not in QUEUE_STATES:
        abort(404)
    f = qdir / state / f"{task_id}.json"
    data = read_json_safe(f)
    if not data:
        abort(404)
    return jsonify({**data, "_costSummary": _task_cost_summary(task_id), "_filesTouched": _files_touched_for(data), "_requestInput": _task_input_summary(data), "_workLog": _work_log_for(task_id)})


@app.route("/api/task/<state>/<task_id>/archive", methods=["POST"])
def api_task_archive(state, task_id):
    """Manual archive (Job Status > Blocked/Done tabs, per-row button): moves the task file
    to queue/done/_archived_no_action/ -- not a new convention, the exact folder already
    used for every manual archive done by hand earlier in this project's history.
    Load-bearing detail: src/task-sources.js's taskIdExistsInQueue() only ever checks the
    direct queue/<state>/<id>.json path, never nested subfolders, so moving a file here
    silently frees up its underlying item (a brain-dump entry, an arch_import itemId, a
    deep_dive community) for reconsideration next time its source generator runs -- with
    zero source-specific logic needed on this end. 'needs-clarification' included since
    2026-08-16 -- "reject the dump" (Discuss session on context-aware-file-path-prefetch-
    job.md) is exactly this action for a held task the user decides isn't worth chasing
    down an anchor for. 'awaiting-confirm' included the same day, same reasoning -- DENYING
    a delete-containing batch (the awaiting-confirm gate's own opposite of /confirm below)
    is exactly this action too: give up on it rather than let it apply."""
    if state not in ("blocked", "done", "needs-clarification", "awaiting-confirm"):
        abort(400, description="only a blocked, done, needs-clarification, or awaiting-confirm task can be archived")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / state / f"{task_id}.json"
    if not src.is_file():
        abort(404)

    dest_dir = qdir / "done" / "_archived_no_action"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"an archived copy of '{task_id}' already exists")
    shutil.move(str(src), str(dest))
    return jsonify({"id": task_id, "archived": True})


@app.route("/api/task/<state>/<task_id>/staleness-keep", methods=["POST"])
def api_task_staleness_keep(state, task_id):
    """Dismiss a stalenessFlag (adhoc-staleness-flag.js): the human looked and decided the
    task is still valid. Clears the flag and writes a `stalenessKeep` cooldown so the sweep
    does not re-flag it for AGENT_MANAGER_STALENESS_COOLDOWN_DAYS (default 21). The task
    stays exactly where it is -- this only affects the flag."""
    if state not in ("blocked", "needs-clarification"):
        abort(400, description="staleness flags only exist on blocked / needs-clarification tasks")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / state / f"{task_id}.json"
    if not src.is_file():
        abort(404)
    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        abort(500, description="could not read the task file")
    data.pop("stalenessFlag", None)
    cooldown_days = int(os.environ.get("AGENT_MANAGER_STALENESS_COOLDOWN_DAYS") or 21)
    until = datetime.now(timezone.utc) + timedelta(days=cooldown_days)
    data["stalenessKeep"] = {"until": until.isoformat(), "by": "human", "at": datetime.now(timezone.utc).isoformat()}
    data.setdefault("history", []).append({
        "stage": "advisory", "at": datetime.now(timezone.utc).isoformat(),
        "detail": f"staleness flag dismissed by a human -- keep until {until.date().isoformat()}",
    })
    src.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return jsonify({"id": task_id, "kept": True, "until": until.isoformat()})


@app.route("/api/task/awaiting-confirm/<task_id>/confirm", methods=["POST"])
def api_task_confirm_delete(task_id):
    """Confirms a delete-containing Group B batch (src/apply-task.js's remaining
    awaiting-confirm gate), moving it from queue/awaiting-confirm/ back into
    queue/approved/ so the next apply-task.sh pass re-runs it for real. Denying instead
    of confirming is just the existing generic archive action above (state='awaiting-
    confirm') -- no separate deny endpoint needed.

    REMOVED 2026-08-22 (Grimmethy: "I'd like to skip the confirm step. We already have a
    manual step for merge to main. This extra step is unnecessary friction."): this
    endpoint used to also stamp adhocApplyConfirmedAt/researchApplyConfirmedAt/
    pipelineSelfFixConfirmedAt/productSpecConfirmedAt, the confirm gates for adhoc/
    research_task/pipeline_self_audit/product_spec real-diff tasks -- apply-task.js no
    longer holds any of those, so none of them should reach queue/awaiting-confirm/ in
    the first place going forward. Left this endpoint's own behavior otherwise unchanged
    (still moves whatever's actually sitting in awaiting-confirm/ back to approved/) so
    it stays correct for the delete-mode gate, and harmless for any already-queued task
    that still happens to carry one of the old fields."""
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / "awaiting-confirm" / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    now_iso = datetime.now(timezone.utc).isoformat()
    data["deleteConfirmedAt"] = now_iso
    # pipeline_forensics (2026-09-01): its apply's first pass held the ranked root-cause
    # report here for a human read. Confirming it stamps forensicsReportConfirmedAt so the
    # re-run's second pass files the RECOMMENDED FOLLOW-UP FIX as a pipeline-fix candidate
    # (see applyForensicsReport in src/apply-group-a.js).
    if data.get("source") == "pipeline_forensics":
        data["forensicsReportConfirmedAt"] = now_iso

    approved_dir = qdir / "approved"
    approved_dir.mkdir(parents=True, exist_ok=True)
    dest = approved_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in approved/")
    dest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    src.unlink()
    return jsonify({"id": task_id, "confirmed": True})


# Repeated-blocker guard (2026-08-24, pipeline hardening, Grimmethy: "no 'repeated
# identical blocker' escalation"). Root-caused live: two real tasks each survived a full
# bulk-requeue pass ("get to 0 blocked", 2026-08-23) and immediately failed the exact
# same way again -- a blind requeue changes nothing about the task or its environment,
# so a genuinely structural failure just replays. blockedReason text is a much more
# reliable similarity signal than a task's title (concrete symbols/requirements repeat
# near-verbatim across attempts at the same root cause, e.g. "CLAUDE_MODEL_CHOICES"
# literally recurred across 3 of 6 real rejections for one task this session), so this
# compares the CURRENT blockedReason against every entry already accumulated in
# priorRejectionFeedback (reject-retry-check.js's automatic retries already append every
# rejection reason there) rather than trying to fingerprint task identity at all.
_STOPWORDS = {
    "a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with", "is", "are",
    "this", "that", "it", "be", "as", "at", "by", "from", "into", "not", "but", "its",
    "was", "were", "has", "have", "had", "do", "does", "did",
}


def _significant_words(text):
    return {w for w in re.findall(r"[a-z0-9_]+", (text or "").lower()) if len(w) > 2 and w not in _STOPWORDS}


def _jaccard(a, b):
    if not a or not b:
        return 0.0
    intersection = len(a & b)
    union = len(a | b)
    return (intersection / union) if union else 0.0


_QUOTED_SYMBOL_RE = re.compile(r"`([^`]{3,60})`")
_REPEATED_BLOCKER_THRESHOLD = 0.3


def _quoted_symbols(text):
    """Backtick-quoted spans (a code identifier, file path, or function name) -- review-
    task.js's own blockedReason prose consistently cites the specific symbol it's
    objecting to this way (confirmed against real data: `CLAUDE_MODEL_CHOICES` literally
    recurred, backtick-quoted, across 3 of 6 real rejections for one task this session).
    Far more precise than generic word overlap for THIS specific failure mode -- two
    fresh pieces of critique prose about the same missing symbol often share almost no
    other vocabulary at all."""
    return {m.strip() for m in _QUOTED_SYMBOL_RE.findall(text or "") if m.strip()}


def _repeated_blocker_match(task):
    """Returns the most similar prior rejection reason if the CURRENT blockedReason looks
    like the same underlying problem recurring, else None. Deliberately best-effort and
    approximate -- a missed match just means no warning shown (same as before this
    existed); a false-positive match costs one extra confirm click (force=true), never
    blocks a requeue outright."""
    current_reason = task.get("blockedReason") or ""
    if not current_reason:
        return None
    current_symbols = _quoted_symbols(current_reason)
    current_words = _significant_words(current_reason)
    best = None
    for prior in (task.get("priorRejectionFeedback") or []):
        prior = prior or ""
        # Primary, high-precision signal: the exact same quoted symbol named as the
        # problem in both this rejection and an earlier one -- a match here is decisive,
        # no need to also clear the (weaker) word-overlap bar below.
        if current_symbols & _quoted_symbols(prior):
            return prior
        # Fallback for rejections that don't happen to quote a symbol (e.g. "fails to
        # search ClinicalTrials.gov for a registration number") -- generic word overlap,
        # a weaker signal on its own so held to a slightly lower bar than the primary one.
        score = _jaccard(current_words, _significant_words(prior))
        if score >= _REPEATED_BLOCKER_THRESHOLD and (best is None or score > best[1]):
            best = (prior, score)
    return best[0] if best else None


@app.route("/api/task/<state>/<task_id>/requeue", methods=["POST"])
def api_task_requeue(state, task_id):
    """Manual requeue (Job Status > Blocked/Done tabs, per-row button; also the Brain Dump
    tab's "Reopen" action on an archived entry's badge): moves the task back to pending/,
    stripped to the same shape a freshly-generated task has -- every drafting/review/apply
    artifact (blockedReason, doneMarker, ornithVotes, planResponse, implementResponse, etc.)
    is dropped, not carried forward. ornithRejectCount resets to 0 deliberately: a manual
    requeue is a deliberate human do-over, not a continuation of the same automatic retry
    cycle queue-watchdog.ps1's Invoke-RejectRetryCheck already runs for review-stage
    rejections (capped at $MaxOrnithRejectRetries=2) -- carrying the old count forward would
    let a manually-requeued task block again after fewer real attempts than a task hitting
    that cap for the first time gets.

    'archived' is a distinct pseudo-state (not a real QUEUE_STATES member) for a task
    api_task_archive moved to done/_archived_no_action/ -- _task_state_index reports it as
    'archived', not 'done', so this must be handled as a separate lookup path rather than
    falling through to state_dir/task_id.json, which would 404 (real gap found 2026-08-17
    auditing the "always reversible" promise: an archived item couldn't actually be
    un-archived through the UI before this). 2026-08-24: also checks done-archive.js's own
    dated month buckets (queue/done/_archived/<YYYY-MM>/) -- a task the AUTOMATIC daily
    archive pass moved there is just as "archived" and must be just as requeueable as one a
    human moved to _archived_no_action/ by hand; see done-archive.js's own header on the
    same "always reversible" promise this endpoint already exists to uphold."""
    if state not in ("blocked", "done", "archived"):
        abort(400, description="only a blocked, done, or archived task can be requeued")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    if state == "archived":
        src = qdir / "done" / "_archived_no_action" / f"{task_id}.json"
        if not src.is_file():
            archived_root = qdir / "done" / "_archived"
            if archived_root.is_dir():
                for month_dir in archived_root.iterdir():
                    if not month_dir.is_dir():
                        continue
                    candidate = month_dir / f"{task_id}.json"
                    if candidate.is_file():
                        src = candidate
                        break
    else:
        src = qdir / state / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    if state == "blocked" and not (request.get_json(silent=True) or {}).get("force"):
        repeat = _repeated_blocker_match(data)
        if repeat:
            abort(409, description=(
                "This task's rejection looks like the same underlying problem as an "
                f"earlier attempt: \"{repeat[:220]}\" -- redrafting alone hasn't fixed "
                "this before and likely won't now without a real change. Diagnose the "
                "actual root cause first (or confirm you already have), then requeue "
                "again to proceed anyway."
            ))

    pending_dir = qdir / "pending"
    pending_dir.mkdir(parents=True, exist_ok=True)
    dest = pending_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in pending/")

    now_iso = datetime.now(timezone.utc).isoformat()
    fresh = {
        "id": data.get("id", task_id),
        "domain": data.get("domain"),
        "source": data.get("source"),
        "title": data.get("title"),
        "promptContext": data.get("promptContext"),
        "status": "pending",
        "createdAt": now_iso,
        "history": [{"status": "pending", "at": now_iso, "note": f"manually requeued from {state}/"}],
    }
    dest.write_text(json.dumps(fresh, indent=2), encoding="utf-8")
    src.unlink()
    return jsonify({"id": task_id, "requeued": True})


@app.route("/api/task/needs-clarification/<task_id>/resolve", methods=["POST"])
def api_task_resolve_clarification(task_id):
    """Moves a held task from queue/needs-clarification/ into queue/adhoc/ (NOT
    queue/pending/ -- unlike requeue above, this is an adhoc-domain task, and
    nextAdhocTask() only ever scans queue/adhoc/; landing it in pending/ the way requeue
    does would silently orphan it) so local-worker.sh can finally claim and draft it.
    Body: {"paths": [...]}  -- the file path(s) the user picked (from the 'ambiguous'
    candidates, or hand-typed for a 'no-match' case) become promptContext.prefetchedPaths;
    an empty/omitted paths list means "proceed with no prefetch at all," a deliberate
    choice, not an error."""
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / "needs-clarification" / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    body = request.get_json(silent=True) or {}
    paths = body.get("paths")
    if paths and isinstance(paths, list):
        data.setdefault("promptContext", {})["prefetchedPaths"] = [str(p) for p in paths]
    data.pop("needsClarification", None)

    adhoc_dir = qdir / "adhoc"
    adhoc_dir.mkdir(parents=True, exist_ok=True)
    dest = adhoc_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in adhoc/")
    dest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    src.unlink()
    return jsonify({"id": task_id, "resolved": True, "prefetchedPaths": data.get("promptContext", {}).get("prefetchedPaths")})


@app.route("/api/task/needs-clarification/<task_id>/answer", methods=["POST"])
def api_task_answer_clarification(task_id):
    """Multiple-choice / free-text answer for a 'design-decision' held task -- Grimmethy,
    2026-08-24: "we could build in some multiple choice options into the task log
    including an 'other:' option that the user could fill in without ever starting a chat
    session... reduce the friction caused by pausing the pipeline to set up a chat."
    Distinct from /resolve above (that one's for the file-path picker's 'ambiguous'/
    'no-match' shape); this is for nc.reason == 'design-decision', where the answer is a
    human decision folded into the task's own instructions -- same text shape a Discuss
    session's transcript already gets folded in as (see api_discuss_end's needs-
    clarification branch), just without ever opening a session.
    Body: {"answer": "<free text, or the clicked option's label+description>"}."""
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / "needs-clarification" / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    body = request.get_json(silent=True) or {}
    answer = (body.get("answer") or "").strip()
    if not answer:
        abort(400, description="answer is required")

    data.setdefault("promptContext", {})
    prior = data["promptContext"].get("rawText", "")
    data["promptContext"]["rawText"] = prior + (
        f"\n\nHUMAN DESIGN DECISION (answered directly from the Needs Clarification "
        f"picker, {datetime.now(timezone.utc).isoformat()}):\n{answer}\n"
        f"This answer resolves the open question(s) above -- implement against it "
        f"directly rather than re-asking for clarification."
    )
    data.pop("needsClarification", None)
    data.setdefault("history", []).append({
        "stage": "needs-clarification-resolved", "at": datetime.now(timezone.utc).isoformat(),
        "detail": "Answered directly from the dashboard's multiple-choice/Other picker -- requeued to adhoc/ for a fresh draft pass.",
    })

    adhoc_dir = qdir / "adhoc"
    adhoc_dir.mkdir(parents=True, exist_ok=True)
    dest = adhoc_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in adhoc/")
    dest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    src.unlink()
    return jsonify({"id": task_id, "answered": True})


@app.route("/api/task/needs-clarification/<task_id>/done", methods=["POST"])
def api_task_mark_done_clarification(task_id):
    """Manual "mark as done" for a held needs-clarification task (Job Status > Needs
    Clarification, 2026-08-17: "I found entries here that have been fully resolved"): unlike
    Reject/archive above, which files it under done/_archived_no_action/ (a nested folder
    api_queue_state() never lists, and taskIdExistsInQueue() never checks, so the underlying
    item is silently freed up for reconsideration), this writes queue/done/<id>.json directly
    -- the same path a real apply-pass completion uses -- so it shows up in the Done tab and
    taskIdExistsInQueue() correctly treats it as already handled, matching what the user is
    telling us: the work is genuinely finished, not merely dismissed."""
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / "needs-clarification" / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    now_iso = datetime.now(timezone.utc).isoformat()
    data["doneMarker"] = "manually marked done from Needs Clarification"
    data.setdefault("history", []).append({
        "status": "done", "at": now_iso, "note": "manually marked done from needs-clarification/",
    })

    done_dir = qdir / "done"
    done_dir.mkdir(parents=True, exist_ok=True)
    dest = done_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in done/")
    dest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    src.unlink()
    return jsonify({"id": task_id, "done": True})


import logging

logger = logging.getLogger(__name__)


@app.route("/api/task/approved/<task_id>/apply", methods=["POST"])
def api_task_apply(task_id):
    """Manual per-task apply (three-tier approval mode, 2026-07-26): the missing piece that
    makes 'prompt'/'approve'-tier tasks actually usable one at a time, instead of only via
    the all-or-nothing AGENT_MANAGER_INCLUDE_APPLY global toggle. Shells out to
    apply-runner.ps1 -TaskId <id> (a one-shot invocation mode that bypasses the automatic
    loop's approval-mode filtering entirely, since a human explicitly clicked Apply) and
    waits for it to finish -- a real git branch/commit/push can take a while, hence the
    generous timeout, and this is deliberately synchronous (no async job tracking) since
    the dashboard button needs a direct success/failure answer to show the user."""
    qdir = queue_dir()
    if not qdir:
        abort(404)
    approved_path = qdir / "approved" / f"{task_id}.json"
    if not approved_path.is_file():
        abort(404, description=f"'{task_id}' not found in approved/")

    repo_root = get_active_repo_root()
    if not repo_root:
        abort(400, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")

    env_overrides = read_env_file(ENV_FILE_PATH)
    env_overrides["AGENT_MANAGER_REPO_ROOT"] = repo_root
    child_env = {**os.environ, **env_overrides}

    script_path = SRC_DIR / "apply-runner.ps1"
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script_path), "-TaskId", task_id],
            capture_output=True, text=True, timeout=300, env=child_env, cwd=str(PACKAGE_ROOT),
        )
    except subprocess.TimeoutExpired as e:
        logger.error(
            "apply-runner.ps1 -TaskId %s timed out (script: %s): %s: %s",
            task_id, str(script_path), type(e).__name__, str(e),
            exc_info=True,
        )
        raise

    output_tail = (result.stdout or "")[-4000:]
    if result.returncode == 2:
        return jsonify({"id": task_id, "applied": False, "reason": f"'{task_id}' was not found in approved/ by apply-runner.ps1 (raced with the automatic loop?)"}), 404
    if result.returncode != 0:
        return jsonify({"id": task_id, "applied": False, "reason": "apply-runner.ps1 exited non-zero", "output": output_tail}), 500

    return jsonify({"id": task_id, "applied": True, "output": output_tail})


@app.route("/api/task-anywhere/<task_id>")
def api_task_anywhere(task_id):
    """Workers tab click-through: an instance's currentTaskId doesn't say which queue
    state to look in (a worker's is in drafting/, review-runner's is in review/,
    apply-runner's is in approved/) -- rather than hardcode that mapping (fragile if a
    new instance type is added later), just search drafting first (the common case for
    an actively 'working' instance), then every other state in order."""
    qdir = queue_dir()
    if not qdir:
        abort(404)

    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for candidate in drafting_root.rglob(f"{task_id}.json"):
            data = read_json_safe(candidate)
            if data:
                return jsonify({**data, "_foundState": "drafting", "_costSummary": _task_cost_summary(task_id), "_filesTouched": _files_touched_for(data), "_requestInput": _task_input_summary(data), "_workLog": _work_log_for(task_id)})

    def _payload(data, found_state):
        return jsonify({**data, "_foundState": found_state, "_costSummary": _task_cost_summary(task_id), "_filesTouched": _files_touched_for(data), "_requestInput": _task_input_summary(data), "_workLog": _work_log_for(task_id)})

    for state in QUEUE_STATES:
        data = read_json_safe(qdir / state / f"{task_id}.json")
        if data:
            return _payload(data, state)

    # A job-log / recent-tasks row can point at a task that has since been archived (by the
    # daily done-archive pass or by hand) or that lives in adhoc/ -- none of which are in
    # QUEUE_STATES. Check those too so the row still opens.
    data = read_json_safe(qdir / "adhoc" / f"{task_id}.json")
    if data:
        return _payload(data, "adhoc")
    data = read_json_safe(qdir / "done" / "_archived_no_action" / f"{task_id}.json")
    if data:
        return _payload(data, "archived")
    dated_archive_root = qdir / "done" / "_archived"
    if dated_archive_root.is_dir():
        for month_dir in sorted(dated_archive_root.iterdir(), reverse=True):
            if not month_dir.is_dir():
                continue
            data = read_json_safe(month_dir / f"{task_id}.json")
            if data:
                return _payload(data, "archived")

    abort(404, description=f"task {task_id} not found in any queue state")


def _adhoc_task_excerpt(data):
    """Short status-relevant snippet for the Adhoc Tasks list -- whichever field
    actually carries the human-relevant signal for wherever the task currently sits,
    same fields api_alerts() already reads for the same reason."""
    if data.get("blockedReason"):
        return data["blockedReason"][:200]
    if data.get("localVerdict") or data.get("ornithVerdict"):
        return (data.get("localVerdict") or data["ornithVerdict"])[:200]
    return None


@app.route("/api/adhoc-tasks")
def api_adhoc_tasks():
    """Every domain:'adhoc' task across the whole pipeline, in one flat list, with
    whichever queue state it's currently sitting in -- the cross-cutting view
    api_task_anywhere already has the right traversal shape for (drafting/ first,
    per-instance, then every other QUEUE_STATES dir), generalized here from 'find one
    task by id' to 'collect every adhoc task found along the way'. Also checks
    queue/adhoc/ itself, the one real state api_task_anywhere never had to check --
    task-sources.js's own nextAdhocTask() reads directly from there, before a claimed
    task ever reaches pending/, so a task sitting there unclaimed would otherwise be
    invisible to this view.

    An 'adhoc' task is identified by domain=='adhoc' OR an id starting with 'adhoc-'
    (queue-adhoc-task.js's own id convention, also used by the Brain Dump tab's
    'Process Now' button injection) -- domain alone isn't reliable since a caller can
    omit --domain (queue-adhoc-task.js then falls back to the first key in
    task-domains.json, not necessarily 'adhoc').

    done/ is SKIPPED by default (?includeDone=1 opts in) -- confirmed live 2026-08-22
    this endpoint was timing out (reported "timed out after 8s" from the dashboard
    itself) once queue/done/ grew to ~3900 files: reading+parsing every one of them on
    every single poll of this tab, on Flask's single-threaded dev server, starved
    concurrent requests (nav badge polling, other tabs, the phone app) regardless of
    how fast any one request actually was in isolation. done/ tasks aren't what this
    view exists to track anyway -- the whole point is active (in-progress) and stuck
    (blocked) work, both already excluded from that giant folder."""
    qdir = queue_dir()
    if not qdir:
        return jsonify({"tasks": []})
    include_done = request.args.get("includeDone") == "1"

    def is_adhoc(data, task_id):
        return data.get("domain") == "adhoc" or task_id.startswith("adhoc-")

    # dependsOn visibility (2026-08-22, Grimmethy: "systematic way to prioritize what
    # order adhoc tasks get completed in") -- mirrors task-sources.js's own
    # isDependencySatisfied() exactly (satisfied only once mergedAt is stamped on the
    # dependency's queue/done/ record, not just done -- see that function's comment for
    # why reaching done/ alone isn't enough), so a human looking at this list sees the
    # SAME "is this actually unblocked" answer the claim logic itself uses.
    def dependency_status(depends_on):
        if not depends_on:
            return None
        out = []
        for dep_id in depends_on:
            satisfied = False
            for candidate in (qdir / "done" / f"{dep_id}.json", qdir / "done" / "_archived_no_action" / f"{dep_id}.json"):
                dep_data = read_json_safe(candidate)
                if dep_data and dep_data.get("mergedAt"):
                    satisfied = True
                    break
            out.append({"id": dep_id, "satisfied": satisfied})
        return out

    def task_row(data, task_id, state):
        return {
            "id": task_id,
            "title": data.get("title") or task_id,
            "state": state,
            "createdAt": data.get("createdAt"),
            "excerpt": _adhoc_task_excerpt(data),
            "dependsOn": dependency_status(data.get("dependsOn")),
        }

    tasks = []

    adhoc_dir = qdir / "adhoc"
    if adhoc_dir.is_dir():
        for f in adhoc_dir.glob("*.json"):
            data = read_json_safe(f)
            if data and is_adhoc(data, f.stem):
                tasks.append(task_row(data, data.get("id", f.stem), "adhoc"))

    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for f in drafting_root.rglob("*.json"):
            data = read_json_safe(f)
            if not data:
                continue
            task_id = data.get("id", f.stem)
            if not is_adhoc(data, task_id):
                continue
            tasks.append(task_row(data, task_id, f"drafting:{f.parent.name}"))

    for state in QUEUE_STATES:
        if state == "done" and not include_done:
            continue
        state_dir = qdir / state
        if not state_dir.is_dir():
            continue
        for f in state_dir.glob("*.json"):
            data = read_json_safe(f)
            if not data:
                continue
            task_id = data.get("id", f.stem)
            if not is_adhoc(data, task_id):
                continue
            tasks.append(task_row(data, task_id, state))

    tasks.sort(key=lambda t: t.get("createdAt") or "", reverse=True)
    return jsonify({"tasks": tasks})


# --- Live task-source topology -----------------------------------------------------------
# `node src/task-sources.js --dump-topology` reads the REAL registry (this repo's built-ins
# PLUS any AGENT_MANAGER_REGISTER_PATH plugin sources -- agent-manager-hygiene owns
# observability/performance/function-length/arch/unused-export), so the Job List catalog,
# default priorities, worker types and candidate-doc paths below no longer drift the way a
# hand-maintained TASK_SOURCE_CATALOG did. Cached briefly (several endpoints hit it per
# page load); on any failure we fall back to a committed snapshot so a transient node/env
# hiccup blanks nothing -- never to a hand-typed list.
_TOPOLOGY_FALLBACK_PATH = Path(__file__).resolve().parent / "task_source_topology_fallback.json"
_topology_cache: dict = {"at": 0.0, "value": None}
_TOPOLOGY_TTL_SECONDS = 5.0


def _load_topology_fallback() -> list[dict]:
    try:
        return json.loads(_TOPOLOGY_FALLBACK_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def load_topology() -> list[dict]:
    """List of per-source dicts from `--dump-topology` (name, slug, priority, reasoningTier,
    workerType, candidateFulfillment, candidatesPath, candidateDocTitle, ...). Falls back to
    the committed snapshot on any error."""
    now = time.monotonic()
    if _topology_cache["value"] is not None and now - _topology_cache["at"] < _TOPOLOGY_TTL_SECONDS:
        return _topology_cache["value"]
    value = None
    try:
        child_env = {**os.environ, **read_env_file(ENV_FILE_PATH)}
        result = subprocess.run(
            ["node", str(SRC_DIR / "task-sources.js"), "--dump-topology"],
            capture_output=True, text=True, timeout=15, cwd=str(SRC_DIR), env=child_env,
        )
        if result.returncode == 0:
            parsed = json.loads(result.stdout)
            if isinstance(parsed, list) and parsed:
                value = parsed
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        logger.warning("topology subprocess failed; falling back to static data", exc_info=True)
        value = None
    if value is None:
        value = _load_topology_fallback()
    _topology_cache["at"] = now
    _topology_cache["value"] = value
    return value


def topology_by_name() -> dict:
    return {s["name"]: s for s in load_topology()}


def task_source_catalog() -> list[str]:
    """Every registered source name, in registry (priority) order. Replaces the old
    hand-maintained TASK_SOURCE_CATALOG list."""
    return [s["name"] for s in load_topology()]


def task_source_default_priorities() -> dict:
    return {s["name"]: s.get("priority") for s in load_topology()}


def task_source_default_worker_types() -> dict:
    return {s["name"]: s.get("workerType", "ornith") for s in load_topology()}


def arch_candidates_path() -> Path | None:
    """Mirrors src/config.js's archReviewCandidatesPath resolution (env override, else
    <repoRoot>/Docs/ARCH_REVIEW_CANDIDATES.md) -- the dashboard reads the same doc the
    Node side's applyArchDiscoveryCandidates() writes."""
    override = os.environ.get("AGENT_MANAGER_ARCH_CANDIDATES_PATH") or read_env_file(
        ENV_FILE_PATH
    ).get("AGENT_MANAGER_ARCH_CANDIDATES_PATH")
    if override:
        return Path(override)
    repo_root = get_active_repo_root()
    if not repo_root:
        return None
    return Path(repo_root) / "Docs" / "ARCH_REVIEW_CANDIDATES.md"


def _candidates_doc_path(env_var: str, default_filename: str) -> Path | None:
    """Shared env-override-else-repoRoot/Docs/<default_filename> resolution -- same shape
    as arch_candidates_path() above, parameterized for the other *_CANDIDATES.md docs
    src/config.js resolves the same way (archImportCandidatesPath,
    observabilityFixCandidatesPath, performanceFixCandidatesPath)."""
    override = os.environ.get(env_var) or read_env_file(ENV_FILE_PATH).get(env_var)
    if override:
        return Path(override)
    repo_root = get_active_repo_root()
    if not repo_root:
        return None
    return Path(repo_root) / "Docs" / default_filename


def arch_import_candidates_path() -> Path | None:
    """Mirrors src/config.js's archImportCandidatesPath."""
    return _candidates_doc_path("AGENT_MANAGER_ARCH_IMPORT_CANDIDATES_PATH", "ARCH_IMPORT_CANDIDATES.md")


def observability_fix_candidates_path() -> Path | None:
    """Mirrors src/config.js's observabilityFixCandidatesPath."""
    return _candidates_doc_path("AGENT_MANAGER_OBSERVABILITY_FIX_CANDIDATES_PATH", "OBSERVABILITY_FIX_CANDIDATES.md")


def performance_fix_candidates_path() -> Path | None:
    """Mirrors src/config.js's performanceFixCandidatesPath."""
    return _candidates_doc_path("AGENT_MANAGER_PERFORMANCE_FIX_CANDIDATES_PATH", "PERFORMANCE_FIX_CANDIDATES.md")


# Job List tab's "Available" column (Grimmethy: "for tasks like observability and
# architecture where the number of such tasks available in the project is known I'd like
# to be able to see in app how many of such task are available") -- only meaningful for
# a source whose backlog is a real, enumerable doc (the *_CANDIDATES.md files
# nextCandidateFulfillmentTask, src/task-sources.js, consumes one Strong entry from at a
# time); every other source's backlog (an inbox folder size, a flags file, external
# scanner output) isn't covered here and the column just shows nothing for those rows.
# The set of such sources, and each one's candidate-doc path, now comes from
# load_topology() (candidateFulfillment + candidatesPath) -- so a plugin fulfillment source
# (observability_fix / performance_fix / function_length_fix / arch_import_review) gets an
# Available count with no per-source Python mirror to keep in sync. The task-id prefix
# nextCandidateFulfillmentTask stamps is `slug + '-ac-' + candidateId.toLowerCase()`.
def candidate_backlog_sources() -> dict:
    """name -> (candidate-doc Path, task-id prefix) for every registered
    candidate-fulfillment source that has a resolvable doc path."""
    repo_root = get_active_repo_root()
    out = {}
    for s in load_topology():
        raw = s.get("candidatesPath")
        if not s.get("candidateFulfillment") or not raw:
            continue
        p = Path(raw)
        if not p.is_absolute() and repo_root:
            p = Path(repo_root) / raw
        out[s["name"]] = (p, s["slug"])
    return out


def available_candidate_counts() -> dict:
    """One count per candidate_backlog_sources() entry: Strong-rated candidates in that
    source's doc that don't already have a fulfillment task somewhere in the queue (any
    state -- a done/archived one has already been fulfilled, not "available" any more).
    A candidate doc only ever grows (nothing removes an entry once consumed, see
    candidate-docs.js's applyArchDiscoveryCandidates), so counting doc entries alone would
    overstate the real backlog more and more over time -- the queue lookup is what keeps
    this an honest "still waiting" number instead of a raw, ever-growing doc size."""
    backlog = candidate_backlog_sources()
    counts = {name: None for name in backlog}
    task_states = _task_state_index(queue_dir())
    for name, (doc_path, id_prefix) in backlog.items():
        if not doc_path or not doc_path.is_file():
            continue
        try:
            text = doc_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            logger.exception("Backlog source %r failed during aggregation", name)
            continue
        entries = parse_arch_candidates(text)
        counts[name] = sum(
            1
            for e in entries
            if e.get("strength") == "Strong"
            and f"{id_prefix}-ac-{e['id']}" not in task_states
        )
    return counts


def community_coverage_path() -> Path | None:
    """Mirrors src/config.js's communityCoveragePath resolution (env override, else
    <pipelineDir>/community-coverage.json)."""
    override = os.environ.get("AGENT_MANAGER_COMMUNITY_COVERAGE_PATH") or read_env_file(
        ENV_FILE_PATH
    ).get("AGENT_MANAGER_COMMUNITY_COVERAGE_PATH")
    if override:
        return Path(override)
    d = get_pipeline_dir()
    return (d / "community-coverage.json") if d else None


# Same heading convention candidates-doc-merge.js declares as HEADING_RE -- one parser
# per language, both reading the exact format applyArchDiscoveryCandidates() writes.
ARCH_CANDIDATE_HEADING_RE = re.compile(r"^#{1,6}\s*AC-(\d+)\b[^\S\n]*[·\-:]?[^\S\n]*(.*)$", re.M)


def parse_arch_candidates(text: str) -> list[dict]:
    """Splits a *_CANDIDATES.md doc into its '### AC-N · Title' blocks. Returns
    [{id, title, strength, files, content}] in doc order; preamble (everything before
    the first AC heading) is dropped -- it's boilerplate about the format itself."""
    entries = []
    blocks = re.split(r"(?=^#{1,6}\s*AC-\d+)", text.replace("\r\n", "\n"), flags=re.M)
    for block in blocks:
        block = block.strip()
        m = ARCH_CANDIDATE_HEADING_RE.match(block)
        if not m:
            continue
        strength = None
        files = None
        for line in block.splitlines()[1:8]:  # metadata lines sit right under the heading
            if line.startswith("Strength:"):
                strength = line[len("Strength:"):].strip()
            elif line.startswith("Files:"):
                files = [p.strip() for p in line[len("Files:"):].split(",") if p.strip()]
        entries.append({
            "id": int(m.group(1)),
            "title": m.group(2).strip() or f"AC-{m.group(1)}",
            "strength": strength,
            "files": files or [],
            "content": block,
        })
    return entries


@app.route("/api/discovery")
def api_discovery():
    """Everything the Discovery tab shows in one call: arch_discovery's community
    coverage (what the job is working through), every arch-discovery task currently in
    the queue (including done/ -- located by the filename convention
    'arch-discovery-community-<id>.json' rather than reading all ~4k done files, the
    exact trap api_adhoc_tasks' includeDone comment documents), and the AC-N candidate
    entries the job has produced so far."""
    result = {
        "available": False,
        "communities": [],
        "nextCommunityId": None,
        "tasks": [],
        "candidates": [],
        "candidatesPath": None,
    }

    coverage_file = community_coverage_path()
    coverage = read_json_safe(coverage_file) if coverage_file else None
    if coverage and isinstance(coverage.get("communities"), list):
        result["available"] = True
        result["communities"] = [
            {
                "id": c.get("id"),
                "name": c.get("name"),
                "lastReviewedAt": c.get("lastReviewedAt"),
                "lastCandidateCount": c.get("lastCandidateCount"),
            }
            for c in coverage["communities"]
        ]

    qdir = queue_dir()
    in_flight_by_community = {}
    if qdir:
        found = []  # (state, path) pairs; filename IS the task id for these
        drafting_root = qdir / "drafting"
        if drafting_root.is_dir():
            for f in drafting_root.rglob("arch-discovery-*.json"):
                found.append(("drafting", f))
        for state in QUEUE_STATES:
            state_dir = qdir / state
            if state_dir.is_dir():
                for f in state_dir.glob("arch-discovery-*.json"):
                    found.append((state, f))
        for state, f in found:
            data = read_json_safe(f)
            if not data:
                continue
            task_id = data.get("id", f.stem)
            community_id = None
            m = re.match(r"arch-discovery-community-(\d+)$", task_id)
            if m:
                community_id = int(m.group(1))
                if state not in ("done",):
                    in_flight_by_community[community_id] = state
            result["available"] = True
            result["tasks"].append({
                "id": task_id,
                "title": data.get("title") or task_id,
                "state": state,
                "communityId": community_id,
                "createdAt": data.get("createdAt"),
                "draftedAt": data.get("draftedAt"),
                "appliedAt": data.get("appliedAt"),
                "doneMarker": data.get("doneMarker"),
                "blockedReason": data.get("blockedReason"),
                "localRejectCount": data.get("localRejectCount", data.get("ornithRejectCount")),
                # Cheap "is there anything to read yet" signals for the list view --
                # the click-through detail modal (api_task_anywhere) carries the full
                # readouts, same split task_summary() uses.
                "hasPlan": bool(data.get("planResponse")),
                "hasImplement": bool((data.get("implementResponse") or "").strip()),
            })
        result["tasks"].sort(key=lambda t: t.get("createdAt") or "", reverse=True)

    # Which community nextArchDiscoveryTask() would pick next: oldest lastReviewedAt
    # first (never-reviewed sorts before any real timestamp), skipping communities that
    # already have a non-done task in the queue -- same rule as the Node side.
    eligible = [
        c for c in result["communities"]
        if c.get("id") is not None and c["id"] not in in_flight_by_community
    ]
    if eligible:
        eligible.sort(key=lambda c: c.get("lastReviewedAt") or "")
        result["nextCommunityId"] = eligible[0]["id"]
    for c in result["communities"]:
        c["inFlightState"] = in_flight_by_community.get(c.get("id"))

    cand_file = arch_candidates_path()
    if cand_file and cand_file.is_file():
        try:
            text = cand_file.read_text(encoding="utf-8", errors="replace")
            result["candidates"] = parse_arch_candidates(text)
            result["candidatesPath"] = str(cand_file)
            result["available"] = True
        except OSError as exc:
            logging.getLogger(__name__).warning("Failed to load arch candidates from %s: %s", cand_file, exc, exc_info=exc)

    return jsonify(result)


@app.route("/api/summary")
def api_summary():
    qdir = queue_dir()
    counts = {s: 0 for s in QUEUE_STATES}
    counts["drafting"] = 0
    bd_entries = _brain_dump_entries_with_task_status()
    # Unprocessed (captured/sorted) PLUS actioned-but-stuck -- see
    # BRAIN_DUMP_NEEDS_ATTENTION_STATES's own header for why the latter half exists: a
    # stuck-actioned entry previously gave zero nav-level signal at all.
    counts["brain-dump"] = (
        sum(1 for e in bd_entries if e.get("status") != "actioned")
        + _brain_dump_needs_attention_count(bd_entries)
    )
    # Cached (list_unmerged_branches(force=False)) -- this route is polled every 5s by
    # the nav badge cycle, and a live `git fetch` on every single poll would be both slow
    # and needlessly hammer the remote. The dedicated /api/git/unmerged-branches route
    # (used when the tab is actually open) always forces a fresh fetch instead.
    counts["branches"] = len(list_unmerged_branches(force=False))
    if not qdir:
        return jsonify(counts)

    for state in QUEUE_STATES:
        state_dir = qdir / state
        counts[state] = len(list(state_dir.glob("*.json"))) if state_dir.is_dir() else 0
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        counts["drafting"] = len(list(drafting_root.rglob("*.json")))
    # Adhoc Tasks nav badge: two separate counts, not one folded-together number
    # (Grimmethy, 2026-08-22: "It's just as important to know how many in process there
    # are so that we know how much work the system already has to work on" -- the badge
    # used to be JUST the awaiting-confirm count, which read as a flat "0" any time
    # nothing needed a confirm click even while real work was actively blocked or
    # in flight, exactly the "inaccurately showing 0" complaint this replaces).
    # adhocBlocked: blocked + needs-clarification + awaiting-confirm -- every state that
    # means a human's attention is the thing standing between this task and progress,
    # same states api_task_archive() already treats as one bucket for that reason.
    # adhocInProgress: everything else still moving on its own (queue/adhoc/ itself,
    # unclaimed; pending; drafting; review; approved) -- not a problem, just backlog size.
    def is_adhoc_record(data, task_id):
        return data.get("domain") == "adhoc" or task_id.startswith("adhoc-")

    def count_adhoc_in(dir_path):
        if not dir_path.is_dir():
            return 0
        n = 0
        for f in dir_path.glob("*.json"):
            data = read_json_safe(f)
            if data and is_adhoc_record(data, data.get("id", f.stem)):
                n += 1
        return n

    adhoc_blocked = sum(count_adhoc_in(qdir / s) for s in ("blocked", "needs-clarification", "awaiting-confirm"))
    adhoc_in_progress = sum(count_adhoc_in(qdir / s) for s in ("pending", "review", "approved")) \
        + count_adhoc_in(qdir / "adhoc")
    if drafting_root.is_dir():
        for f in drafting_root.rglob("*.json"):
            data = read_json_safe(f)
            if data and is_adhoc_record(data, data.get("id", f.stem)):
                adhoc_in_progress += 1
    counts["adhocBlocked"] = adhoc_blocked
    counts["adhocInProgress"] = adhoc_in_progress
    return jsonify(counts)


def _assign_brain_dump_serials(entries: list) -> bool:
    """Backfills a stable #N serial onto any entry that doesn't have one yet, so the
    user has a short, stable handle to reference a specific entry by ("entry #12")
    instead of its long slugified id. New entries get one at capture time (see
    api_brain_dump_capture); this covers every entry that existed before that changed
    and self-heals if brain-dump.json is ever hand-edited to drop the field. Assigns in
    capturedAt order (oldest first) so backfilled numbers land in a sensible reading
    order rather than dict/file order, continuing from whatever the current max already
    is so a re-run never reassigns or collides with a number already handed out.
    Returns True if anything changed, so the caller knows to persist it."""
    missing = [e for e in entries if isinstance(e, dict) and not e.get("serial")]
    if not missing:
        return False
    next_serial = max((e.get("serial") or 0) for e in entries if isinstance(e, dict)) + 1 if entries else 1
    for e in sorted(missing, key=lambda e: e.get("capturedAt") or ""):
        e["serial"] = next_serial
        next_serial += 1
    return True


def read_brain_dump_entries() -> list:
    path = brain_dump_path()
    if not path:
        return []
    data = read_json_safe(path)
    entries = data.get("entries") if isinstance(data, dict) else None
    entries = entries if isinstance(entries, list) else []
    if _assign_brain_dump_serials(entries):
        write_brain_dump_entries(entries)
    return entries


def write_brain_dump_entries(entries: list):
    path = brain_dump_path()
    if not path:
        abort(500, description="no active project configured")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"entries": entries}, indent=2), encoding="utf-8")


def slugify_for_id(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "entry"


def default_task_domain() -> str:
    """review-runner.ps1's Get-DomainConfig lookup requires the task's domain to be a
    real key in task-domains.json (not just any string), so this must pick an ACTUAL
    key from that file. Tries a small ordered list of generic-domain-name candidates
    first ('default', then 'adhoc') and returns the first one that's actually present --
    picking whatever happens to be the FIRST key in the dict, with no regard for whether
    it's a sane generic default, is what queued two real tasks with domain='adhoc' into a
    project whose task-domains.json didn't even list 'adhoc', permanently blocking them
    with "Unknown task domain: adhoc". Only falls back to that old first-key behavior if
    neither preferred candidate is present, so a project with neither still gets *some*
    valid domain instead of crashing."""
    d = get_pipeline_dir()
    if d:
        domains = read_json_safe(d / "task-domains.json")
        if isinstance(domains, dict) and domains:
            for candidate in ("default", "adhoc"):
                if candidate in domains:
                    return candidate
            return next(iter(domains.keys()))
    return "default"


def _task_state_index(qdir) -> dict:
    """One-pass task-id -> queue-state lookup, built once per /api/brain-dump call rather
    than one filesystem round-trip per entry. Confirmed live 2026-08-16: every one of a
    real user's "actioned" brain-dump entries was silently sitting in blocked/ (truncated
    drafts, fabricated file paths, one that was pure meta-commentary refusing the work) --
    completely invisible from the Brain Dump tab, which only ever showed the static
    "actioned"/"queued" badge regardless of what actually happened to the task downstream.
    Covers every location a task can really be sitting in: each QUEUE_STATES dir, the
    manual-archive folder (api_task_archive's own destination), and drafting/ (per-worker
    subfolders, matching /api/queue/drafting's own legacy-no-subfolder fallback)."""
    index = {}
    if not qdir:
        return index
    for state in QUEUE_STATES:
        state_dir = qdir / state
        if not state_dir.is_dir():
            continue
        for f in state_dir.glob("*.json"):
            index[f.stem] = state
    archived_dir = qdir / "done" / "_archived_no_action"
    if archived_dir.is_dir():
        for f in archived_dir.glob("*.json"):
            index[f.stem] = "archived"
    # done-archive.js's own dated month buckets (2026-08-24) -- a task the automatic daily
    # archive pass relocated is exactly as "archived" as one a human moved by hand above;
    # without this, a task's Brain Dump badge would silently go blank (not found anywhere
    # in this index) the moment it aged out of done/'s top level, the same invisible-status
    # bug this whole index was built to fix in the first place.
    dated_archive_root = qdir / "done" / "_archived"
    if dated_archive_root.is_dir():
        for month_dir in dated_archive_root.iterdir():
            if not month_dir.is_dir():
                continue
            for f in month_dir.glob("*.json"):
                index[f.stem] = "archived"
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for sub in drafting_root.iterdir():
            if sub.is_dir():
                for f in sub.glob("*.json"):
                    index[f.stem] = "drafting"
        for f in drafting_root.glob("*.json"):  # legacy: no per-worker subfolder
            index[f.stem] = "drafting"
    return index


# Module-level (not inline in api_brain_dump) so api_summary's nav-badge count can share
# the EXACT same definition -- confirmed live 2026-08-18: the tab's own default filter
# already surfaced every actioned-but-stuck entry correctly (taskStatus badges, built
# 2026-08-16), but the nav sidebar's Brain Dump count (api_summary, below) only ever
# counted status != 'actioned' -- captured/sorted, never a stuck-actioned entry -- so a
# real backlog of 27 actioned-but-blocked/needs-clarification/awaiting-confirm entries
# gave ZERO signal at the nav level. Discovering them required opening the tab with no
# filter and remembering to check, exactly the manual-audit gap this pair of definitions
# closes: one source of truth for "needs attention," read by both the badge count and the
# tab's own default view, so they can't drift the way two independently-hand-maintained
# lists always eventually do in this codebase (see drift-scan.js's whole existence).
BRAIN_DUMP_NEEDS_ATTENTION_STATES = {"blocked", "needs-clarification", "awaiting-confirm"}


def _brain_dump_entries_with_task_status():
    """read_brain_dump_entries() + each entry's live queue state (taskStatus), the same
    enrichment api_brain_dump() and api_summary() both need -- factored out so neither can
    silently stop doing it."""
    entries = read_brain_dump_entries()
    task_states = _task_state_index(queue_dir())
    for e in entries:
        qid = e.get("queuedTaskId")
        if qid:
            e["taskStatus"] = task_states.get(qid, "unknown")
    return entries


def _brain_dump_needs_attention_count(entries):
    return sum(
        1 for e in entries
        if e.get("status") == "actioned" and e.get("taskStatus") in BRAIN_DUMP_NEEDS_ATTENTION_STATES
    )


@app.route("/api/brain-dump")
def api_brain_dump():
    """Brain Dump tab's left pane. Defaults to everything not yet actioned (captured +
    sorted) PLUS any actioned entry whose downstream task actually needs a human
    (blocked/needs-clarification) -- confirmed live 2026-08-16: every one of a real
    user's actioned entries had silently blocked, invisible under the old default filter
    (which excluded every actioned entry unconditionally, cleanly-completed or not) same
    as under the old flat "queued" badge. A genuinely still-in-progress or successfully
    completed actioned entry stays hidden by default -- only ?status=actioned/all
    surfaces those -- since there's nothing for a human to act on there.
    ?status=<value> narrows to one status, ?status=all returns the full history.

    BUG FIXED 2026-08-21 (Grimmethy: "Entry #129 is visible in both the processed and
    unprocessed tabs ... If an entry is not fully resolved it shouldn't be 'processed'"):
    ?status=actioned used to mean only "status field says actioned," which counts an
    entry whose downstream task is blocked/needs-clarification/awaiting-confirm as
    Processed even though it's simultaneously showing up in the default (Unprocessed)
    view for the exact opposite reason -- it still needs a human. "Processed" now means
    the same thing the default view's own inverse already implies: actioned AND not
    stuck waiting on a human, so an entry is in exactly one of Unprocessed/Processed,
    never both, and "not fully resolved" (this session's own words for it) can never
    read as processed."""
    entries = _brain_dump_entries_with_task_status()

    status_filter = request.args.get("status", "").strip()
    if status_filter == "actioned":
        entries = [
            e for e in entries
            if e.get("status") == "actioned" and e.get("taskStatus") not in BRAIN_DUMP_NEEDS_ATTENTION_STATES
        ]
    elif status_filter and status_filter != "all":
        entries = [e for e in entries if e.get("status") == status_filter]
    elif not status_filter:
        entries = [
            e for e in entries
            if e.get("status") != "actioned" or e.get("taskStatus") in BRAIN_DUMP_NEEDS_ATTENTION_STATES
        ]
    entries = sorted(entries, key=lambda e: e.get("capturedAt") or "", reverse=True)

    return jsonify(entries)


@app.route("/api/brain-dump/capture", methods=["POST"])
def api_brain_dump_capture():
    """Dumb, synchronous append -- no LLM in the write path, same philosophy as
    queue-adhoc-task.js's manual task injection. The brain_dump_sort Ornith worker source
    picks unsorted ("captured") entries up from here asynchronously."""
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        abort(400, description="text is required")

    if not brain_dump_path():
        abort(500, description="no active project configured")

    # read_brain_dump_entries() backfills+persists a serial onto any pre-existing entry
    # that doesn't already have one, so `entries` here is always fully migrated before
    # next_serial is computed off it -- see _assign_brain_dump_serials()'s own header.
    entries = read_brain_dump_entries()
    next_serial = max((e.get("serial") or 0) for e in entries) + 1 if entries else 1

    entry_id = f"bd-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{slugify_for_id(text)}"
    entry = {
        "id": entry_id,
        "serial": next_serial,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "rawText": text,
        "status": "captured",
    }
    entries.append(entry)
    write_brain_dump_entries(entries)
    return jsonify(entry)


@app.route("/api/brain-dump/<entry_id>", methods=["PUT"])
def api_brain_dump_edit(entry_id):
    """Edits an entry's raw text. If it had already been sorted, the sort result is tied
    to the OLD text -- keeping it around would show a category/destination that no longer
    reflects what's actually captured, so an edit resets the entry back to 'captured' and
    drops the stale sort, same as a fresh capture. brain_dump_sort picks it up again from
    there."""
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        abort(400, description="text is required")

    entries = read_brain_dump_entries()
    entry = next((e for e in entries if e.get("id") == entry_id), None)
    if not entry:
        abort(404)

    if entry.get("rawText") != text and entry.get("status") == "sorted":
        entry["status"] = "captured"
        entry.pop("sort", None)
    entry["rawText"] = text
    entry["editedAt"] = datetime.now(timezone.utc).isoformat()

    write_brain_dump_entries(entries)
    return jsonify(entry)


@app.route("/api/brain-dump/<entry_id>", methods=["DELETE"])
def api_brain_dump_delete(entry_id):
    entries = read_brain_dump_entries()
    remaining = [e for e in entries if e.get("id") != entry_id]
    if len(remaining) == len(entries):
        abort(404)
    write_brain_dump_entries(remaining)
    return jsonify({"deleted": entry_id})


@app.route("/api/brain-dump/<entry_id>/prioritize", methods=["POST"])
def api_brain_dump_prioritize(entry_id):
    """'Process this now' button: injects the entry straight into queue/adhoc/, the SAME
    preempt-everything lane queue-adhoc-task.js already uses (nextAdhocTask() in
    task-sources.js is checked before every deterministic source, including whatever
    brain_dump_sort/brain_dump_action end up being). Deliberately bypasses the sort stage
    rather than waiting on it -- this button means "a human wants this handled right now,"
    not "queue it for eventual triage."""
    entries = read_brain_dump_entries()
    entry = next((e for e in entries if e.get("id") == entry_id), None)
    if not entry:
        abort(404)

    # Idempotency guard (2026-08-18): this endpoint used to create a brand-new task file
    # on every call, no matter how many times it was hit -- a double-click (or a slow
    # response plus an impatient re-click) queued the SAME entry twice, and the second
    # call's queuedTaskId write silently overwrote the first, orphaning it: a real task
    # file sitting in the queue that nothing -- not the Brain Dump tab, not the entry's
    # own record -- ever pointed back to again. Confirmed live: 7 real orphans found this
    # way in queue/needs-clarification/ alone. An already-actioned entry just returns its
    # existing queuedTaskId instead of minting a second one.
    if entry.get("status") == "actioned" and entry.get("queuedTaskId"):
        return jsonify(entry)

    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")

    task_id = f"adhoc-brain-dump-{slugify_for_id(entry['rawText'])}-{int(datetime.now(timezone.utc).timestamp() * 1000)}"
    record = {
        "id": task_id,
        "domain": default_task_domain(),
        "source": "manual",
        "title": entry["rawText"][:120],
        "promptContext": {
            "rawText": entry["rawText"],
            "brainDumpEntryId": entry["id"],
            "sort": entry.get("sort"),
        },
    }
    adhoc_dir = pipeline_dir / "queue" / "adhoc"
    adhoc_dir.mkdir(parents=True, exist_ok=True)
    (adhoc_dir / f"{task_id}.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")

    entry["status"] = "actioned"
    entry["queuedTaskId"] = task_id
    entry["queuedAt"] = datetime.now(timezone.utc).isoformat()
    write_brain_dump_entries(entries)
    return jsonify(entry)


@app.route("/api/brain-dump/<entry_id>/discuss/latest", methods=["GET"])
def api_brain_dump_discuss_latest(entry_id):
    """Same "don't silently start a duplicate session" check grill/for-note already does
    for Grill Me -- see discuss_sessions.py's latest_session_for_subject() for the
    incident that pattern traces back to."""
    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")
    from discuss_sessions import latest_session_for_subject
    session = latest_session_for_subject(pipeline_dir, entry_id)
    return jsonify(session)


@app.route("/api/brain-dump/<entry_id>/discuss/start", methods=["POST"])
def api_brain_dump_discuss_start(entry_id):
    entries = read_brain_dump_entries()
    entry = next((e for e in entries if e.get("id") == entry_id), None)
    if not entry:
        abort(404)
    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")
    from discuss_sessions import start_session
    provider, model, effort = _discuss_provider_args()
    session = _call_discuss(start_session, pipeline_dir, entry_id, entry["rawText"], kind="brain-dump",
                             provider=provider, model=model, effort=effort, repo_root=get_active_repo_root(),
                             grep_dirs=get_active_grep_dirs(), instances_dir=instances_dir())
    return jsonify(session)


@app.route("/api/task/needs-clarification/<task_id>/discuss/latest", methods=["GET"])
def api_needs_clarification_discuss_latest(task_id):
    """Held-task counterpart to the brain-dump/second-brain discuss/latest checks above --
    same "don't silently start a duplicate" reasoning."""
    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")
    from discuss_sessions import latest_session_for_subject
    session = latest_session_for_subject(pipeline_dir, task_id)
    return jsonify(session)


@app.route("/api/task/needs-clarification/<task_id>/discuss/start", methods=["POST"])
def api_needs_clarification_discuss_start(task_id):
    """"Rather than inputting a file path manually we should open a 'discuss' to get more
    information about the task itself" -- the actual ask. Starts a conversation about a
    held queue/needs-clarification/ task, using its rawText as the subject. Ending it
    (see api_discuss_end's 'needs-clarification' branch) reopens the task for a fresh
    path_prefetch_resolve attempt with the enriched text, rather than just leaving a
    human to manually resolve it with no more information than they started with."""
    qdir = queue_dir()
    if not qdir:
        abort(500, description="no active project configured")
    held_path = qdir / "needs-clarification" / f"{task_id}.json"
    held = read_json_safe(held_path)
    if not held:
        abort(404)
    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")
    subject_text = (held.get("promptContext") or {}).get("rawText") or held.get("title") or ""
    from discuss_sessions import start_session
    provider, model, effort = _discuss_provider_args()
    session = _call_discuss(start_session, pipeline_dir, task_id, subject_text, kind="needs-clarification",
                             provider=provider, model=model, effort=effort, repo_root=get_active_repo_root(),
                             grep_dirs=get_active_grep_dirs(), instances_dir=instances_dir())
    return jsonify(session)


# Matches the exact cross-reference line applyBrainDumpSort (apply-group-a.js) writes
# into a vault note when belongsToProject matches -- "Queued as adhoc task `id` in
# **label**", with an optional ", held for clarification (...)" suffix after the closing
# ** that this regex doesn't need to care about (it only needs the id/label pair).
_TASK_REF_RE = re.compile(r"Queued as adhoc task `([^`]+)` in \*\*([^*]+)\*\*")


@app.route("/api/second-brain/task-refs")
def api_second_brain_task_refs():
    """Second-brain counterpart to the Brain Dump tab's live taskStatus badges
    (2026-08-16): a note can carry a task cross-reference naming a DIFFERENT project than
    whatever pipeline is currently active. That project's queue is looked up directly via
    projects.json (repoRoot/pipelineDir) rather than requiring it to be switched active
    first -- a real, live status is available regardless of what's currently running,
    same as any other registered project's queue files sitting right there on disk.
    Only when the project isn't registered at all, or its pipeline dir isn't reachable on
    this machine, does this fall back to a plain informational note instead of a real
    status -- see each branch below for the user-facing wording."""
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    note_path_str = (request.args.get("notePath") or "").strip()
    if not note_path_str:
        abort(400, description="notePath is required")
    full_path = _resolve_under_second_brain(root.resolve(), note_path_str)
    if not full_path.is_file():
        return jsonify([])

    content = full_path.read_text(encoding="utf-8")
    matches = _TASK_REF_RE.findall(content)
    if not matches:
        return jsonify([])

    registry = read_project_registry()
    active_root = get_active_repo_root()
    active_root_norm = os.path.normpath(active_root) if active_root else None

    # Cache per-project task-state indexes -- a note can reference the same project
    # multiple times (several entries queued into the same pipeline over time); no
    # reason to re-scan that project's queue dirs once per reference found.
    index_cache = {}
    results = []
    seen = set()
    for task_id, raw_label in matches:
        label = raw_label.strip()
        key = (task_id, label)
        if key in seen:
            continue
        seen.add(key)

        project = next((p for p in registry if p.get("label") == label), None)
        if not project:
            results.append({
                "taskId": task_id, "projectLabel": label, "projectFound": False,
                "isActiveProject": False, "taskStatus": None,
                "note": f'Project "{label}" is not currently registered -- open it once via the Project tab to enable status lookups for its tasks.',
            })
            continue

        is_active = bool(active_root_norm) and os.path.normpath(project.get("repoRoot", "")) == active_root_norm
        pipeline_dir_str = project.get("pipelineDir")
        pipeline_dir = Path(pipeline_dir_str) if pipeline_dir_str else None
        if not pipeline_dir or not pipeline_dir.is_dir():
            results.append({
                "taskId": task_id, "projectLabel": label, "projectFound": True,
                "isActiveProject": is_active, "taskStatus": None,
                "note": f'"{label}"\'s pipeline directory is not reachable on this machine right now.',
            })
            continue

        if pipeline_dir_str not in index_cache:
            index_cache[pipeline_dir_str] = _task_state_index(pipeline_dir / "queue")
        status = index_cache[pipeline_dir_str].get(task_id, "unknown")
        note = None
        if not is_active:
            note = f'Belongs to "{label}" -- switch to it via the Project tab for the pipeline to actively work on it further.'
        results.append({
            "taskId": task_id, "projectLabel": label, "projectFound": True,
            "isActiveProject": is_active, "taskStatus": status, "note": note,
        })

    return jsonify(results)


@app.route("/api/second-brain/discuss/for-note", methods=["GET"])
def api_second_brain_discuss_for_note():
    """Vault-note counterpart to /api/brain-dump/<id>/discuss/latest -- same "don't
    silently start a duplicate" check, surfaced next to Grill Me/Grill With Docs in the
    Second Brain file viewer."""
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    note_path = (request.args.get("notePath") or "").strip()
    if not note_path:
        abort(400, description="notePath is required")
    from discuss_sessions import latest_session_for_subject
    session = latest_session_for_subject(root, note_path)
    return jsonify(session)


@app.route("/api/second-brain/discuss/start", methods=["POST"])
def api_second_brain_discuss_start():
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    body = request.get_json(silent=True) or {}
    note_path = (body.get("notePath") or "").strip()
    if not note_path:
        abort(400, description="notePath is required")
    full_path = _resolve_under_second_brain(root.resolve(), note_path)
    note_content = full_path.read_text(encoding="utf-8") if full_path.is_file() else ""
    from discuss_sessions import start_session
    provider, model, effort = _discuss_provider_args(body)
    session = _call_discuss(start_session, root, note_path, note_content, kind="second-brain",
                             provider=provider, model=model, effort=effort, repo_root=get_active_repo_root(),
                             grep_dirs=get_active_grep_dirs(), instances_dir=instances_dir())
    return jsonify(session)


def _resolve_discuss_session(session_id):
    """Discuss sessions live in one of two storage locations depending on where the
    conversation started -- pipeline_dir for a brain-dump entry OR a held
    queue/needs-clarification/ task, SECOND_BRAIN_DIR for a vault note (see
    discuss_sessions.py's own header). Session ids are already globally unique (uuid4
    suffix), so trying both known locations here is simpler and more honest than
    threading a kind-prefix through every session id just to route this lookup.

    Two kinds now share pipeline_dir storage (brain-dump entries and held tasks), so
    storage location alone can no longer disambiguate them the way it still can for a
    vault note -- the session's own "kind" field (set at start_session time) is what
    actually decides the return value; falls back to "brain-dump" for a pipeline_dir
    session with no kind at all (sessions written before the needs-clarification kind
    existed), preserving old behavior for anything already in flight.

    Returns (kind, storage_dir, session), or (None, None, None) if the session isn't in
    either location."""
    from discuss_sessions import get_session
    pipeline_dir = get_pipeline_dir()
    if pipeline_dir:
        session = get_session(pipeline_dir, session_id)
        if session:
            return session.get("kind") or "brain-dump", pipeline_dir, session
    root = second_brain_dir()
    if root:
        session = get_session(root, session_id)
        if session:
            return "second-brain", root, session
    return None, None, None


@app.route("/api/discuss/<session_id>/message", methods=["POST"])
def api_discuss_message(session_id):
    kind, storage_dir, existing = _resolve_discuss_session(session_id)
    if not storage_dir:
        abort(404)
    body = request.get_json(silent=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        abort(400, description="message is required")
    from discuss_sessions import send_message
    session = _call_discuss(send_message, storage_dir, session_id, message)
    if not session:
        abort(404)
    return jsonify(session)


@app.route("/api/discuss/<session_id>", methods=["GET"])
def api_discuss_get(session_id):
    kind, storage_dir, session = _resolve_discuss_session(session_id)
    if not session:
        abort(404)
    return jsonify(session)


@app.route("/api/discuss/<session_id>/end", methods=["POST"])
def api_discuss_end(session_id):
    """Ends the conversation and, if it produced a real summary, applies it to whatever
    it was discussing:
    - brain-dump entry: appended to rawText, reusing PUT /api/brain-dump/<id>'s own
      sorted->captured reset logic (a discussion that adds real context is exactly the
      kind of text change that should make a stale prior sort get re-evaluated).
    - vault note: appended as a "## Discuss session -- <date>" section, same convention
      grill_sessions.py's enrich_note() already uses for Grill Me/Grill With Docs.
    - held queue/needs-clarification/ task: appended to promptContext.rawText, AND
      reopened for another path_prefetch_resolve attempt (suggestionAttempted cleared,
      any stale suggestion dropped) -- per the actual ask: discussing a held task should
      leave you with a real shot at an automatic resolution, not just more text sitting
      next to the same manual picker you started with.
    discuss_sessions.py deliberately never touches any of these data stores itself --
    this is the one place that happens, same division of responsibility as every other
    mutation of any of them in this file."""
    kind, storage_dir, existing = _resolve_discuss_session(session_id)
    if not storage_dir:
        abort(404)
    from discuss_sessions import end_session
    session = _call_discuss(end_session, storage_dir, session_id)
    if not session:
        abort(404)

    entry = None
    note_updated = False
    held_task = None
    summary = (session.get("summary") or "").strip()
    if summary and kind == "brain-dump":
        entries = read_brain_dump_entries()
        entry = next((e for e in entries if e.get("id") == session["subjectId"]), None)
        if entry:
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            entry["rawText"] = f"{entry['rawText']}\n\n[Discussed {stamp}]: {summary}"
            if entry.get("status") == "sorted":
                entry["status"] = "captured"
                entry.pop("sort", None)
            entry["editedAt"] = datetime.now(timezone.utc).isoformat()
            write_brain_dump_entries(entries)
    elif summary and kind == "second-brain":
        root = second_brain_dir()
        if root:
            note_path = _resolve_under_second_brain(root.resolve(), session["subjectId"])
            if note_path.is_file():
                stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                entry_text = f"\n\n## Discuss session -- {stamp}\n\n{summary}\n"
                note_path.write_text(note_path.read_text(encoding="utf-8") + entry_text, encoding="utf-8")
                note_updated = True
    elif summary and kind == "needs-clarification":
        qdir = queue_dir()
        if qdir:
            held_path = qdir / "needs-clarification" / f"{session['subjectId']}.json"
            held_task = read_json_safe(held_path)
            if held_task:
                stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                ctx = held_task.setdefault("promptContext", {})
                ctx["rawText"] = f"{ctx.get('rawText', '')}\n\n[Discussed {stamp}]: {summary}"
                nc = held_task.setdefault("needsClarification", {})
                if nc.get("reason") == "design-decision":
                    # 2026-08-24 (adhoc-agentic-draft.js's RESOLUTION: needs-human-
                    # decision): a real product/design question, not path_prefetch_
                    # resolve's ambiguous-file-path picker -- this task never had
                    # suggested/suggestionAttempted/highReasoningAttempted/attempt in the
                    # first place, so touching those fields would just fabricate a shape
                    # nothing else here ever wrote. The discussion is already folded into
                    # promptContext.rawText above; the task stays in needs-clarification/
                    # exactly as-is, ready for the existing generic /resolve endpoint
                    # (already reused unchanged) to send it to queue/adhoc/ for a fresh
                    # agentic draft once a human decides it's ready.
                    pass
                else:
                    nc.pop("suggested", None)
                    nc["suggestionAttempted"] = False
                    # Brain Dump #77: reset alongside suggestionAttempted so a human-
                    # reopened task gets a fresh automatic low-then-high reasoning pair
                    # again, not just the low tier (see task-sources.js's
                    # nextPathPrefetchResolveTask()).
                    nc["highReasoningAttempted"] = False
                    # Bumped so nextPathPrefetchResolveTask()'s resolve-task id includes
                    # the attempt number -- without this, a second attempt's id collides
                    # with the first attempt's now-done/ file forever (taskIdExistsInQueue()
                    # checks done/ too), silently blocking every re-attempt after Discuss.
                    nc["attempt"] = nc.get("attempt", 1) + 1
                held_path.write_text(json.dumps(held_task, indent=2), encoding="utf-8")

    return jsonify({"session": session, "entry": entry, "noteUpdated": note_updated, "heldTask": held_task})


# Chat panel (Brain Dump #153, Grimmethy: "a hideable panel on the right side of the app
# for a conversational AI... make edits to the system... the ghost in the machine" --
# renamed to "Chat Panel" per Grimmethy's later request; original brain-dump text quoted
# verbatim, unchanged) -- deliberately NOT built on _call_discuss/discuss_sessions.py's
# shape: see chat_sessions.py's own header for why this is a global, persistent,
# real-Edit/Write/Bash-capable conversation instead of Discuss's per-subject, read-only one.

def _call_chat(fn, *args, **kwargs):
    """Same reasoning as _call_discuss -- turn a known, actionable failure into a clean
    4xx/5xx instead of a raw 500. Local-provider tool loops and Claude calls can both fail
    the same ways Discuss's already do (auth missing, Ollama busy/timed out)."""
    from claude_client import ClaudeClientError
    from local_tool_client import LocalToolClientError
    try:
        return fn(*args, **kwargs)
    except ClaudeClientError as e:
        abort(502, description=str(e))
    except LocalToolClientError as e:
        abort(502, description=str(e))
    except (TimeoutError, ConnectionError, OSError) as e:
        abort(502, description=f"local model call failed ({e}) -- it may be busy with an active worker-lane task; try again shortly.")


# 2026-08-31 (Grimmethy: "It should be rooted in agent manager always, and have access to
# all active plugins"): the Chat panel is system-wide, not per-project. Its transcript
# store is fixed at the agent-manager repo root, and its file tools span agent-manager
# plus every registered plugin/project repo -- NOT whatever project the pipeline happens
# to be pointed at.
CHAT_STORAGE_DIR = PACKAGE_ROOT


def _chat_roots() -> list:
    """Ordered, deduped, existing-on-disk list of every repo the Chat panel can touch.
    roots[0] is always the agent-manager repo (primary / cwd); the rest are each enabled
    plugin's repo (dirname of its register.js) and each projects.json repoRoot. A fresh
    clone with no plugins.json / projects.json just yields [agent-manager]."""
    raw = [str(PACKAGE_ROOT)]
    for e in _read_plugins_manifest():
        rp = e.get("registerPath")
        if rp and e.get("enabled") is not False:
            raw.append(os.path.dirname(rp))
    for e in read_project_registry():
        if e.get("repoRoot"):
            raw.append(e["repoRoot"])
    seen, out = set(), []
    for p in raw:
        try:
            real = os.path.realpath(p)
        except OSError:
            continue
        if real not in seen and os.path.isdir(real):
            seen.add(real)
            out.append(real)
    return out or [os.path.realpath(str(PACKAGE_ROOT))]


@app.route("/api/chat/active", methods=["GET"])
def api_chat_active():
    """Loads (or creates, if none exists yet) the single ongoing system-wide
    conversation -- called on dashboard load so the panel shows where you left off."""
    from chat_sessions import get_active_session, PROVIDER_LOCAL
    session = _call_chat(get_active_session, CHAT_STORAGE_DIR, _chat_roots(),
                           instances_dir(), provider=PROVIDER_LOCAL)
    return jsonify(session)


@app.route("/api/chat/new", methods=["POST"])
def api_chat_new():
    """Starts a fresh conversation, ending whatever's currently active. Body:
    {provider?, model?, effort?} -- same _discuss_provider_args fallback (local by
    default) every other Discuss-family start route already uses."""
    from chat_sessions import start_new_conversation
    provider, model, effort = _discuss_provider_args()
    session = _call_chat(start_new_conversation, CHAT_STORAGE_DIR, _chat_roots(),
                           instances_dir(), provider=provider, model=model, effort=effort)
    return jsonify(session)


@app.route("/api/chat/inject", methods=["POST"])
def api_chat_inject():
    """Appends a chunk of text as a user message into a dashboard chat session for
    follow-up -- the single endpoint the dashboard's "Send to chat" buttons (task
    detail, Brain Dump) POST the task log / brain-dump text to. It only RECORDS the
    user turn (persisted, visible in the panel); it deliberately does NOT call the
    model -- the user reads the injected context and then sends their own follow-up
    question via the normal /api/chat/<session_id>/message route.

    Body: {text: string, sessionId?: string}. Without sessionId: the currently active
    session is used (get_active_session creates one if none exists yet, matching what
    /api/chat/active does on panel load); if that still yields nothing a brand-new
    conversation is started. Either way the resulting session id comes back in the
    response so the button's caller can link back to it."""
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        abort(400, description="text is required")

    from chat_sessions import get_active_session, get_session, inject_user_message
    from chat_sessions import start_new_conversation, PROVIDER_LOCAL

    session_id = (body.get("sessionId") or "").strip()
    if session_id:
        existing = get_session(CHAT_STORAGE_DIR, session_id)
        if not existing or existing.get("status") != "active":
            abort(404, description="no active chat session with that id")
    else:
        session = _call_chat(get_active_session, CHAT_STORAGE_DIR, _chat_roots(),
                             instances_dir(), provider=PROVIDER_LOCAL)
        session_id = (session or {}).get("id") or (session or {}).get("session_id")
        if not session_id:
            provider, model, effort = _discuss_provider_args()
            session = _call_chat(start_new_conversation, CHAT_STORAGE_DIR, _chat_roots(),
                                 instances_dir(), provider=provider, model=model, effort=effort)
            session_id = (session or {}).get("id") or (session or {}).get("session_id")
        if not session_id:
            abort(500, description="could not resolve or start a chat session")

    injected = _call_chat(inject_user_message, CHAT_STORAGE_DIR, session_id, text)
    if not injected:
        abort(404, description="no active chat session with that id")
    return jsonify({"session": injected, "sessionId": injected.get("id") or session_id})


# --- Chat "make GPU space" preemption (brain dump #5) ----------------------------------
# The Chat panel is for live repo investigation and shares the one resident local model
# with the pipeline's worker/reviewer lanes on the same single-flight lock. When they're
# busy a chat turn can sit in `flock -w 600` for many minutes. Holding the lock (the
# Reserve feature) doesn't interrupt an in-flight call -- only killing the in-flight
# `local-draft.js` / `review-task.js` child frees the GPU now. On every local-provider
# chat message we kill BOTH worker lanes' in-flight draft outright -- chat takes priority
# over the pipeline, full stop (2026-09-02, Grimmethy: "Chat should preclude workers").
# Only the `reviewer` stays age-gated (a review vote is short; and a chat turn that lands
# just as a vote completes gains little by killing it). Set
# AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING=true to go back to sparing a
# worker-reasoning agentic draft older than AGENT_MANAGER_CHAT_PREEMPT_REASONING_MAX_AGE_S.
# A killed worker task is `mv`'d drafting/ -> pending/ first so no retry budget is burnt;
# the daemons treat the empty child result as a retryable failed call
# (scripts/local-worker.sh:239-434) and recover on their own next tick.

_PREEMPT_LANES_ALWAYS = ("worker-1", "worker-reasoning")
_PREEMPT_LANES_AGE_GATED = ("reviewer",)
# instances/<lane>.json currentPass values in which the heartbeat `pid` is the node
# child (local-draft.js / review-task.js), NOT the bash daemon -- safe to signal. The
# `int(hb["pid"]) != daemon_pid` guard below is the real safety net; this just filters out
# `idle`/`claim`/`starting`.
_PREEMPT_CHILD_PASSES = frozenset({
    "plan", "implement", "implement-retry", "critique", "revise",
    "harness-search", "local-agentic", "local-agentic-write", "vote", "review",
})
# Prefixes for the adhoc agentic-draft family (local-draft.js's maybeLocked labels:
# local-agentic, local-agentic-write, local-agentic-test-*). Matched by prefix so a new
# tier label can't silently drop out of preemption again -- 2026-09-02, worker-reasoning
# held the GPU 12 min in `local-agentic-write` (missing from the set above) while a chat
# turn blocked, because the exact-match check skipped it entirely.
_PREEMPT_CHILD_PASS_PREFIXES = ("local-agentic", "harness-search")
_MODEL_INFLIGHT_STALE_S = 300  # mirrors src/model-inflight-lock.js STALE_MS


def _is_preemptable_child_pass(pass_name) -> bool:
    if not pass_name:
        return False
    return pass_name in _PREEMPT_CHILD_PASSES or pass_name.startswith(_PREEMPT_CHILD_PASS_PREFIXES)


def _chat_preempt_enabled() -> bool:
    v = (os.environ.get("AGENT_MANAGER_CHAT_PREEMPT")
         or read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_CHAT_PREEMPT") or "true")
    return str(v).strip().lower() not in ("0", "false", "no", "off")


def _chat_preempt_max_age_s() -> int:
    v = (os.environ.get("AGENT_MANAGER_CHAT_PREEMPT_REASONING_MAX_AGE_S")
         or read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_CHAT_PREEMPT_REASONING_MAX_AGE_S"))
    try:
        return max(0, int(str(v).strip()))
    except (TypeError, ValueError):
        return 180


def _preempt_spare_long_reasoning() -> bool:
    """Opt back in to the old behaviour: spare a worker-reasoning agentic draft that has
    been running longer than the max-age. Off by default -- chat precludes workers."""
    v = (os.environ.get("AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING")
         or read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING") or "false")
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _preempt_lane_sets():
    """(always_kill, age_gated) lane tuples for this chat turn. worker-reasoning is
    always-kill unless AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING opts it back into
    age-gating."""
    if _preempt_spare_long_reasoning():
        return ("worker-1",), ("worker-reasoning", "reviewer")
    return _PREEMPT_LANES_ALWAYS, _PREEMPT_LANES_AGE_GATED


def _preempt_decision(lane, kill_pid, started_epoch, now, max_age_s, always=None):
    """Pure. -> (action, reason). action in {"kill", "spare", "skip"}.
    kill_pid: the resolved in-flight node child pid (or None). started_epoch: unix time
    the call/task started (or None = age unknown). `always`: whether this lane is
    unconditionally preempted -- defaults to membership in _PREEMPT_LANES_ALWAYS (the
    static default set) when not passed, so existing callers/tests keep working."""
    if always is None:
        always = lane in _PREEMPT_LANES_ALWAYS
    if not kill_pid:
        return ("skip", "no in-flight model call")
    if always:
        return ("kill", "always")
    if started_epoch is None:
        return ("spare", "age unknown")
    age = now - started_epoch
    if age < max_age_s:
        return ("kill", f"{int(age)}s old (< {max_age_s}s)")
    return ("spare", f"{int(age)}s old")


def _read_fresh_model_locks(inst_dir: Path) -> dict:
    """{instanceId: {pid, startedAt}} for every non-stale entry in instances/.model-locks/
    -- mirrors src/model-inflight-lock.js readActiveLocks()."""
    out = {}
    d = inst_dir / ".model-locks"
    try:
        names = [f for f in os.listdir(d) if f.endswith(".json")]
    except OSError:
        return out
    now = time.time()
    for name in names:
        fp = d / name
        try:
            if now - fp.stat().st_mtime > _MODEL_INFLIGHT_STALE_S:
                continue
            data = read_json_safe(fp)
        except OSError:
            continue
        if data and data.get("instanceId") and data.get("pid"):
            out[data["instanceId"]] = data
    return out


def _arbiter_cancel_below(cls: str = "interactive") -> list:
    """Ask the GPU arbiter (src/gpu-arbiter.js, via its CLI) to cancel every ticket below
    `cls` -- the worker draft lanes. The arbiter marks each cancelRequested and SIGKILLs
    any active holder; the worker daemon requeues its task. Replaces the old
    heartbeat/pidfile/mtime reconstruction for the worker lanes. Best-effort."""
    cli = PACKAGE_ROOT / "scripts" / "gpu-arbiter-cli.js"
    if not cli.is_file():
        return []
    try:
        cp = subprocess.run(
            ["node", str(cli), "cancel-below", "--cls", cls],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, **read_env_file(ENV_FILE_PATH)},
        )
        rows = json.loads((cp.stdout or "[]").strip() or "[]")
        return [{"lane": r.get("cls"), "action": r.get("action"),
                 "taskId": r.get("taskId"), "ageSeconds": None} for r in rows]
    except Exception as e:  # noqa: BLE001 -- best-effort, never block a chat turn
        print(f"[chat-preempt] arbiter cancel-below failed (non-fatal): {e}", file=sys.stderr, flush=True)
        return []


def _preempt_pipeline_for_chat() -> list:
    """Free the local model for a chat turn. Worker draft lanes go through the GPU arbiter
    now -- one cancel-below call. The reviewer is not on the arbiter yet, so it keeps the
    age-gated legacy kill below. Best-effort throughout. Returns [{lane, action, taskId,
    ageSeconds}]."""
    if os.name == "nt":
        return []
    inst_dir = instances_dir()
    qdir = queue_dir()
    if not inst_dir or not inst_dir.is_dir():
        return []

    summary = _arbiter_cancel_below("interactive")

    pids_dir = Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/pids"
    locks = _read_fresh_model_locks(inst_dir)
    max_age = _chat_preempt_max_age_s()
    _, age_gated_lanes = _preempt_lane_sets()
    now = time.time()

    # Only the reviewer stays on this legacy heartbeat-based path -- the worker draft lanes
    # were handled by _arbiter_cancel_below above. (age_gated_lanes is ('reviewer',).)
    for lane in age_gated_lanes:
        try:
            hb = read_json_safe(inst_dir / f"{lane}.json") or {}
            lock = locks.get(lane)

            kill_pid = None
            started_epoch = None
            if lock:
                try:
                    kill_pid = int(lock.get("pid"))
                except (TypeError, ValueError):
                    kill_pid = None
                sdt = parse_hb_timestamp(lock.get("startedAt"))
                started_epoch = sdt.timestamp() if sdt else None
            if kill_pid is None and hb.get("status") in ("working", "queued") \
                    and _is_preemptable_child_pass(hb.get("currentPass")) and hb.get("pid"):
                daemon_pid = None
                try:
                    daemon_pid = int((pids_dir / f"{lane}.pid").read_text().strip())
                except (OSError, ValueError):
                    pass
                if daemon_pid is None or int(hb["pid"]) != daemon_pid:
                    kill_pid = int(hb["pid"])

            task_id = hb.get("currentTaskId")
            # For an age-gated lane with no fresh model-lock, fall back to the task JSON's
            # claimedAt, then its mtime (a conservative lower bound on task age).
            if started_epoch is None and lane in age_gated_lanes and task_id and qdir:
                tf = qdir / "drafting" / lane / f"{task_id}.json"
                try:
                    tdata = read_json_safe(tf) or {}
                    cdt = parse_hb_timestamp(tdata.get("claimedAt"))
                    started_epoch = cdt.timestamp() if cdt else tf.stat().st_mtime
                except OSError:
                    pass

            action, reason = _preempt_decision(lane, kill_pid, started_epoch, now, max_age,
                                               always=False)  # reviewer only -- always age-gated
            age_s = int(now - started_epoch) if started_epoch else None

            if action != "kill":
                if kill_pid:
                    summary.append({"lane": lane, "action": action, "taskId": task_id, "ageSeconds": age_s})
                print(f"[chat-preempt] {lane}: {action} ({reason})", file=sys.stderr, flush=True)
                continue

            # Requeue the worker task before signalling (zero retry-budget cost); the
            # reviewer keeps its task in queue/review/ and is re-reviewed next tick.
            if lane != "reviewer" and task_id and qdir:
                src = qdir / "drafting" / lane / f"{task_id}.json"
                dst = qdir / "pending" / f"{task_id}.json"
                try:
                    if src.is_file() and not dst.exists():
                        os.replace(src, dst)
                except OSError:
                    pass

            try:
                os.kill(kill_pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            if lock:
                for name in os.listdir(inst_dir / ".model-locks"):
                    try:
                        lp = inst_dir / ".model-locks" / name
                        d = read_json_safe(lp) or {}
                        if d.get("pid") == kill_pid:
                            lp.unlink()
                    except OSError:
                        pass

            summary.append({"lane": lane, "action": "killed", "taskId": task_id, "ageSeconds": age_s})
            print(f"[chat-preempt] killed {lane} pid={kill_pid} task={task_id} ({reason}) -> requeued",
                  file=sys.stderr, flush=True)
        except Exception as e:  # noqa: BLE001 -- best-effort, never block the chat turn
            print(f"[chat-preempt] {lane}: skipped ({e})", file=sys.stderr, flush=True)
    return summary


@app.route("/api/chat/<session_id>/message", methods=["POST"])
def api_chat_message(session_id):
    """The actual chat turn.

    2026-08-24 -- this used to wrap the WHOLE call in the same git-safety mutex the
    merge-branch endpoint uses (_acquire_apply_lock/_release_apply_lock,
    app.py:3979-3999). Caught live within minutes of shipping: a local-provider turn can
    legitimately wait minutes just for the GPU lock (a busy worker lane), and held the
    apply-lock that entire time even though most turns never touch git at all -- a second,
    completely unrelated Chat message (or a real click from Grimmethy, confirmed live)
    got "the pipeline is mid-apply right now" while nothing was actually applying,
    because THIS request was sitting on the mutex for no reason. Exactly the lesson
    single-flight-lock.js's own header already documents from an earlier incident:
    holding a lock across a call's ENTIRE span instead of just the piece that needs it
    turns a narrow, real protection into broad, needless contention.

    Fix: git safety now lives at the point a git-mutating command actually runs, not
    here. local-tool-client.js's runBashTool acquires the SAME apply-task.lock (flock,
    cross-language-compatible, same file apply-task.sh/api_git_merge_branch already use)
    for just the span of each individual command -- see that function's own comment.
    Claude's own Edit/Write/Bash tool calls happen inside the `claude` CLI's own internal
    tool loop, which this codebase has no hook into at the per-call level, so they are
    NOT covered by this -- a known, real, narrower gap (git's own index.lock still turns
    a genuine collision into a clean failure to retry, not silent corruption) rather than
    a solved one; revisit if it causes a real incident."""
    body = request.get_json(silent=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        abort(400, description="message is required")

    from chat_sessions import get_session
    existing = get_session(CHAT_STORAGE_DIR, session_id)
    if not existing or existing.get("status") != "active":
        abort(404)

    # 2026-08-26 (Open WebUI investigation, Grimmethy: "vastly improve the chat
    # system... streaming"): this used to be a single blocking send_message() call
    # returning the whole updated session as one JSON body -- the user stared at nothing
    # until the model finished (or the turn budget ran out), which is exactly why the
    # "ran out of its turn budget" explainer had to exist in the first place. Now
    # streamed as SSE: one `data:` frame per {"type":"chunk"} as text arrives, then one
    # {"type":"final","session":{...}} carrying the same shape this route used to return
    # in one shot, so the frontend still ends up with the same authoritative session.
    from chat_sessions import stream_message, PROVIDER_LOCAL
    from claude_client import ClaudeClientError
    from local_tool_client import LocalToolClientError
    import single_flight_lock

    is_local_turn = existing.get("provider") == PROVIDER_LOCAL
    inst_dir = instances_dir()

    # Make GPU space for a local-provider turn: kill both worker lanes' in-flight draft
    # (chat precludes workers), the reviewer's only if < ~3 min in. Synchronous, before the
    # SSE generator / node child runs. Claude-provider turns don't touch the local model.
    preempted = []
    if is_local_turn and _chat_preempt_enabled():
        try:
            preempted = _preempt_pipeline_for_chat()
        except Exception as e:  # noqa: BLE001 -- never block a chat turn on this
            print(f"[chat-preempt] failed (non-fatal): {e}", file=sys.stderr, flush=True)

    def generate():
        # Priority marker held for the WHOLE turn (model call + every tool-loop iteration in
        # the node child) and kept fresh by priority_marker's own daemon thread, so worker/
        # reviewer acquire() keeps yielding the GPU the entire time -- not just the ~8s the
        # bare marker used to cover. Killing a worker (above) only frees the GPU for an
        # instant; without this the worker daemon respawns and reclaims it between the
        # chat's tool-loop turns, and the turn starves with no output (confirmed live
        # 2026-09-02). Inside generate() so its teardown is bound to the SSE generator's
        # lifecycle (client disconnect -> GeneratorExit -> finally).
        marker_cm = (single_flight_lock.priority_marker(inst_dir)
                     if (is_local_turn and inst_dir) else contextlib.nullcontext())
        with marker_cm:
            if preempted:
                yield f"data: {json.dumps({'type': 'preempt', 'lanes': preempted})}\n\n"
            try:
                for event in stream_message(CHAT_STORAGE_DIR, session_id, message):
                    yield f"data: {json.dumps(event)}\n\n"
            except ClaudeClientError as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
            except LocalToolClientError as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
            except (TimeoutError, ConnectionError, OSError) as e:
                yield f"data: {json.dumps({'type': 'error', 'error': f'local model call failed ({e}) -- it may be busy with an active worker-lane task; try again shortly.'})}\n\n"

    # Reserved sessions refresh their own idle clock on every real message -- same
    # liveness-refresh shape a worker instance's own heartbeat already follows.
    with _chat_reservations_lock:
        if session_id in _chat_reservations:
            _chat_reservations[session_id]["lastActivity"] = time.time()

    return Response(stream_with_context(generate()), mimetype="text/event-stream")


@app.route("/api/chat/<session_id>/reserve", methods=["POST"])
def api_chat_reserve(session_id):
    """Toggles "fully reserving the reasoning model" (Brain Dump #153) for this session --
    holding the reasoning model's own per-model lock (instances/.pipeline-single-flight.
    <model>.lock -- see single_flight_lock.py's own header for the 2026-08-25 per-model
    keying this relies on) across turns, not just for the span of one call. Since
    2026-08-25 this only idles whatever else is contending for THAT specific model
    (worker-reasoning, local-tool-client.js's arch_discovery/Chat-with-tools calls,
    Discuss's local provider) -- a cheap-model lane like worker-1's brain_dump_sort
    traffic keeps running unaffected, unlike before this locking was split per-model.
    Body: {on: bool}. Only meaningful for the local provider (Claude has no shared-
    resource lock, per the earlier decision not to lock Claude calls against each
    other)."""
    from chat_sessions import get_session, set_reserved, PROVIDER_LOCAL
    import single_flight_lock

    session = get_session(CHAT_STORAGE_DIR, session_id)
    if not session:
        abort(404)
    if session.get("provider") != PROVIDER_LOCAL:
        abort(400, description="reservation only applies to the local provider")

    body = request.get_json(silent=True) or {}
    want_on = bool(body.get("on"))

    # single_flight_lock.acquire() BLOCKS (it's the real GPU/model mutex, can wait as
    # long as a worker lane's current call takes) -- must never be called while holding
    # _chat_reservations_lock, or every other Chat request (another session's own
    # message, another reserve toggle) would stall for the same duration. Two short,
    # separate critical sections instead: check-and-claim first, do the real (possibly
    # slow) acquire/release outside the lock, then record the result.
    with _chat_reservations_lock:
        already_on = session_id in _chat_reservations
        claiming = want_on and not already_on
        releasing_record = _chat_reservations.pop(session_id) if (not want_on and already_on) else None
        if claiming:
            # Reserve the dict slot now (before the blocking acquire below) so a second,
            # concurrent toggle-on request for the SAME session can't also start
            # acquiring -- filled in with the real fh once acquire() returns.
            _chat_reservations[session_id] = {"fh": None, "lastActivity": time.time(), "storageDir": CHAT_STORAGE_DIR}

    if releasing_record is not None:
        single_flight_lock.release(releasing_record["fh"])
    if claiming:
        inst_dir = instances_dir()
        if not inst_dir:
            with _chat_reservations_lock:
                _chat_reservations.pop(session_id, None)
            abort(500, description="no active project's instances dir resolvable")
        import ollama_client
        fh = single_flight_lock.acquire(inst_dir, ollama_client.MODEL)  # blocking -- may wait for a worker lane's current call on this same model
        with _chat_reservations_lock:
            _chat_reservations[session_id] = {"fh": fh, "lastActivity": time.time(), "storageDir": CHAT_STORAGE_DIR}

    session = set_reserved(CHAT_STORAGE_DIR, session_id, want_on)
    return jsonify(session)


def _resolve_under_second_brain(root: Path, raw_path: str) -> Path:
    """Resolves raw_path against root, rejecting anything that escapes it (../ traversal,
    an absolute path elsewhere, a symlink pointing out). Unlike /api/browse (which
    intentionally allows roaming the whole filesystem, for the Project tab's repo picker),
    this only ever exposes one directory tree -- personal notes, not arbitrary disk
    contents -- so the jail is load-bearing, not optional."""
    candidate = (root / raw_path).resolve() if raw_path else root
    if candidate != root and root not in candidate.parents:
        abort(403, description="path escapes SECOND_BRAIN_DIR")
    return candidate


@app.route("/api/second-brain/browse")
def api_second_brain_browse():
    root = second_brain_dir()
    if not root:
        return jsonify({"path": "", "parent": None, "entries": [], "configured": False})
    root = root.resolve()

    raw_path = request.args.get("path", "").strip()
    target = _resolve_under_second_brain(root, raw_path)
    if not target.is_dir():
        abort(404)

    project_links = read_project_links()
    active_repo_root = get_active_repo_root()

    entries = []
    try:
        for child in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            try:
                is_dir = child.is_dir()
                # Population count: direct children only (files + subfolders), not a deep
                # recursive total -- matches what a folder's own name badge should mean
                # ("what's immediately in here"), and stays cheap even on a large vault.
                # None (not 0) on a permission error so the frontend can tell "empty" apart
                # from "couldn't read it" rather than silently showing a wrong zero.
                count = None
                if is_dir:
                    try:
                        count = sum(1 for _ in child.iterdir())
                    except (PermissionError, OSError):
                        count = None
                # .as_posix(), not str() -- these paths round-trip through JSON to the
                # frontend, which splits on '/' (see the "jump to file" handler in
                # index.html). str() on Windows would emit '\\', silently breaking that.
                rel_path = child.relative_to(root).as_posix()
                repo_path = project_links.get(rel_path)
                entries.append({
                    "name": child.name,
                    "path": rel_path,
                    "isDir": is_dir,
                    "count": count,
                    "repoPath": repo_path,
                    "isActiveProject": bool(repo_path) and bool(active_repo_root) and Path(repo_path) == Path(active_repo_root),
                })
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError) as e:
        abort(403, description=str(e))

    rel = "" if target == root else target.relative_to(root).as_posix()
    # target.parent.relative_to(root).as_posix() would give "." for a one-level-deep
    # directory (its parent IS root) -- Path('.').as_posix() is '.', not '', which would
    # round-trip back through the jail check as a non-empty raw_path instead of "go to
    # root". Normalizing here keeps "up" from root's immediate children correct.
    parent = None if target == root else ("" if target.parent == root else target.parent.relative_to(root).as_posix())
    return jsonify({"path": rel, "parent": parent, "entries": entries, "configured": True})


@app.route("/api/second-brain/sync-github-projects", methods=["POST"])
def api_second_brain_sync_github_projects():
    """Ensures every git repo directly under GITHUB_PROJECTS_ROOT has a reference note
    under Projects/GitHub/ in the second brain, so every GitHub project is navigable from
    there (the actual ask: "All github projects should be referenced in Second Brain").
    Idempotent and non-destructive -- only CREATES a note when one doesn't already exist
    at that path; never overwrites something already there, so any personal notes/edits
    a user has since added to a repo's note are never touched by re-running this."""
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")

    repos = discover_github_repos()
    projects_dir = root / "Projects" / "GitHub"
    projects_dir.mkdir(parents=True, exist_ok=True)

    links = read_project_links()
    created = []
    for repo in repos:
        note_rel = f"Projects/GitHub/{repo['name']}.md"
        note_path = root / note_rel
        if not note_path.exists():
            note_path.write_text(
                f"# {repo['name']}\n\n**Repo path:** `{repo['path']}`\n",
                encoding="utf-8",
            )
            created.append(repo["name"])
        links[note_rel] = repo["path"]

    write_project_links(links)
    return jsonify({"synced": len(repos), "created": created, "totalLinked": len(links)})


@app.route("/api/second-brain/projects", methods=["GET"])
def api_second_brain_projects():
    """Projects referenced in the second brain (Projects/GitHub/*.md, built by
    sync-github-projects) for the Project tab's project dropdown. Falls back to a live
    filesystem scan (discover_github_repos) when the link index is empty/missing -- e.g.
    sync has never been run -- so the dropdown isn't stuck empty on a fresh install."""
    links = read_project_links()
    if links:
        projects = [
            {"name": Path(note_rel).stem, "path": repo_path}
            for note_rel, repo_path in links.items()
        ]
    else:
        projects = discover_github_repos()
    projects.sort(key=lambda p: p["name"].lower())
    return jsonify({"projects": projects})


@app.route("/api/second-brain/grill/for-note", methods=["GET"])
def api_second_brain_grill_for_note():
    """Most recent existing session for this note, so the frontend can surface
    already-completed-but-un-enriched (or still-active) work instead of silently letting
    Grill Me start a fresh session next to it every time the note is reopened."""
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    note_path = (request.args.get("notePath") or "").strip()
    if not note_path:
        abort(400, description="notePath is required")
    from grill_sessions import latest_session_for_note
    session = latest_session_for_note(root, note_path)
    return jsonify(session)


@app.route("/api/second-brain/grill/start", methods=["POST"])
def api_second_brain_grill_start():
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    body = request.get_json(silent=True) or {}
    note_path = (body.get("notePath") or "").strip()
    mode = body.get("mode")
    source_url = body.get("sourceUrl")
    if not note_path or mode not in ("grill-me", "grill-with-docs"):
        abort(400, description="notePath and a valid mode ('grill-me' or 'grill-with-docs') are required")
    from grill_sessions import start_session
    session = start_session(root, note_path, mode, source_url)
    return jsonify(session)


@app.route("/api/second-brain/grill/<session_id>/answer", methods=["POST"])
def api_second_brain_grill_answer(session_id):
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    body = request.get_json(silent=True) or {}
    answer = (body.get("answer") or "").strip()
    if not answer:
        abort(400, description="answer is required")
    from grill_sessions import submit_answer
    session = submit_answer(root, session_id, answer)
    if not session:
        abort(404)
    return jsonify(session)


@app.route("/api/second-brain/grill/<session_id>", methods=["GET"])
def api_second_brain_grill_get(session_id):
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    from grill_sessions import get_session
    session = get_session(root, session_id)
    if not session:
        abort(404)
    return jsonify(session)


@app.route("/api/second-brain/grill/<session_id>/enrich", methods=["POST"])
def api_second_brain_grill_enrich(session_id):
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    from grill_sessions import enrich_note
    session = enrich_note(root, session_id)
    if not session:
        abort(404, description="session not found or not complete")
    return jsonify(session)


def _slugify_project_name(stem: str) -> str:
    """Note filename (no .md) -> filesystem/repo-friendly name: spaces to hyphens, strip
    anything that isn't alphanumeric/hyphen/underscore. Deliberately NOT lowercased --
    the real GitHub folders already mix casing (TaxHarvest-GrimmethyLocal, SGCElementals),
    so forcing one convention here would look inconsistent next to them."""
    name = stem.replace(" ", "-")
    name = re.sub(r"[^A-Za-z0-9_-]", "", name)
    return name.strip("-_") or "untitled-project"


@app.route("/api/second-brain/create-github-project", methods=["POST"])
def api_second_brain_create_github_project():
    """Turns a Second Brain "project starter" note into a real GitHub project: a new repo
    directory under GITHUB_PROJECTS_ROOT, git-initialized, seeded with a README carrying
    the note's own content over as the starting point. Then links the note to that new
    repo the same way sync-github-projects links a discovered one, so it immediately gets
    the browse view's "Set Active"/"Active Project" treatment -- the actual ask: "turn
    these project starters into actual projects" via a button next to the note."""
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    root = root.resolve()

    body = request.get_json(silent=True) or {}
    note_rel = (body.get("notePath") or "").strip()
    if not note_rel:
        abort(400, description="notePath is required")
    note_path = _resolve_under_second_brain(root, note_rel)
    if not note_path.is_file():
        abort(404, description="note not found")

    links = read_project_links()
    if note_rel in links:
        abort(409, description=f"this note is already linked to {links[note_rel]}")

    project_name = _slugify_project_name(note_path.stem)
    repo_path = GITHUB_PROJECTS_ROOT / project_name
    if repo_path.exists():
        abort(409, description=f"{repo_path} already exists -- pick a different note name or remove it first")

    note_content = note_path.read_text(encoding="utf-8")

    try:
        repo_path.mkdir(parents=True)
        subprocess.run(["git", "init"], cwd=str(repo_path), capture_output=True, check=True, timeout=15)
        (repo_path / "README.md").write_text(note_content, encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=str(repo_path), capture_output=True, check=True, timeout=15)
        subprocess.run(
            ["git", "commit", "-m", f"Initial commit -- seeded from Second Brain note {note_rel}"],
            cwd=str(repo_path), capture_output=True, check=True, timeout=15,
        )
    except subprocess.CalledProcessError as e:
        # Best-effort cleanup on failure -- don't leave a half-initialized repo directory
        # behind that would then block a retry via the "already exists" check above.
        shutil.rmtree(repo_path, ignore_errors=True)
        detail = (e.stderr or b"").decode("utf-8", errors="replace").strip()
        abort(500, description=f"git setup failed: {detail or e}")
    except OSError as e:
        shutil.rmtree(repo_path, ignore_errors=True)
        abort(500, description=str(e))

    links[note_rel] = str(repo_path)
    write_project_links(links)

    return jsonify({"created": True, "repoPath": str(repo_path), "projectName": project_name})


@app.route("/api/second-brain/file")
def api_second_brain_file():
    root = second_brain_dir()
    if not root:
        abort(500, description="SECOND_BRAIN_DIR is not configured")
    root = root.resolve()

    raw_path = request.args.get("path", "").strip()
    if not raw_path:
        abort(400, description="path is required")
    target = _resolve_under_second_brain(root, raw_path)
    if not target.is_file():
        abort(404)
    try:
        content = target.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        abort(400, description=f"could not read file as text: {e}")
    return jsonify({"path": raw_path, "content": content})


@app.route("/api/deep-dive/projects")
def api_deep_dive_projects():
    """List tab for deep_dive (ADR-0019): every project-search lead that's been cloned
    and community-graphed so far, with a quick reviewed/total + action-item count so the
    list itself shows progress without opening each one."""
    cov_path = deep_dive_coverage_path()
    coverage = (read_json_safe(cov_path) if cov_path else None) or {}
    projects = coverage.get("projects", {})

    results = []
    for slug, proj in projects.items():
        communities = proj.get("communities") or []
        reviewed = sum(1 for c in communities if c.get("lastReviewedAt"))
        total_items = sum((c.get("actionItemCount") or 0) for c in communities if c.get("actionItemCount") is not None)
        results.append({
            "slug": slug,
            "sourceUrl": proj.get("sourceUrl"),
            "clonedAt": proj.get("clonedAt"),
            "communityCount": len(communities),
            "reviewedCount": reviewed,
            "totalActionItems": total_items,
            "hotlist": bool(proj.get("hotlist")),
        })
    # Hotlisted projects first (matches nextDeepDiveTask()'s own priority ordering in
    # task-sources.js -- see the hotlist sort there), alphabetical within each tier.
    results.sort(key=lambda r: (not r["hotlist"], r["slug"]))
    return jsonify(results)


@app.route("/api/deep-dive/projects/<slug>/hotlist", methods=["POST"])
def api_deep_dive_set_hotlist(slug):
    """Toggles a project onto/off the research priority list -- nextDeepDiveTask() reads
    this same field to draft every hotlisted project's remaining communities before any
    non-hotlisted one, regardless of how long they've been waiting in the normal
    oldest-first rotation (see task-sources.js)."""
    body = request.get_json(silent=True) or {}
    hotlist = bool(body.get("hotlist"))

    cov_path = deep_dive_coverage_path()
    if not cov_path:
        abort(404)
    coverage = read_json_safe(cov_path) or {"projects": {}}
    proj = coverage.get("projects", {}).get(slug)
    if not proj:
        abort(404, description=f"unknown project: {slug}")

    proj["hotlist"] = hotlist
    cov_path.write_text(json.dumps(coverage, indent=2), encoding="utf-8")
    return jsonify({"slug": slug, "hotlist": hotlist})


_DEEP_DIVE_ITEM_RE = re.compile(
    r"^## (?P<title>.+?)\s*\n\n"
    r"\*\*Community:\*\* (?P<community>.+?)\s*\n"
    r"\*\*Rating:\*\* (?P<rating>.+?)\s*\n"
    r"(?:\*\*Files:\*\* (?P<files>.+?)\s*\n)?"
    r"\n(?P<rationale>.*?)(?=\n## |\Z)",
    re.MULTILINE | re.DOTALL,
)
_COMMUNITY_ID_SUFFIX_RE = re.compile(r"^(?P<name>.*?)\s*\(community #(?P<id>\d+)\)\s*$")


def parse_deep_dive_analysis(analysis_text: str) -> list[dict]:
    """Splits analysis.md (apply-group-a.js's applyDeepDiveFindings own output format) into
    structured items so the dashboard can filter by the exact community a user clicked,
    rather than showing the whole file as one undifferentiated block. Items written before
    the "(community #N)" tagging was added (see apply-group-a.js) have communityId: null --
    the frontend falls back to matching those by community name alone, which is ambiguous
    when multiple communities share the same directory-based name but is still better than
    nothing for pre-existing entries."""
    items = []
    for m in _DEEP_DIVE_ITEM_RE.finditer(analysis_text or ""):
        community_raw = m.group("community").strip()
        id_match = _COMMUNITY_ID_SUFFIX_RE.match(community_raw)
        community_name = id_match.group("name") if id_match else community_raw
        community_id = int(id_match.group("id")) if id_match else None
        items.append({
            "title": m.group("title").strip(),
            "community": community_name,
            "communityId": community_id,
            "rating": m.group("rating").strip(),
            "files": (m.group("files") or "").strip() or None,
            "rationale": m.group("rationale").strip(),
        })
    return items


@app.route("/api/deep-dive/projects/<slug>")
def api_deep_dive_project_detail(slug):
    """Detail view: per-community review progress plus the actual write-up
    (UsefulProjectIndex/analysis/<slug>.md) apply-group-a.js's applyDeepDiveFindings
    appended -- this IS "what our workers picked from that repo," rendered as-is rather
    than re-parsed, since the markdown itself is already the operator-facing artifact."""
    cov_path = deep_dive_coverage_path()
    coverage = (read_json_safe(cov_path) if cov_path else None) or {}
    proj = coverage.get("projects", {}).get(slug)
    if not proj:
        abort(404)

    analysis_dir = deep_dive_analysis_dir()
    analysis_text = None
    if analysis_dir:
        analysis_path = analysis_dir / f"{slug}.md"
        if analysis_path.is_file():
            analysis_text = analysis_path.read_text(encoding="utf-8")

    return jsonify({
        "slug": slug,
        "sourceUrl": proj.get("sourceUrl"),
        "clonePath": proj.get("clonePath"),
        "clonedAt": proj.get("clonedAt"),
        "hotlist": bool(proj.get("hotlist")),
        "communities": proj.get("communities") or [],
        "analysisMarkdown": analysis_text,
        "items": parse_deep_dive_analysis(analysis_text) if analysis_text else [],
    })


@app.route("/api/browse")
def api_browse():
    """Lists immediate subdirectories of the given path, for the Project tab's folder
    browser. No path -> lists drive letters (Windows) as browsing roots. Permission
    errors on individual entries are skipped, not fatal -- a locked system folder
    shouldn't break browsing everything else alongside it."""
    raw_path = request.args.get("path", "").strip()

    if not raw_path:
        if os.name == "nt":
            drives = [f"{letter}:\\" for letter in string.ascii_uppercase if Path(f"{letter}:\\").exists()]
            return jsonify({"path": "", "parent": None, "entries": [{"name": d, "path": d, "isDir": True, "isGitRepo": False} for d in drives]})
        raw_path = "/"

    path = Path(raw_path)
    if not path.is_dir():
        abort(404)

    entries = []
    try:
        for child in sorted(path.iterdir(), key=lambda p: p.name.lower()):
            try:
                if child.is_dir():
                    entries.append({
                        "name": child.name,
                        "path": str(child),
                        "isDir": True,
                        "isGitRepo": (child / ".git").exists(),
                    })
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError) as e:
        abort(403, description=str(e))

    parent = str(path.parent) if path.parent != path else None
    return jsonify({"path": str(path), "parent": parent, "entries": entries})


def _grep_dirs_from_query() -> list[str]:
    """Matches the frontend's comma-separated grepDirs input convention -- the same
    string already sent to /api/project/build, now also needed by the read/write routes
    below so they resolve the same per-grepDirs cache slot a build wrote to."""
    raw = request.args.get("grepDirs", "").strip()
    return [d.strip() for d in raw.split(",") if d.strip()]


@app.route("/api/projects/history")
def api_projects_history():
    """Backs the Project tab's dropdown/search of previously-loaded projects. Paths that
    no longer exist on disk are still returned (a project on an unplugged drive, or one
    you're about to reconnect, is still worth remembering) -- filtering happens client-
    side if wanted, this endpoint is just the raw history."""
    return jsonify({"projects": read_project_history()})


@app.route("/api/project/status")
def api_project_status():
    raw_path = request.args.get("path", "").strip()
    if not raw_path:
        abort(400, description="path query param is required")

    cache = project_cache_paths(raw_path, _grep_dirs_from_query())
    _migrate_legacy_cache_if_needed(raw_path, cache)
    meta = read_json_safe(cache["meta"]) or {}
    with _build_lock:
        build = dict(_build_state.get(raw_path, {"running": False, "log": [], "error": None}))

    graph_exists = cache["graph"].is_file()
    community_count = 0
    file_count = 0
    if graph_exists:
        graph_data = read_json_safe(cache["graph"]) or {}
        file_count = len(graph_data.get("nodes", []))
        community_count = len({n.get("community") for n in graph_data.get("nodes", [])})

    return jsonify({
        "path": raw_path,
        "graphExists": graph_exists,
        "builtAt": meta.get("builtAt"),
        "fileCount": file_count,
        "communityCount": community_count,
        "build": build,
    })


def _run_build(path_str: str, grep_dirs: list[str]):
    log_lines = []

    def progress(msg):
        log_lines.append(msg)
        with _build_lock:
            _build_state[path_str]["log"] = list(log_lines)

    try:
        ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
        # No hardcoded model tag fallback -- see src/local-client.js's matching comment
        # (2026-08-22, Grimmethy: "models should be fully interchangeable and their names
        # should not be hardcoded anywhere"). An unset LOCAL_MODEL surfaces as a real
        # Ollama "model not found" error instead of a guessed name.
        local_model = os.environ.get("LOCAL_MODEL")

        cache = resolve_writable_cache(path_str, grep_dirs)
        # 2026-08-24 (Grimmethy, Brain Dump #155: "Every time I build a project graph it
        # starts from scratch. Can we instead build on diff's...") -- this call site never
        # loaded the previous build's graph/coverage at all (unlike build_graph.py's own
        # main()/check_due(), which already did), so it never even carried forward
        # lastReviewedAt review state on a rebuild, let alone skipped re-parsing unchanged
        # files or re-naming unchanged communities. Now does all three, via the SAME
        # file_cache/old_coverage/old_graph_nodes params build_graph.py's own callers use.
        old_graph = read_json_safe(cache["graph"]) or {"nodes": [], "links": []}
        old_coverage = read_json_safe(cache["coverage"]) or {"communities": []}
        file_cache = read_json_safe(cache["file_cache"]) or {}

        result = build_graph.build_graph_data(
            Path(path_str), grep_dirs, ollama_url, local_model, progress=progress,
            file_cache=file_cache, old_coverage=old_coverage, old_graph_nodes=old_graph.get("nodes", []),
        )
        merged_coverage = build_graph.merge_coverage(old_coverage, old_graph.get("nodes", []), result["coverage"], result["graph"]["nodes"])

        cache["graph"].write_text(json.dumps(result["graph"], indent=2), encoding="utf-8")
        cache["coverage"].write_text(json.dumps(merged_coverage, indent=2), encoding="utf-8")
        cache["file_cache"].write_text(json.dumps(file_cache, indent=2), encoding="utf-8")
        # A rebuild can change the node set/communities, so any previously cached layout
        # is stale by construction -- the next visualization load does one fresh physics
        # pass and re-captures, same as the very first build.
        cache["positions"].unlink(missing_ok=True)
        cache["meta"].write_text(json.dumps({
            "path": path_str,
            "grepDirs": grep_dirs,
            "builtAt": datetime.now(timezone.utc).isoformat(),
        }, indent=2), encoding="utf-8")

        with _build_lock:
            _build_state[path_str]["running"] = False
    except Exception as e:
        with _build_lock:
            _build_state[path_str]["running"] = False
            _build_state[path_str]["error"] = str(e)


@app.route("/api/project/build", methods=["POST"])
def api_project_build():
    body = request.get_json(silent=True) or {}
    raw_path = (body.get("path") or "").strip()
    if not raw_path:
        abort(400, description="path is required")
    if not Path(raw_path).is_dir():
        abort(404, description="path does not exist")
    record_project_used(raw_path)

    raw_grep_dirs = body.get("grepDirs")
    if raw_grep_dirs:
        # Explicit grepDirs is a deliberate scope -- honor it, but fail loudly if none of
        # the given dirs actually exist rather than silently falling back to a full scan.
        grep_dirs = [d for d in raw_grep_dirs if (Path(raw_path) / d).is_dir()]
        if not grep_dirs:
            abort(400, description="none of the given grepDirs exist under this path")
    else:
        # No grepDirs given -- scan the whole path rather than guessing at a
        # frontend/src,backend/src layout that may not exist. build_graph.py's wider
        # EXCLUDE_DIRS list keeps this from picking up build output/vendor/cache noise.
        grep_dirs = []

    with _build_lock:
        if _build_state.get(raw_path, {}).get("running"):
            return jsonify({"started": False, "reason": "a build is already running for this path"})
        _build_state[raw_path] = {"running": True, "log": [], "error": None}

    thread = threading.Thread(target=_run_build, args=(raw_path, grep_dirs), daemon=True)
    thread.start()
    return jsonify({"started": True, "grepDirs": grep_dirs})


@app.route("/api/project/sync", methods=["POST"])
def api_project_sync():
    """Project tab's 'Sync with GitHub' button, next to Build Graph -- Grimmethy,
    2026-08-24: "I assume my currently live session is not caught up with github? I need
    a button ... that makes sure the project is up to date with github." Fetches origin
    and fast-forwards the CURRENTLY CHECKED-OUT branch onto its own origin tracking
    branch. Never resets/force-updates: a dirty tree, a detached HEAD, a branch with no
    matching one on origin, or local commits origin doesn't have are all reported and
    left untouched rather than discarded -- same git-safety norm as _sync_live_checkout
    above (never auto-discard uncommitted or local-only work)."""
    body = request.get_json(silent=True) or {}
    raw_path = (body.get("path") or "").strip()
    if not raw_path:
        abort(400, description="path is required")
    repo_root = Path(raw_path)
    if not repo_root.is_dir():
        abort(404, description="path does not exist")

    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=str(repo_root), capture_output=True, text=True, timeout=15,
    )
    if status.returncode != 0:
        return jsonify({"synced": False, "reason": "not a git repository"}), 400
    if status.stdout.strip():
        return jsonify({"synced": False, "reason": "uncommitted local changes -- left untouched, commit or stash first"})

    # If this path IS the active pipeline's repo root, take the same lock apply-task's
    # own apply step uses, so a sync click can't race an in-flight apply out from under it
    # (same lock, same reasoning as api_git_merge_branch above).
    active_root = get_active_repo_root()
    is_active = bool(active_root) and os.path.realpath(active_root) == os.path.realpath(str(repo_root))
    lock_fd = _acquire_apply_lock() if is_active else None
    if is_active and lock_fd is None:
        abort(409, description="the pipeline is mid-apply right now -- try again in a few seconds")

    try:
        current_branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], repo_root).strip()
        if current_branch == "HEAD":
            return jsonify({"synced": False, "reason": "repo is in a detached HEAD state -- left untouched"})

        _run_git(["fetch", "origin"], repo_root)

        remote_ref = f"origin/{current_branch}"
        has_remote = subprocess.run(
            ["git", "show-ref", "--verify", "--quiet", f"refs/remotes/{remote_ref}"],
            cwd=str(repo_root), capture_output=True, timeout=10,
        )
        if has_remote.returncode != 0:
            return jsonify({"synced": False, "reason": f"no '{remote_ref}' on origin to sync against", "branch": current_branch})

        counts = _run_git(["rev-list", "--left-right", "--count", f"HEAD...{remote_ref}"], repo_root).strip()
        ahead_str, behind_str = (counts.split() + ["0", "0"])[:2]
        ahead, behind = int(ahead_str), int(behind_str)

        if behind == 0:
            return jsonify({"synced": True, "changed": False, "branch": current_branch, "ahead": ahead, "behind": behind})
        if ahead > 0:
            return jsonify({
                "synced": False,
                "reason": f"local '{current_branch}' has {ahead} commit(s) not on {remote_ref} -- left untouched, this isn't a safe fast-forward",
                "branch": current_branch, "ahead": ahead, "behind": behind,
            })

        before = _run_git(["rev-parse", "HEAD"], repo_root).strip()
        _run_git(["merge", "--ff-only", remote_ref], repo_root)
        after = _run_git(["rev-parse", "HEAD"], repo_root).strip()
        changed_files = _run_git(["diff", "--name-only", before, after], repo_root).splitlines()
        return jsonify({
            "synced": True, "changed": True, "branch": current_branch, "behind": behind, "changedFiles": changed_files,
        })
    except RuntimeError as e:
        return jsonify({"synced": False, "reason": str(e)}), 500
    finally:
        if lock_fd is not None:
            _release_apply_lock(lock_fd)


@app.route("/project/visualization")
def project_visualization():
    raw_path = request.args.get("path", "").strip()
    if not raw_path:
        abort(400)
    grep_dirs = _grep_dirs_from_query()
    cache = project_cache_paths(raw_path, grep_dirs)
    _migrate_legacy_cache_if_needed(raw_path, cache)
    if not cache["graph"].is_file():
        return "<p style='font-family:sans-serif;padding:20px'>No graph built yet for this project.</p>", 404

    graph_data = json.loads(cache["graph"].read_text(encoding="utf-8"))
    coverage_data = read_json_safe(cache["coverage"])
    positions_data = read_json_safe(cache["positions"])
    html = visualize_graph.render_html(graph_data, coverage_data, positions=positions_data, project_path=raw_path, grep_dirs=grep_dirs)
    return html


@app.route("/project/positions", methods=["POST"])
def api_project_positions():
    """Best-effort layout cache write from the visualization iframe's own capture script
    (see python/visualize_assets/capture-positions.js / community-drag.js) --
    same-origin, server-generated page posting back to its own dashboard, not external
    user input.

    Merges into the existing file rather than overwriting wholesale: the community-drag
    feature intentionally posts only the moved community's node positions (a small
    fraction of the graph), not the full network.getPositions() -- browsers cap
    keepalive fetch bodies at ~64KB, and a large graph's full position payload can exceed
    that (a real graph in this project measured 271KB), causing the save to silently fail
    with no timing race needed at all. An overwrite semantics here would also have wiped
    out every other node's cached position whenever only one community's subset was
    posted."""
    raw_path = request.args.get("path", "").strip()
    if not raw_path:
        abort(400, description="path query param is required")
    positions = request.get_json(silent=True)
    if positions is None:
        abort(400, description="request body must be JSON")
    grep_dirs = _grep_dirs_from_query()
    cache = resolve_writable_cache(raw_path, grep_dirs)
    existing = read_json_safe(cache["positions"]) or {}
    existing.update(positions)
    cache["positions"].write_text(json.dumps(existing), encoding="utf-8")
    return jsonify({"saved": True})


# Daemon-script command-line fragments scripts/launch.sh starts and scripts/stop.sh
# stops -- the same set stop.sh's own stray-sweep matches (minus the dashboard, which is
# always running and is not "the pipeline"). Used for a real process check so this file
# never again has to trust a heartbeat timestamp alone to decide whether a stop is
# possible. Matched with `pgrep -f` against the script path fragment, so it works whether
# the pipeline dir is the real path or a symlink to it.
_PIPELINE_DAEMON_PGREP_RE = r"agent-manager/scripts/(launch|local-worker|review-runner|queue-watcher)\.sh|agent-manager/scripts/\.\./src/(local-draft|apply-task)\.js"


def _pid_alive(pid) -> bool:
    """True if `pid` names a live process (whether or not this user can signal it)."""
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by another user
    except (TypeError, ValueError, OverflowError):
        return False


def _pipeline_daemon_pids() -> list:
    """PIDs of live pipeline daemon processes right now, by real process scan -- the
    ground truth a stop actually acts on, independent of any heartbeat file. Empty when
    `pgrep` is unavailable or finds nothing; callers treat "empty" as "nothing to stop"
    only in combination with the heartbeat check, never on its own."""
    try:
        res = subprocess.run(
            ["pgrep", "-f", _PIPELINE_DAEMON_PGREP_RE],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(p) for p in res.stdout.split() if p.strip().isdigit()]


def _pipeline_stoppable() -> bool:
    """Is there anything a stop would actually kill? Deliberately looser than
    _pipeline_running(): a live daemon process counts even if every heartbeat file is
    missing or stale. This is what gates the dashboard's Stop control, so a wrong
    _pipeline_running() (a blocked-on-lock worker reading as dead, a deleted heartbeat, a
    future timestamp-parsing regression like the 2026-07-22 one) can never again strand a
    real running pipeline with no way to stop it from the UI."""
    if _pipeline_running():
        return True
    if _pipeline_daemon_pids():
        return True
    inst_dir = instances_dir()
    if inst_dir and inst_dir.is_dir():
        for name in ("worker-1", "worker-reasoning", "review-runner", "queue-watchdog"):
            data = read_json_safe(inst_dir / f"{name}.json")
            if data and data.get("pid") and _pid_alive(data["pid"]):
                return True
    return False


def _pipeline_running() -> bool:
    """A pipeline counts as running if worker-1's own heartbeat is fresh -- the other
    loops matter too, but the worker is the one that actually produces work, and checking
    just one avoids this being wrong the moment any ONE of the others is mid-restart.

    Fallbacks (2026-08-30, after a live incident where worker-1 sat status:'queued'
    blocked on the model lock for >OTHER_STALE_SECONDS behind a wedged local-agentic
    pass -- its heartbeat legitimately stops updating while blocked, so the fresh-
    heartbeat check alone read the whole running pipeline as stopped and the dashboard
    hid its own Stop button): if the heartbeat is stale/missing, fall back to whether the
    recorded worker/reviewer PID is still a live process, and finally to a real daemon
    process scan. A blocked worker is still a running pipeline."""
    inst_dir = instances_dir()
    if not inst_dir or not inst_dir.is_dir():
        return bool(_pipeline_daemon_pids())

    worker_hb = inst_dir / "worker-1.json"
    data = read_json_safe(worker_hb)
    if data and data.get("lastHeartbeat"):
        last_hb = parse_hb_timestamp(data["lastHeartbeat"])
        if last_hb:
            age = (datetime.now(timezone.utc) - last_hb).total_seconds()
            threshold = WORKING_STALE_SECONDS if data.get("status") == "working" else OTHER_STALE_SECONDS
            if age <= threshold:
                return True

    # Stale or unparseable heartbeat -- believe a live process over a stale timestamp.
    for name in ("worker-1", "worker-reasoning", "review-runner"):
        d = read_json_safe(inst_dir / f"{name}.json")
        if d and d.get("pid") and _pid_alive(d["pid"]):
            return True
    return bool(_pipeline_daemon_pids())


# --- Unmerged branches (the "sandbox" visibility gap) -----------------------------------
# apply-task.js's adhoc/default apply path never merges to main -- it pushes a throwaway
# agent/<task.id> branch and stops there BY DESIGN (review gate before landing real code).
# Confirmed live 2026-08-18: that gate has no counterpart on the OTHER side -- nothing
# ever told the operator a pushed branch was still sitting there unmerged, so "the pipeline
# says done" and "the change is actually live" silently drifted apart, compounding with a
# separate bug (see apply-task.js's recordApplyOutcome()) that could mark a task done with
# NO branch at all. This section closes that gap: list what's pushed-but-unmerged, and let
# a human merge one with a single click instead of the manual clone/branch/merge/push/sync
# dance that incident required.
#
# PACKAGE_ROOT (this dashboard's own repo) and get_active_repo_root() (the repo the
# pipeline drafts/pushes against) can be two different checkouts of the SAME remote --
# confirmed live this same incident: an agent-manager "live" deployment and an
# "agent-manager-apply-target" consumer checkout. Branches are listed/merged against the
# ACTIVE REPO ROOT (where they were actually pushed); the live sync step below is what
# then catches PACKAGE_ROOT up to the result.

_BRANCH_CACHE_TTL_SECONDS = 45
_branch_cache = {"at": 0.0, "branches": []}
_branch_cache_lock = threading.Lock()


def _run_git(args, cwd, timeout=30):
    result = subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


def _detect_main_branch(repo_root):
    """Same candidate order as src/git-runner.js's detectDefaultBranch() -- kept in sync
    by hand (same convention as the task-source-catalog duplication elsewhere in this
    file), since a Python dashboard route and a Node apply step both need to agree on
    which branch 'main' means for the same repo."""
    override = os.environ.get("AGENT_MANAGER_MAIN_BRANCH")
    candidates = [c for c in [override, "main", "master"] if c]
    for candidate in candidates:
        check = subprocess.run(
            ["git", "show-ref", "--verify", "--quiet", f"refs/remotes/origin/{candidate}"],
            cwd=str(repo_root), capture_output=True, timeout=10,
        )
        if check.returncode == 0:
            return candidate
    return "main"


# Regex, not exact string matching -- git's own conflict-line wording varies by conflict
# TYPE ("Merge conflict in X" for content conflicts, "Merge conflict in X" for add/add
# too, but the parenthesized kind before it differs: "(content)", "(add/add)", "(rename)",
# etc.) -- only the trailing file path after 'in ' is what callers need, so match loosely
# on that structural shape rather than hardcoding one conflict-type's exact wording.
_CONFLICT_LINE_RE = re.compile(r"^CONFLICT \([^)]+\):.*\bin (.+)$", re.MULTILINE)


def _check_merge_conflict(repo_root, main_branch, branch):
    """Cheap, side-effect-free conflict preview: git merge-tree (2.38+) computes a real
    3-way merge entirely against the object database -- no working tree or index touched,
    nothing to clean up regardless of outcome -- and reports whether it WOULD conflict
    without actually attempting one. Added after a real near-miss (2026-08-18): two
    pushed-but-unmerged branches both independently created the same new file, and the
    only way that surfaced was an opaque git error AFTER a merge was already attempted --
    exactly the kind of surprise a 'one button' merge shouldn't produce. Best-effort: any
    unexpected error here is reported as 'unknown', not 'safe' -- a staleness/conflict
    check that silently says 'no conflict' on its own failure would be worse than no
    check at all.
    """
    result = subprocess.run(
        ["git", "merge-tree", "--write-tree", f"origin/{main_branch}", f"origin/{branch}"],
        cwd=str(repo_root), capture_output=True, text=True, timeout=30,
    )
    if result.returncode == 0:
        return {"willConflict": False, "conflictFiles": [], "checked": True}
    if result.returncode == 1:
        files = _CONFLICT_LINE_RE.findall(result.stdout)
        return {"willConflict": True, "conflictFiles": files, "checked": True}
    # returncode > 1: merge-tree itself errored (not a conflict verdict) -- report
    # "unknown" rather than guessing either way.
    return {"willConflict": None, "conflictFiles": [], "checked": False}


_RESOLUTION_LINE_RE = re.compile(r"RESOLUTION:\s*(?:implemented|no-changes-needed|decompose)\b", re.IGNORECASE)
_CANDIDATE_METADATA_LINE_RE = re.compile(r"^(?:###.*|Strength:.*|Files?:.*|Source:.*)$", re.MULTILINE)
_DESCRIPTION_MAX_CHARS = 600


def _describe_change(data: dict) -> str | None:
    """Best-effort plain-English description of what a branch's task actually changed
    (Grimmethy, 2026-08-20: "I'd also like the unmerged branch reports to include a plain
    english description of the fix or change"). Tries strategies in order of how likely
    they are to already BE real prose written for exactly this purpose, rather than
    parsing a diff or guessing:

    1. adhoc's real agentic Claude pass always ends its own final message with a short
       plain-English summary right after its own RESOLUTION: sentinel line
       (adhoc-agentic-draft.js's prompt asks for this explicitly) -- use it verbatim.
    2. A candidate-fulfillment task (arch_review/observability_fix/performance_fix/etc.,
       via nextCandidateFulfillmentTask) carries the ORIGINAL candidate's own
       Problem/Solution/Benefits write-up in promptContext.body -- real prose written for
       a human, unlike implementResponse itself for this task shape (raw Group-B JSON
       diff instructions, no natural language at all).
    3. A verdict-only source (observability_review/performance_review triage after their
       2026-08-20 redirect, arch_discovery's own candidate write-up, etc.) already has
       plain-prose implementResponse -- use it directly if it doesn't look like JSON,
       stripping the same AC-NNN/Strength/Files header lines if it's in candidate format
       (a genuine verdict IS a candidate write-up now, not just fulfillment tasks).
    4. Fall back to planResponse (still real prose, just less specific).
    """
    def strip_candidate_metadata(text: str) -> str:
        cleaned = _CANDIDATE_METADATA_LINE_RE.sub("", text).strip()
        return re.sub(r"\n{3,}", "\n\n", cleaned).strip()

    # 2026-08-26, Grimmethy: "Does the record in the dashboard properly reflect all the
    # information about this entry?" -- caught live on arch-review-ac-4: a split-resolution
    # task (implementResponse is raw {"mode":"split",...} JSON, no RESOLUTION line, no
    # plain-prose implement) fell all the way through to strategy 2 below and showed the
    # ORIGINAL candidate's problem/solution write-up as the branch's description -- reading
    # exactly like a completed refactor (title unchanged too) even though the branch
    # contains ZERO code changes, only two new sub-candidates appended to the doc. Checked
    # FIRST, ahead of every other strategy: candidateSplitProposals is set exclusively by
    # this exact outcome (see apply-task.js's applyCandidateSplit / local-draft.js's
    # parseCandidateSplit) and is unambiguous where implementResponse's shape is not.
    split_proposals = data.get("candidateSplitProposals")
    if split_proposals:
        titles = [p.get("title") for p in split_proposals if isinstance(p, dict) and p.get("title")]
        titles_text = "; ".join(titles) if titles else f"{len(split_proposals)} sub-candidates"
        return (
            f"Split into {len(split_proposals)} sub-candidate(s), not yet implemented: "
            f"{titles_text}"
        )[:_DESCRIPTION_MAX_CHARS]

    implement = (data.get("implementResponse") or "").strip()

    m = _RESOLUTION_LINE_RE.search(implement)
    if m:
        after = implement[m.end():].strip()
        if after:
            return after[:_DESCRIPTION_MAX_CHARS]

    prompt_context = data.get("promptContext") or {}
    body = (prompt_context.get("body") or "").strip()
    if body:
        cleaned = strip_candidate_metadata(body)
        if cleaned:
            return cleaned[:_DESCRIPTION_MAX_CHARS]

    if implement and not implement.startswith(("{", "[")):
        text = strip_candidate_metadata(implement) if implement.startswith("###") else implement
        if text:
            return text[:_DESCRIPTION_MAX_CHARS]

    plan = (data.get("planResponse") or "").strip()
    if plan:
        return plan[:_DESCRIPTION_MAX_CHARS]

    return None


def _label_for_branch(task_id, pipeline_dir, subject):
    """Best-effort human label: the originating task's own title/domain/source (plus a
    plain-English description of what it actually changed, see _describe_change) if a
    matching queue file can still be found (checked across every terminal-ish state a
    merge-worthy branch's task could be sitting in), else the branch tip's own commit
    subject line -- never just the raw branch name, which is an opaque id nobody but this
    pipeline can read at a glance."""
    if pipeline_dir:
        qdir = pipeline_dir / "queue"
        for state in ("done", "blocked", "awaiting-confirm", "approved"):
            data = read_json_safe(qdir / state / f"{task_id}.json")
            if data:
                return {
                    "title": data.get("title") or subject or task_id,
                    "domain": data.get("domain"),
                    "source": data.get("source"),
                    "matchedTaskState": state,
                    "description": _describe_change(data),
                }
    return {"title": subject or task_id, "domain": None, "source": None, "matchedTaskState": None, "description": None}


def _list_unmerged_branches_uncached():
    repo_root = get_active_repo_root()
    if not repo_root:
        return []
    repo_root = Path(repo_root)
    pipeline_dir = get_pipeline_dir()

    _run_git(["fetch", "origin", "--prune"], repo_root, timeout=30)
    main_branch = _detect_main_branch(repo_root)

    raw = _run_git(
        ["for-each-ref", "--format=%(refname:short)%09%(committerdate:iso-strict)%09%(subject)", "refs/remotes/origin/agent/"],
        repo_root,
    )
    branches = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        full_ref, pushed_at, subject = parts
        branch = full_ref.removeprefix("origin/")
        task_id = branch.removeprefix("agent/")

        try:
            ahead_raw = _run_git(["rev-list", "--count", f"origin/{main_branch}..{full_ref}"], repo_root)
            ahead = int(ahead_raw.strip() or "0")
        except (RuntimeError, ValueError) as exc:
            logger.warning("Skipping branch %s: failed to compute ahead-count (%s: %s)", full_ref, type(exc).__name__, exc)
            continue
        if ahead == 0:
            # Already fully merged (e.g. landed by hand, or a stale ref pending prune on
            # the remote) -- nothing for a human to act on, would just be clutter here.
            continue

        try:
            behind_raw = _run_git(["rev-list", "--count", f"{full_ref}..origin/{main_branch}"], repo_root)
            behind = int(behind_raw.strip() or "0")
        except (RuntimeError, ValueError):
            behind = None

        conflict = _check_merge_conflict(repo_root, main_branch, branch)

        label = _label_for_branch(task_id, pipeline_dir, subject.strip())
        branches.append({
            "branch": branch,
            "taskId": task_id,
            "title": label["title"],
            "domain": label["domain"],
            "source": label["source"],
            "matchedTaskState": label["matchedTaskState"],
            "description": label["description"],
            "subject": subject.strip(),
            "pushedAt": pushed_at,
            "ahead": ahead,
            "behind": behind,
            "mainBranch": main_branch,
            "willConflict": conflict["willConflict"],
            "conflictFiles": conflict["conflictFiles"],
        })

    branches.sort(key=lambda b: b["pushedAt"])
    return branches


def list_unmerged_branches(force=False):
    with _branch_cache_lock:
        age = time.time() - _branch_cache["at"]
        if not force and age < _BRANCH_CACHE_TTL_SECONDS:
            return _branch_cache["branches"]
    try:
        branches = _list_unmerged_branches_uncached()
    except (RuntimeError, subprocess.SubprocessError, OSError) as e:
        # Best-effort, same "a check failing here must never block the rest of the
        # dashboard" rule as everything else that shells out in this file -- a git/network
        # hiccup here shouldn't take down /api/summary's 5s poll cycle with it.
        print(f"[branches] list failed (non-fatal): {e}", file=sys.stderr)
        with _branch_cache_lock:
            return _branch_cache["branches"]
    with _branch_cache_lock:
        _branch_cache["at"] = time.time()
        _branch_cache["branches"] = branches
    return branches


def _invalidate_branch_cache():
    with _branch_cache_lock:
        _branch_cache["at"] = 0.0


@app.route("/api/git/unmerged-branches")
def api_git_unmerged_branches():
    return jsonify(list_unmerged_branches(force=True))


# Same well-known lockfile apply-task.sh itself flocks (scripts/apply-task.sh's own header
# comment explains why: the race is about the shared git working tree, not this project's
# pipelineDir, so it has to be the same fixed path regardless of caller). A merge from
# here does the same fetch/reset/branch-touching sequence apply-task.sh's loop does every
# ~30s -- without this, a merge click racing that loop mid-apply would corrupt the
# other's half-finished branch/index state, exactly the failure mode that lockfile
# already exists to prevent between apply-task.sh's own two callers.
def _acquire_apply_lock(timeout_seconds=5):
    lock_dir = Path.home() / ".local" / "state" / "agent-manager" / "locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_fd = open(lock_dir / "apply-task.lock", "w")
    deadline = time.time() + timeout_seconds
    while True:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock_fd
        except BlockingIOError:
            if time.time() >= deadline:
                lock_fd.close()
                return None
            time.sleep(0.5)


def _release_apply_lock(lock_fd):
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
    finally:
        lock_fd.close()


def _sync_live_checkout(main_branch):
    """After a branch lands on the ACTIVE repo root's main, fast-forward THIS dashboard's
    own repo (PACKAGE_ROOT) to match, if it's a clone of the same remote and clean enough
    to fast-forward safely. Never force/reset here -- a dirty PACKAGE_ROOT (e.g. a
    developer's own in-progress manual edit, confirmed to happen during this same
    incident) is left alone and reported, not silently discarded; that mirrors this
    codebase's own git-safety norms elsewhere (never auto-discard uncommitted work)."""
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=str(PACKAGE_ROOT), capture_output=True, text=True, timeout=15,
    )
    if status.returncode != 0:
        return {"synced": False, "reason": "PACKAGE_ROOT is not a git repo or git status failed"}
    if status.stdout.strip():
        return {"synced": False, "reason": "PACKAGE_ROOT has uncommitted local changes -- left untouched, sync it by hand"}

    try:
        before = _run_git(["rev-parse", "HEAD"], PACKAGE_ROOT).strip()
        _run_git(["fetch", "origin"], PACKAGE_ROOT)
        _run_git(["pull", "--ff-only", "origin", main_branch], PACKAGE_ROOT)
        after = _run_git(["rev-parse", "HEAD"], PACKAGE_ROOT).strip()
    except RuntimeError as e:
        return {"synced": False, "reason": str(e)}

    if before == after:
        return {"synced": True, "changed": False, "restartTriggered": False}

    changed_files = _run_git(["diff", "--name-only", before, after], PACKAGE_ROOT).splitlines()
    dashboard_touched = any(f.startswith("python/dashboard/") for f in changed_files)
    restart_triggered = False
    if dashboard_touched:
        # Werkzeug's StatReloader (use_reloader=True below) only watches .py files, not
        # Jinja templates -- confirmed live this same incident: a template-only change
        # left the running process silently serving the OLD page until manually killed
        # and restarted, the exact "looks synced, isn't" gap this whole feature exists to
        # close. Touching app.py's own mtime forces a full process restart regardless of
        # WHICH dashboard file actually changed, so a template-only merge can't slip
        # through un-reloaded the way it did during that incident.
        try:
            os.utime(Path(__file__), None)
            restart_triggered = True
        except OSError:
            pass
    return {"synced": True, "changed": True, "changedFiles": changed_files, "restartTriggered": restart_triggered}


_COMMIT_LOG_FIELD_SEP = "\x1f"  # unit separator -- won't collide with real commit text
_COMMIT_LOG_RECORD_SEP = "\x1e"  # record separator between commits


@app.route("/api/git/branches/<path:branch>/commits")
def api_git_branch_commits(branch):
    """Full commit history for one pushed-but-unmerged branch, ahead of mainBranch --
    the Unmerged Branches tab previously only ever showed the tip commit's subject line,
    so selecting a multi-commit branch gave no way to see what it actually did short of
    a manual `git log` on the box running the dashboard."""
    repo_root = get_active_repo_root()
    if not repo_root:
        abort(404, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")
    repo_root = Path(repo_root)

    # Same "only act on what we ourselves already offered" gate api_git_merge_branch
    # uses -- never trust a caller-supplied branch string as a raw git ref beyond what
    # this process already enumerated itself.
    branches = list_unmerged_branches(force=False)
    match = next((b for b in branches if b["branch"] == branch), None)
    if not match:
        abort(404, description=f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch")

    main_branch = match["mainBranch"]
    fmt = _COMMIT_LOG_FIELD_SEP.join(["%H", "%an", "%aI", "%s", "%b"]) + _COMMIT_LOG_RECORD_SEP
    try:
        raw = _run_git(
            ["log", f"origin/{main_branch}..origin/{branch}", f"--format={fmt}"],
            repo_root,
        )
    except RuntimeError as e:
        abort(502, description=f"git log failed: {e}")

    commits = []
    for record in raw.split(_COMMIT_LOG_RECORD_SEP):
        if not record.strip("\n"):
            continue
        parts = record.lstrip("\n").split(_COMMIT_LOG_FIELD_SEP)
        if len(parts) != 5:
            continue
        sha, author, date, subject, body = parts
        commits.append({
            "sha": sha,
            "author": author,
            "date": date,
            "subject": subject,
            "body": body.strip("\n"),
        })
    return jsonify({"branch": branch, "mainBranch": main_branch, "commits": commits})


@app.route("/api/git/branches/<path:branch>/merge", methods=["POST"])
def api_git_merge_branch(branch):
    repo_root = get_active_repo_root()
    if not repo_root:
        abort(404, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")
    repo_root = Path(repo_root)

    # Never trust a caller-supplied branch string as a raw git ref beyond what THIS
    # process already enumerated itself -- re-derive the current list (cheap: cached
    # unless stale) and require an exact match, the same "only act on what we ourselves
    # already offered" gate api_task_archive/api_task_requeue's state allowlists use.
    branches = list_unmerged_branches(force=True)
    match = next((b for b in branches if b["branch"] == branch), None)
    if not match:
        abort(404, description=f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch")

    lock_fd = _acquire_apply_lock()
    if lock_fd is None:
        abort(409, description="the pipeline is mid-apply right now -- try again in a few seconds")

    main_branch = match["mainBranch"]
    try:
        _run_git(["fetch", "origin"], repo_root)
        _run_git(["checkout", main_branch], repo_root)
        _run_git(["reset", "--hard", f"origin/{main_branch}"], repo_root)
        try:
            _run_git(["merge", "--no-ff", f"origin/{branch}", "-m", f"Merge {match['title']} (via dashboard)"], repo_root)
        except RuntimeError as merge_err:
            subprocess.run(["git", "merge", "--abort"], cwd=str(repo_root), capture_output=True, timeout=15)
            # match['willConflict']/['conflictFiles'] came from list_unmerged_branches's
            # own merge-tree preview a moment ago (same request, force-refreshed above) --
            # if it already predicted this exact outcome, say so plainly instead of
            # surfacing raw git stderr. Confirmed live 2026-08-18: an add/add conflict
            # between two independently-drafted candidate docs produced exactly this kind
            # of opaque failure with no indication of WHICH files or WHY.
            if match.get("willConflict") and match.get("conflictFiles"):
                files = ", ".join(match["conflictFiles"])
                raise RuntimeError(
                    f"conflicts with {main_branch} on: {files} -- this was flagged before you clicked merge; "
                    f"resolve by hand (e.g. combine both versions) rather than retrying, retrying will fail the same way"
                ) from merge_err
            raise merge_err
        _run_git(["push", "origin", main_branch], repo_root)
        try:
            _run_git(["push", "origin", "--delete", branch], repo_root)
        except RuntimeError as e:
            # Non-fatal -- the merge to main already succeeded and is the part that
            # matters; a leftover now-fully-merged remote branch is harmless clutter
            # (next list will filter it out via the ahead==0 check) rather than a real
            # failure worth reporting as one.
            logger.warning("Non-fatal: could not delete remote branch %r (repo: %s): %s", branch, repo_root, e)
    except RuntimeError as e:
        return jsonify({"succeeded": False, "reason": str(e)}), 500
    finally:
        _release_apply_lock(lock_fd)

    _invalidate_branch_cache()
    live_sync = _sync_live_checkout(main_branch)

    # Stamp mergedAt on the task record once its branch is actually merged (2026-08-22,
    # Grimmethy: "some way to prioritize what order adhoc tasks get completed in. Those
    # with dependencies on new adhoc tasks are absolutely going to need to be done after
    # the dependency is completed") -- this is the real "is this dependency satisfied"
    # signal task-sources.js's nextAdhocTask() checks before letting a dependent task
    # claim. Reaching queue/done/ alone isn't enough: a task there is only pushed to its
    # OWN branch, not merged, and every adhoc draft's git worktree starts from
    # origin/<mainBranch> -- a dependency's fix isn't actually visible to a dependent
    # task's fresh checkout until it's merged, confirmed live by the exact failure this
    # feature exists to prevent (a dependent task's diff going stale against code the
    # dependency hadn't landed yet). Best-effort: a task record not found (already
    # archived, or this merge came from some other source than the normal apply flow)
    # must never fail the merge itself, which already fully succeeded above.
    qdir = queue_dir()
    if qdir:
        task_id = branch.removeprefix("agent/")
        for candidate in (qdir / "done" / f"{task_id}.json", qdir / "done" / "_archived_no_action" / f"{task_id}.json"):
            if candidate.is_file():
                data = read_json_safe(candidate)
                if data is not None:
                    now_iso = datetime.now(timezone.utc).isoformat()
                    data["mergedAt"] = now_iso
                    # Close the task log with a terminal disposition event (see
                    # src/task-disposition.js) -- `mergedAt` alone is a field the dependency
                    # gate reads; an update audit reads the history, which used to stop at
                    # `applied`.
                    if data.get("terminalDisposition") != "merged":
                        hist = data.get("history")
                        if not isinstance(hist, list):
                            hist = data["history"] = []
                        hist.append({
                            "stage": "merged",
                            "at": now_iso,
                            "detail": f"merged into {main_branch} via the dashboard Unmerged Branches tab",
                        })
                        data["terminalDisposition"] = "merged"
                    try:
                        candidate.write_text(json.dumps(data, indent=2), encoding="utf-8")
                    except OSError as exc:
                        logger.error("Failed to persist merge-state for branch %r to %s: %s", branch, candidate, exc)
                        raise
                break

    return jsonify({"succeeded": True, "branch": branch, "mainBranch": main_branch, "liveSync": live_sync})


@app.route("/api/pipeline/status")
def api_pipeline_status():
    env = read_env_file(ENV_FILE_PATH)
    running = _pipeline_running()
    return jsonify({
        "activeRepoRoot": get_active_repo_root(),
        "running": running,
        # "stoppable" is looser than "running": true whenever a real daemon process
        # exists, even if every heartbeat says otherwise. The frontend gates its Stop
        # control on (running || stoppable) so a wrong "running" can never hide the only
        # way to stop a live pipeline from the UI (2026-08-30 incident).
        "stoppable": True if running else _pipeline_stoppable(),
        # Which job types actually run is no longer a bundled "mode" -- see /api/job-types.
        # includeApply/skipPush are the two run-specific safety toggles that used to be
        # implied by mode; they're per-repoRoot and persisted the same way REPO_ROOT is.
        "includeApply": env.get("AGENT_MANAGER_INCLUDE_APPLY", "false") == "true",
        "skipPush": env.get("AGENT_MANAGER_APPLY_SKIP_PUSH", "true") == "true",
    })


# Kept in sync by hand with src/task-sources.js's registerTaskSource() calls, same
# "Python duplicates Node's knowledge" convention already used for SECOND_BRAIN_DIR above.
# The canonical source-name list (Job List isActive checkboxes, /api/pipeline/start's
# task-domain healing) now comes from task_source_catalog() -> load_topology(), so it can
# never drift from the real registry (built-ins + AGENT_MANAGER_REGISTER_PATH plugins).

# Exempt from any allowlist restriction regardless of stored state -- task-sources.js's
# getNextTask() hardcodes this same exemption ('adhoc': fixed contract per README,
# "preempts every deterministic source"; 'brain_dump_sort': always-on background source,
# confirmed live 2026-07-23 it was silently getting gated out by Project Search mode's
# allowlist before that fix). Presenting either as toggleable in the UI would be a lie.
# 'path_prefetch_resolve' joins them 2026-08-16: it only ever exists to resolve a held
# task brain_dump_sort's own always-on pipeline produced -- gating it behind a
# project-mode allowlist would mean held tasks silently never get an LLM-suggestion
# attempt whenever that allowlist doesn't happen to include it.
ALWAYS_ACTIVE_SOURCES = {"adhoc", "brain_dump_sort", "path_prefetch_resolve"}


def read_active_job_types() -> set:
    """AGENT_MANAGER_TASK_SOURCES unset/empty means unrestricted (every source active) --
    same semantics src/task-sources.js's getNextTask() already implements."""
    raw = read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_TASK_SOURCES", "")
    listed = {s.strip() for s in raw.split(",") if s.strip()}
    if not listed:
        return set(task_source_catalog())
    return listed | ALWAYS_ACTIVE_SOURCES

# The default priority a source falls back to when AGENT_MANAGER_TASK_PRIORITIES has no
# override -- straight from the registry now (task_source_default_priorities()).


def read_task_priorities() -> dict:
    """Job List tab's editable Priority column. AGENT_MANAGER_TASK_PRIORITIES holds only
    the overrides (\"name:number,name:number\"), same sparse-override shape src/config.js's
    taskPriorityOverrides parses on the Node side -- a source not listed here just keeps
    its TASK_SOURCE_DEFAULT_PRIORITIES value."""
    raw = read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_TASK_PRIORITIES", "")
    overrides = {}
    for pair in raw.split(","):
        if ":" not in pair:
            continue
        name, _, num = pair.partition(":")
        name = name.strip()
        try:
            overrides[name] = int(num.strip())
        except ValueError:
            continue
    return {name: overrides.get(name, default) for name, default in task_source_default_priorities().items()}


VALID_WORKER_TYPES = ("ornith", "reasoning")

# Mirrors src/task-sources.js's registerTaskSource({reasoningTier}) calls: only adhoc and
# research_task are registered 'high' (Claude/reasoning worker); every other source defaults
# to 'low' (Ornith). The default a source falls back to when AGENT_MANAGER_TASK_TIERS has no
# override for it -- same "Python duplicates Node's knowledge" convention as
# TASK_SOURCE_DEFAULT_PRIORITIES above.
# task_source_default_worker_types() -> load_topology(): each source's registered
# reasoningTier mapped to its worker lane (low->ornith, high->reasoning).


def read_worker_types() -> dict:
    """Job List tab's editable Worker Type column (Ornith/low-reasoning vs the
    Claude-backed reasoning worker). AGENT_MANAGER_TASK_TIERS holds only the overrides
    ("name:tier,name:tier"), same sparse-override shape src/config.js's taskTierOverrides
    parses on the Node side -- a source not listed here just keeps its
    TASK_SOURCE_DEFAULT_WORKER_TYPES value. Stored as the Node-side low/high tier names
    ('low'/'high') so both sides agree on-disk, translated to ornith/reasoning at the API
    boundary for the UI."""
    raw = read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_TASK_TIERS", "")
    tier_to_worker_type = {"low": "ornith", "high": "reasoning"}
    overrides = {}
    for pair in raw.split(","):
        if ":" not in pair:
            continue
        name, _, tier = pair.partition(":")
        name = name.strip()
        tier = tier.strip()
        if tier in tier_to_worker_type:
            overrides[name] = tier_to_worker_type[tier]
    return {name: overrides.get(name, default) for name, default in task_source_default_worker_types().items()}


VALID_APPROVAL_MODES = ("auto", "prompt", "approve")


def _default_approval_mode() -> str:
    """Mirrors src/config.js's defaultApprovalMode: derived from the existing
    AGENT_MANAGER_INCLUDE_APPLY global toggle, so an unconfigured source keeps today's
    exact behavior (auto-apply when the toggle is on, wait for a manual apply when off)."""
    return "auto" if read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_INCLUDE_APPLY", "false") == "true" else "approve"


def read_approval_modes() -> dict:
    """Job List tab's editable Approval Mode column (three-tier approval mode,
    2026-07-26). AGENT_MANAGER_APPROVAL_MODES holds only the overrides
    ("name:mode,name:mode"), same sparse-override shape src/config.js's
    approvalModeOverrides parses -- a source not listed here falls back to the single
    global default derived from AGENT_MANAGER_INCLUDE_APPLY, not a per-source default the
    way priorities has (there is no meaningful "this source's own baseline approval mode"
    the way there's a meaningful baseline priority ladder position)."""
    raw = read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_APPROVAL_MODES", "")
    overrides = {}
    for pair in raw.split(","):
        if ":" not in pair:
            continue
        name, _, mode = pair.partition(":")
        name = name.strip()
        mode = mode.strip()
        if mode in VALID_APPROVAL_MODES:
            overrides[name] = mode
    default = _default_approval_mode()
    return {name: overrides.get(name, default) for name in task_source_catalog()}


# workDirKind/successCheck values that satisfy review-runner.ps1's unconditional
# Get-DomainConfig lookup for each domain that apply-task.js already special-cases as a
# non-git write. Neither field is actually consulted for these domains on the real
# (ornith-provider, apply-runner) path -- successCheck only matters for the 'claude'
# REVIEW_PROVIDER branch, which nothing here uses -- so any valid placeholder works; kept
# identical to "default" for simplicity rather than inventing a new value with no
# behavioral difference.
# Maps a task-source NAME (TASK_SOURCE_CATALOG's entries) to the DOMAIN KEY it actually
# stamps onto its tasks. Most built-ins use their own name as the domain (project_search,
# deep_dive, brain_dump_sort, secondbrain) -- but seven of them (trouble_log, arch_review,
# arch_import_review, arch_discovery, arch_import, observability_review, performance_review,
# unused_export) all share the single 'default' domain (task-sources.js's defaultDomain),
# since task-sources.js's own getConfig().defaultDomain is what nextCandidateFulfillmentTask/
# nextTroubleLogTask/nextArchDiscoveryTask/nextArchImportTask/nextObservabilityReviewTask/
# nextPerformanceReviewTask/nextUnusedExportTask all stamp -- confirmed by reading each one directly, not assumed
# from the source name. Getting this mapping WRONG (or incomplete) is exactly what
# happened before this fix: 'default' was missing entirely from _DOMAIN_DEFAULTS_TO_ENSURE,
# so every arch_import/observability_review/trouble_log task failed immediately with
# "Unknown task domain: default" from its very first run against a freshly-started project
# (confirmed live 2026-07-26 on TaxHarvest: 250 tasks accumulated blocked before anyone
# noticed, since a blocked task produces no visible error beyond the Blocked tab's count).
_SOURCE_TO_DOMAIN_KEY = {
    "trouble_log": "default", "arch_review": "default", "arch_import_review": "default",
    "arch_discovery": "default", "arch_import": "default", "observability_review": "default",
    "performance_review": "default", "observability_fix": "default", "performance_fix": "default",
    "unused_export": "default",
    "project_search": "project_search", "deep_dive": "deep_dive",
    "brain_dump_sort": "brain_dump_sort", "secondbrain": "secondbrain", "adhoc": "adhoc",
    "path_prefetch_resolve": "path_prefetch_resolve", "pipeline_self_audit": "adhoc",
    "pipeline_forensics": "default", "pipeline_forensics_fix": "default",
    "staleness_audit": "default",
    "product_spec": "default", "product_spec_outline": "default", "product_spec_section": "default",
    "backlog_decomposition": "default", "backlog_fulfillment": "default",
}

_DOMAIN_DEFAULTS_TO_ENSURE = {
    "default": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "adhoc": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "secondbrain": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "project_search": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "deep_dive": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "brain_dump_sort": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "path_prefetch_resolve": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
}

# adhoc, brain_dump_sort, and (2026-08-16) path_prefetch_resolve are always in
# read_active_job_types()'s result regardless of any allowlist (see ALWAYS_ACTIVE_SOURCES
# above) -- ensure their domains unconditionally, a belt-and-suspenders floor in case some
# future call site ever passes a hand-built task_sources list that forgot one, since the
# failure mode ("Unknown task domain") is silent and easy to miss (as just proven).
_ALWAYS_ENSURE_DOMAINS = ["brain_dump_sort", "adhoc", "path_prefetch_resolve"]

# Human-readable domain label per domain KEY, for the Job List "Domain" column. The
# "default" key shows "(project default)" -- it's whatever the active project's
# defaultDomain resolves to, not a literal.
SOURCE_DOMAIN_LABELS = {"default": "(project default)"}

# One-line description per source name, for the Job List row. UI copy, not registry data --
# kept here (server-side, one place) rather than in a client-side JOB_TYPES const that
# drifted from the real registry. /api/job-types serves it; a source with no entry just
# renders a blank description cell.
SOURCE_DESCRIPTIONS = {
    "adhoc": "Manually submitted one-off task, queued via queue-adhoc-task.js. Drop-everything priority lane.",
    "research_task": "A captured Brain Dump entry brain_dump_sort classified as requiresResearch (queue/research/*.json), drafted by research-agentic-draft.js's WebSearch/WebFetch-backed agentic call. Always high-reasoning-tier. Same \"drop everything\" priority as adhoc.",
    "trouble_log": "Entries in the project's trouble-log doc flagged ready-for-agent (\U0001f916 marker).",
    "secondbrain": "Oldest unprocessed note in a SecondBrain-style Inbox/ folder.",
    "brain_dump_sort": "Sorts a captured Brain Dump entry into a second-brain destination and marks it filed. Always active -- see the Brain Dump tab.",
    "path_prefetch_resolve": "LLM-assisted fallback for a queue/needs-clarification/ held task path-prefetch's deterministic keyword match could not resolve -- suggests file path(s) + rationale for a human to accept or override, never auto-resolves. Always active.",
    "arch_review": "Strong-rated architecture candidates awaiting a fulfillment task. (agent-manager-hygiene plugin.)",
    "arch_import_review": "Strong-rated architecture-IMPORT candidates (from arch_import) awaiting a fulfillment task. (agent-manager-hygiene plugin.)",
    "arch_discovery": "Generates new architecture candidates for one graphify community at a time. (agent-manager-hygiene plugin.)",
    "arch_import": "Promotes a reviewed deep_dive Use/Adapt finding into an agent-manager-grounded architecture-import candidate (ADR-0020). (agent-manager-hygiene plugin.)",
    "observability_review": "Triages a deterministically-flagged observability-hygiene issue (silent catch, unguarded loop, OTel naming) in the active project as genuine or false-positive; a genuine verdict writes a candidate for observability_fix. (agent-manager-hygiene plugin.)",
    "observability_fix": "Consumes a Strong observability_review candidate into a real code fix, against OBSERVABILITY_FIX_CANDIDATES.md. (agent-manager-hygiene plugin.)",
    "performance_review": "Triages a deterministically-flagged performance issue (sync I/O in a loop, sequential await, JSON deep-clone) in the active project; a genuine verdict writes a candidate for performance_fix. (agent-manager-hygiene plugin.)",
    "performance_fix": "Consumes a Strong performance_review candidate into a real code fix, against PERFORMANCE_FIX_CANDIDATES.md. (agent-manager-hygiene plugin.)",
    "function_length_review": "Triages a deterministically-flagged over-long function in the active project as a genuine maintainability problem or false-positive; a genuine verdict writes a decomposition candidate for function_length_fix. (agent-manager-hygiene plugin.)",
    "function_length_fix": "Consumes a Strong function_length_review candidate into a real decomposition diff, against FUNCTION_LENGTH_CANDIDATES.md. (agent-manager-hygiene plugin.)",
    "deep_dive": "Reviews one import-graph community at a time from a project_search Strong lead's cloned repo, rating each finding Use/Adapt/Ignore (ADR-0019). See the Scouted Repos tab.",
    "project_search": "Proposes external open-source leads relevant to the project. Discovery-only, no auto-fulfillment.",
    "unused_export": "Triages a flagged dead-code candidate (exported symbol with few call sites) as genuine-dead or false-positive. (agent-manager-hygiene plugin.)",
    "pipeline_self_audit": "Deterministically scans queue/blocked/ for a cluster of tasks failing the same way; files an adhoc task asking a Claude agentic pass to find and fix the root cause. Always requires human confirmation.",
    "pipeline_health_audit": "Periodic deterministic check of the pipeline's own health signals; files an advisory when something looks wrong.",
    "pipeline_forensics": "Deep root-cause study of a class of pipeline tasks that keeps failing: assembles evidence (incl. a contrast set of tasks that succeeded), drafts a ranked root-cause report, holds it for human confirmation, then files a pipeline-fix candidate. Triggered by a needs-clarification cluster, a low-shipped-value task source, or an on-demand request.",
    "pipeline_forensics_fix": "Turns a confirmed pipeline_forensics fix candidate (Docs/PIPELINE_FIX_CANDIDATES.md) into a real src/ diff on an agent/ branch for manual merge.",
    "ui_visibility_audit": "Checks that pipeline state a human needs is actually surfaced in the dashboard; files an advisory for a gap.",
    "staleness_audit": "Deterministically scans queue/blocked/ and queue/needs-clarification/ for an old or repeatedly-rejected task; files an advisory asking whether the original concern still holds. Never applies anything.",
    "product_spec": "GREENFIELD lane: drafts or updates a concept-only product's spec doc blind on the local model (request text + current spec are the only grounding). A brownfield request goes to product_spec_outline instead.",
    "product_spec_outline": "BROWNFIELD lane, step 1: decomposes a product-spec request against a real codebase into ordered AC-NNN section candidates in PRODUCT_SPEC_OUTLINE.md, on the local model, grounded by harness grep. Its apply also seeds PRODUCT_SPEC.md as a marker skeleton.",
    "product_spec_section": "BROWNFIELD lane, step 2: drafts one PRODUCT_SPEC_OUTLINE.md section at a time (candidate-fulfillment) into its placeholder block in PRODUCT_SPEC.md, on the local model, grounded by that section's files plus its own harness grep.",
    "backlog_decomposition": "Breaks a product-spec backlog item into AC-NNN candidates in BACKLOG_CANDIDATES.md.",
    "backlog_fulfillment": "Consumes a Strong BACKLOG_CANDIDATES.md entry into a real diff -- same fulfillment logic as arch_review.",
}


def _ensure_task_domains(child_env: dict, raw_path: str, task_sources: list):
    """Confirmed live (2026-07-22, mission-control and TaxHarvest; recurred 2026-07-26,
    TaxHarvest again, 250 blocked tasks): review-runner.ps1 calls Get-DomainConfig for
    EVERY task's domain unconditionally (fact-checker.js's working-directory lookup,
    shared by both the ornith and claude review providers) -- not just git-based domains.
    A fresh project's task-domains.json missing even ONE domain key any ACTIVE task
    source needs blocks every task of that source type immediately with "Unknown task
    domain: ...", even for domains apply-task.js already special-cases correctly (no git
    involved). Rather than requiring every consumer project to know to pre-add these
    entries themselves, add whichever domain keys this run's active task_sources actually
    need -- additively, never overwriting an existing entry or any other key -- so this
    doesn't have to be rediscovered per-project. See _SOURCE_TO_DOMAIN_KEY's own comment
    for why this maps by DOMAIN KEY, not by source name directly (several sources share
    one domain)."""
    domain_keys_needed = {
        _SOURCE_TO_DOMAIN_KEY[s] for s in {*task_sources, *_ALWAYS_ENSURE_DOMAINS} if s in _SOURCE_TO_DOMAIN_KEY
    }
    relevant = [d for d in domain_keys_needed if d in _DOMAIN_DEFAULTS_TO_ENSURE]
    if not relevant:
        return

    domains_path_str = child_env.get("AGENT_MANAGER_DOMAINS_PATH")
    if domains_path_str:
        domains_path = Path(domains_path_str)
    else:
        pipeline_dir = child_env.get("AGENT_MANAGER_PIPELINE_DIR") or raw_path
        domains_path = Path(pipeline_dir) / "task-domains.json"

    domains = read_json_safe(domains_path) or {}
    if not isinstance(domains, dict):
        return
    changed = False
    for domain_key in relevant:
        if domain_key not in domains:
            domains[domain_key] = _DOMAIN_DEFAULTS_TO_ENSURE[domain_key]
            changed = True
    if not changed:
        return
    try:
        domains_path.parent.mkdir(parents=True, exist_ok=True)
        domains_path.write_text(json.dumps(domains, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.error("Failed to persist domain defaults to %s: %s", domains_path, exc, exc_info=True)


def _resolve_source_name(data: dict) -> str | None:
    """Mirrors src/task-source-registry.js's resolveSourceName() exactly -- most sources
    register under the same name as task.source, but three built-ins don't: adhoc tasks
    carry domain:'adhoc'/source:'manual', secondbrain tasks carry domain:'secondbrain'
    (source:'inbox'), and deadcode_triage was renamed to unused_export post-launch. Without
    this, every real adhoc task (a real, common, human-originated task type) would show up
    under an "(unregistered)" bucket labeled "manual" instead of the adhoc node on the map
    -- confirmed live building this: exactly that happened on the first real test."""
    domain = data.get("domain")
    source = data.get("source")
    if domain == "adhoc" or source == "manual":
        return "adhoc"
    if domain == "secondbrain":
        return "secondbrain"
    if source == "deadcode_triage":
        return "unused_export"
    return source


def _pipeline_live_counts(qdir) -> dict:
    """{source: {state: count}} across every in-flight queue state -- deliberately excludes
    done/ (thousands of historical records -- see queue_dir()'s own caller sites for the
    3700+ count confirmed live 2026-08-25) since the Pipeline Map tab shows the pipeline IN
    MOTION, not lifetime volume (that's what the Job List tab's timesPerformed counter is
    for). 'drafting' mirrors _task_state_index's own per-worker-subfolder-plus-legacy-flat
    handling. A task file with no readable/parseable `source` field (corrupt, mid-write, or
    predates this field existing) is bucketed under "(unknown)" rather than silently
    dropped or crashing the whole tab over one bad file."""
    counts: dict = {}
    if not qdir:
        return counts

    def bump(source, state):
        counts.setdefault(source or "(unknown)", {}).setdefault(state, 0)
        counts[source or "(unknown)"][state] += 1

    for state in QUEUE_STATES:
        if state == "done":
            continue
        state_dir = qdir / state
        if not state_dir.is_dir():
            continue
        for f in state_dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to read/parse queue state file %s: %s", f, exc)
                bump(None, state)
                continue
            bump(_resolve_source_name(data), state)

    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        drafting_files = list(drafting_root.glob("*.json"))
        for sub in drafting_root.iterdir():
            if sub.is_dir():
                drafting_files.extend(sub.glob("*.json"))
        for f in drafting_files:
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to read/parse drafting file %s: %s", f, exc)
                bump(None, "drafting")
                continue
            bump(_resolve_source_name(data), "drafting")

    return counts


@app.route("/api/pipeline-map")
def api_pipeline_map():
    """Pipeline Map tab (2026-08-26, Grimmethy: "I want a live pipeline map for
    architecture review... right now I don't have any way of visualizing the process").
    Topology comes straight from src/task-sources.js's own registry via `--dump-topology`
    (see that CLI mode's own header for why this, not another hand-maintained catalog like
    TASK_SOURCE_CATALOG below) -- read fresh on every call, so it can never drift the way
    the Job List tab's own hand-maintained lists already have (confirmed live via
    queue-watchdog's drift-scan the same night: missing backlog_decomposition/
    backlog_fulfillment/pipeline_health_audit/product_spec/ui_visibility_audit). Live counts
    come straight from the real queue/ directories, correlated by each task's own recorded
    `source` field -- never estimated, never cached across requests."""
    script_path = SRC_DIR / "task-sources.js"
    # Same env the pipeline loops themselves get (agent-manager.env on top of os.environ):
    # --dump-topology needs AGENT_MANAGER_REPO_ROOT to run at all, and
    # AGENT_MANAGER_REGISTER_PATH so out-of-tree plugin sources (agent-manager-hygiene:
    # observability/performance/function-length/arch/unused-export) show up in the map,
    # not just this repo's built-ins. Also picks up any UI-set priority/allowlist overrides.
    child_env = {**os.environ, **read_env_file(ENV_FILE_PATH)}
    try:
        result = subprocess.run(
            ["node", str(script_path), "--dump-topology"],
            capture_output=True, text=True, timeout=15,
            cwd=str(SRC_DIR), env=child_env,
        )
    except subprocess.TimeoutExpired:
        return jsonify({"available": False, "reason": "task-sources.js --dump-topology timed out"}), 504
    if result.returncode != 0:
        return jsonify({"available": False, "reason": (result.stderr or "task-sources.js exited non-zero").strip()[:500]})
    try:
        topology = json.loads(result.stdout)
    except json.JSONDecodeError:
        return jsonify({"available": False, "reason": "task-sources.js --dump-topology returned non-JSON output"})

    live_counts = _pipeline_live_counts(queue_dir())
    # turnsStats (2026-08-26, Grimmethy: "add turnsUsed recording... a data point we
    # track for each job type in the Job List itself (min/max/average)") -- same
    # merge-by-source-name shape as liveCounts just below; None for any source that has
    # never recorded a real turnsUsed count (not instrumented, or a non-agentic source
    # that has no concept of "turns" at all), not a fabricated zero.
    from model_stats_client import get_turns_summary
    turns_by_source = {row["source"]: row for row in (get_turns_summary() or {}).get("bySource", [])}
    for source in topology:
        source["liveCounts"] = live_counts.pop(source["name"], {})
        source["turnsStats"] = turns_by_source.pop(source["name"], None)
    # Anything left in live_counts belongs to a source no longer registered (a renamed/
    # retired source with old tasks still sitting in the queue, or the "(unknown)" bucket
    # from a corrupt/pre-source-field file) -- surfaced separately rather than silently
    # dropped, so a real orphaned backlog stays visible instead of vanishing from the map.
    unregistered = [{"name": name, "liveCounts": c} for name, c in live_counts.items()]

    return jsonify({"available": True, "sources": topology, "unregistered": unregistered})


@app.route("/api/job-types")
def api_job_types():
    """Job List tab's isActive checkboxes: one row per src/task-sources.js registered
    source, independent of whichever project is currently active -- same "sits above any
    single project" reasoning as Brain Dump. Backed entirely by AGENT_MANAGER_TASK_SOURCES
    in agent-manager.env, the same allowlist src/task-sources.js's getNextTask() already
    reads; this is just a UI over that one persisted value."""
    active = read_active_job_types()
    priorities = read_task_priorities()
    approval_modes = read_approval_modes()
    worker_types = read_worker_types()
    counters = read_job_type_counters()
    available_counts = available_candidate_counts()
    return jsonify([
        {
            "name": name,
            "active": name in active,
            "alwaysActive": name in ALWAYS_ACTIVE_SOURCES,
            "priority": priorities.get(name),
            "approvalMode": approval_modes.get(name),
            "workerType": worker_types.get(name),
            "timesPerformed": counters.get(name, 0),
            # None (-> null) for a source with no enumerable backlog doc -- see
            # available_candidate_counts()'s own comment; the frontend renders that as a
            # blank cell rather than a misleading 0.
            "available": available_counts.get(name),
            "domain": SOURCE_DOMAIN_LABELS.get(_SOURCE_TO_DOMAIN_KEY.get(name, name), _SOURCE_TO_DOMAIN_KEY.get(name, name)),
            "description": SOURCE_DESCRIPTIONS.get(name, ""),
        }
        for name in task_source_catalog()
    ])


def _job_log_task_dirs(qdir):
    """Every location a task JSON can sit -- same set _task_state_index walks -- yielded as
    (state_label, dir_path) so a per-source history sweep sees in-flight, done, and
    archived runs alike."""
    for state in QUEUE_STATES:
        yield state, qdir / state
    yield "adhoc", qdir / "adhoc"
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for sub in sorted(drafting_root.iterdir()):
            if sub.is_dir():
                yield "drafting", sub
        yield "drafting", drafting_root  # legacy: no per-worker subfolder
    yield "archived", qdir / "done" / "_archived_no_action"
    dated_archive_root = qdir / "done" / "_archived"
    if dated_archive_root.is_dir():
        for month_dir in sorted(dated_archive_root.iterdir(), reverse=True):
            if month_dir.is_dir():
                yield "archived", month_dir


def _job_log_row_when(data: dict):
    hist = data.get("history") or []
    last_at = hist[-1].get("at") if hist and isinstance(hist[-1], dict) else None
    return data.get("updatedAt") or last_at or data.get("createdAt") or ""


def _job_log_outcome(data: dict) -> str:
    # Same signal priority as the Discovery tab's runRows / _adhoc_task_excerpt.
    if data.get("blockedReason"):
        return str(data["blockedReason"])[:200]
    if data.get("doneMarker"):
        return str(data["doneMarker"])
    if data.get("implementResponse"):
        return "draft written"
    if data.get("planResponse"):
        return "plan written"
    return ""


@app.route("/api/job-log/<source>")
def api_job_log(source):
    """Job List tab: click a source -> its last ~25 runs, newest first, each drillable to
    the task-detail modal via /api/task-anywhere. Sweeps every queue state + drafting/ +
    adhoc/ + the archive buckets, matching on the same resolved source name the pipeline
    map uses."""
    qdir = queue_dir()
    if not qdir:
        abort(404)
    seen: set[str] = set()
    rows: list[dict] = []
    for state_label, d in _job_log_task_dirs(qdir):
        if not d or not d.is_dir():
            continue
        for f in d.glob("*.json"):
            if f.stem in seen:
                continue
            data = read_json_safe(f)
            if not data or _resolve_source_name(data) != source:
                continue
            seen.add(f.stem)
            cost = _task_cost_summary(f.stem)
            rows.append({
                "id": data.get("id") or f.stem,
                "title": (data.get("title") or "").strip(),
                "state": state_label,
                "at": _job_log_row_when(data),
                "outcome": _job_log_outcome(data),
                "latencyMs": cost.get("totalLatencyMs") if cost else None,
            })
    rows.sort(key=lambda r: r["at"] or "", reverse=True)
    return jsonify({"source": source, "total": len(rows), "runs": rows[:25]})


@app.route("/api/job-types/reset-counts", methods=["POST"])
def api_job_types_reset_counts():
    """Job List tab's "Reset counts" button. Deliberately resets EVERY job type's counter
    at once, never a single row -- see src/job-type-counters.js's header for why a per-type
    reset would leave the counters meaning different things depending on when each was last
    zeroed, defeating the point of a shared baseline."""
    p = job_type_counters_path()
    if not p:
        abort(400, description="no active pipeline directory to reset counters in")
    counters = read_job_type_counters()
    for name in counters:
        counters[name] = 0
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(counters, indent=2), encoding="utf-8")
    except OSError as e:
        abort(500, description=f"failed to write job-type-counters.json: {e}")
    return jsonify({"ok": True})


@app.route("/api/job-types/toggle", methods=["POST"])
def api_job_types_toggle():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    active = bool(body.get("active"))
    if name not in task_source_catalog():
        abort(400, description=f"unknown job type '{name}'")
    if name in ALWAYS_ACTIVE_SOURCES:
        abort(400, description=f"'{name}' is always active and cannot be toggled off")

    current = read_active_job_types()
    if active:
        current.add(name)
    else:
        current.discard(name)

    # Collapse back to "unrestricted" (empty string) when every source ends up active --
    # an explicit list naming all of TASK_SOURCE_CATALOG means exactly the same thing as
    # no list at all, and staying in that tidy round-trip avoids the allowlist silently
    # drifting out of sync if TASK_SOURCE_CATALOG ever gains a new entry later.
    if current == set(task_source_catalog()):
        new_value = ""
    else:
        new_value = ",".join(sorted(current - ALWAYS_ACTIVE_SOURCES))
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_TASK_SOURCES", new_value)

    # Take effect immediately, not just on the run's next manual restart -- the whole
    # point of moving this into a live checkbox instead of a config file edit is that
    # flipping it actually changes what the running pipeline does. Filesystem-queue-based
    # crash-resume (ornith-worker.ps1's orphaned-claim recovery) already makes this safe.
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True

    return jsonify({"name": name, "active": active, "restarted": restarted})


@app.route("/api/job-types/priority", methods=["POST"])
def api_job_types_priority():
    """Job List tab's editable Priority column (click-to-type or +-1 arrow buttons).
    Mirrors api_job_types_toggle()'s exact shape -- persists to AGENT_MANAGER_TASK_PRIORITIES
    in agent-manager.env, which src/config.js's taskPriorityOverrides reads fresh on every
    `node task-sources.js` invocation (a new process each worker tick), so an edit here
    takes effect on the very next tick with no pipeline restart needed."""
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if name not in task_source_catalog():
        abort(400, description=f"unknown job type '{name}'")
    try:
        priority = int(body.get("priority"))
    except (TypeError, ValueError):
        abort(400, description="priority must be an integer")

    priorities = read_task_priorities()
    priorities[name] = priority

    # Collapse back to "no overrides" (empty string) when every source ends up at its own
    # default -- same tidy-round-trip reasoning as api_job_types_toggle()'s allowlist collapse.
    non_default = {n: p for n, p in priorities.items() if p != task_source_default_priorities().get(n)}
    new_value = ",".join(f"{n}:{p}" for n, p in sorted(non_default.items()))
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_TASK_PRIORITIES", new_value)

    return jsonify({"name": name, "priority": priority})


@app.route("/api/job-types/approval-mode", methods=["POST"])
def api_job_types_approval_mode():
    """Job List tab's editable Approval Mode column (auto/prompt/approve). Mirrors
    api_job_types_priority()'s exact shape -- persists to AGENT_MANAGER_APPROVAL_MODES in
    agent-manager.env, which src/config.js's approvalModeOverrides reads fresh on every
    `node task-sources.js` invocation, so apply-runner.ps1's next automatic-loop tick
    (via --approval-modes) picks up the change with no pipeline restart needed."""
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    mode = (body.get("mode") or "").strip()
    if name not in task_source_catalog():
        abort(400, description=f"unknown job type '{name}'")
    if mode not in VALID_APPROVAL_MODES:
        abort(400, description=f"mode must be one of {VALID_APPROVAL_MODES}")

    modes = read_approval_modes()
    modes[name] = mode

    # Collapse back to "no overrides" (empty string) when every source ends up at the
    # current global default -- same tidy-round-trip reasoning as the priority/allowlist
    # collapses above.
    default = _default_approval_mode()
    non_default = {n: m for n, m in modes.items() if m != default}
    new_value = ",".join(f"{n}:{m}" for n, m in sorted(non_default.items()))
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_APPROVAL_MODES", new_value)

    return jsonify({"name": name, "approvalMode": mode})


@app.route("/api/job-types/worker-type", methods=["POST"])
def api_job_types_worker_type():
    """Job List tab's editable Worker Type column (ornith/reasoning) -- lets a human
    reassign which worker claims a given task type's tasks. Mirrors
    api_job_types_priority()'s exact shape -- persists to AGENT_MANAGER_TASK_TIERS in
    agent-manager.env (as the Node-side low/high tier names), which src/config.js's
    taskTierOverrides reads fresh on every `node task-sources.js` invocation and
    model-provider.js's reasoningTierFor() consults, so an edit here takes effect on the
    very next worker tick with no pipeline restart needed."""
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    worker_type = (body.get("workerType") or "").strip()
    if name not in task_source_catalog():
        abort(400, description=f"unknown job type '{name}'")
    if worker_type not in VALID_WORKER_TYPES:
        abort(400, description=f"workerType must be one of {VALID_WORKER_TYPES}")

    worker_types = read_worker_types()
    worker_types[name] = worker_type

    # Collapse back to "no overrides" (empty string) when every source ends up at its own
    # default -- same tidy-round-trip reasoning as the priority/approval-mode collapses above.
    worker_type_to_tier = {"ornith": "low", "reasoning": "high"}
    non_default = {
        n: worker_type_to_tier[wt] for n, wt in worker_types.items() if wt != task_source_default_worker_types().get(n)
    }
    new_value = ",".join(f"{n}:{t}" for n, t in sorted(non_default.items()))
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_TASK_TIERS", new_value)

    return jsonify({"name": name, "workerType": worker_type})


# --- Plugins tab ------------------------------------------------------------------------
# Enable/disable the AGENT_MANAGER_REGISTER_PATH plugins the manager is working on, and
# register a new one by path. Persists to plugins.json (PLUGINS_MANIFEST_PATH); src/
# config.js's ensureRegistered() loads only the enabled entries. Since every loop entry
# point re-runs ensureRegistered() in a fresh process per tick, a change takes effect on
# the next task -- the pipeline is still restarted on a change (like the Job List toggles)
# so an in-flight draft for a now-disabled source can't hit "no prompt template".

def _plugin_name_from_path(register_path: str) -> str:
    """A readable default name: the plugin repo's own directory name (…/agent-manager-hygiene/
    register.js -> "agent-manager-hygiene"), falling back to the file's parent basename."""
    p = Path(register_path)
    parent = p.parent
    return parent.name or p.stem or register_path


def _seed_plugins_manifest() -> list:
    """First-read migration: build the manifest from AGENT_MANAGER_REGISTER_PATH (the old
    single source of truth) so an existing install keeps exactly what it had, now toggleable."""
    raw = read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_REGISTER_PATH", "")
    entries = []
    seen = set()
    for path_str in [s.strip() for s in raw.split(",") if s.strip()]:
        if path_str in seen:
            continue
        seen.add(path_str)
        entries.append({
            "name": _plugin_name_from_path(path_str),
            "registerPath": path_str,
            "enabled": True,
            "description": "",
        })
    _write_plugins_manifest(entries)
    return entries


def _read_plugins_manifest() -> list:
    if not PLUGINS_MANIFEST_PATH.is_file():
        return _seed_plugins_manifest()
    try:
        parsed = json.loads(PLUGINS_MANIFEST_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return parsed if isinstance(parsed, list) else []


def _write_plugins_manifest(entries: list) -> None:
    PLUGINS_MANIFEST_PATH.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")


@app.route("/api/plugins")
def api_plugins():
    return jsonify({
        "plugins": _read_plugins_manifest(),
        "manifestPath": str(PLUGINS_MANIFEST_PATH),
    })


@app.route("/api/plugins/toggle", methods=["POST"])
def api_plugins_toggle():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    enabled = bool(body.get("enabled"))
    manifest = _read_plugins_manifest()
    match = next((p for p in manifest if p.get("name") == name), None)
    if match is None:
        abort(404, description=f"no plugin named '{name}'")
    match["enabled"] = enabled
    _write_plugins_manifest(manifest)
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True
    return jsonify({"name": name, "enabled": enabled, "restarted": restarted})


@app.route("/api/plugins/add", methods=["POST"])
def api_plugins_add():
    body = request.get_json(silent=True) or {}
    register_path = (body.get("registerPath") or "").strip()
    name = (body.get("name") or "").strip() or _plugin_name_from_path(register_path)
    description = (body.get("description") or "").strip()

    if not register_path:
        abort(400, description="registerPath is required")
    p = Path(register_path)
    if not p.is_absolute():
        abort(400, description="registerPath must be an absolute path")
    if not p.is_file() or p.suffix != ".js":
        abort(400, description=f"registerPath must point at an existing .js file (got {register_path})")

    manifest = _read_plugins_manifest()
    if any(pl.get("name") == name for pl in manifest):
        abort(409, description=f"a plugin named '{name}' is already registered")
    if any(pl.get("registerPath") == register_path for pl in manifest):
        abort(409, description="that registerPath is already registered")

    entry = {"name": name, "registerPath": register_path, "enabled": True, "description": description}
    manifest.append(entry)
    _write_plugins_manifest(manifest)
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True
    return jsonify({"plugin": entry, "restarted": restarted})


# --- Marketplace (plugin catalog) -------------------------------------------------------
# The catalog is a static, pre-generated JSON file (plugins-catalog.json) at the package
# root. These helpers only read and validate it, and expose it via GET
# /api/plugins/marketplace alongside installed-plugin status. Hand-rolled strict
# validation -- no jsonschema dependency.

def _validate_catalog_source(src):
    """Validates a catalog entry's 'source' dict. Returns an error string or None."""
    if not isinstance(src, dict):
        return "source must be an object"
    unknown = set(src) - {"type", "url", "ref"}
    if unknown:
        return f"source has unknown key(s): {', '.join(sorted(unknown))}"
    if src.get("type") not in ("git", "npm"):
        return "source.type must be 'git' or 'npm'"
    url = src.get("url")
    if not isinstance(url, str) or not url.strip():
        return "source.url must be a non-empty string"
    if "ref" in src and (not isinstance(src["ref"], str) or not src["ref"].strip()):
        return "source.ref must be a non-empty string"
    return None


def _validate_catalog_pricing(p):
    """Validates a catalog entry's optional 'pricing' dict. Returns an error string or None."""
    if not isinstance(p, dict):
        return "pricing must be an object"
    unknown = set(p) - {"model", "amount_cents", "currency", "interval"}
    if unknown:
        return f"pricing has unknown key(s): {', '.join(sorted(unknown))}"
    model = p.get("model")
    if model not in ("free", "one-time", "subscription"):
        return "pricing.model must be 'free', 'one-time', or 'subscription'"
    if model != "free":
        amount = p.get("amount_cents")
        if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
            return "pricing.amount_cents must be an integer >= 0"
        currency = p.get("currency")
        if not isinstance(currency, str) or not currency.strip() or len(currency) != 3:
            return "pricing.currency must be a non-empty 3-character string"
        if "interval" in p and (not isinstance(p["interval"], str) or not p["interval"].strip()):
            return "pricing.interval must be a non-empty string"
    return None


def _validate_catalog_entry(entry, index):
    """Validates one plugins[] entry. Returns an error string or None."""
    if not isinstance(entry, dict):
        return f"plugins[{index}] must be an object"
    unknown = set(entry) - {
        "id", "name", "summary", "description", "version",
        "source", "tags", "license", "min_agent_manager", "pricing",
    }
    if unknown:
        return f"plugins[{index}] has unknown key(s): {', '.join(sorted(unknown))}"
    for field in ("id", "name", "summary", "description", "version"):
        val = entry.get(field)
        if not isinstance(val, str) or not val.strip():
            return f"plugins[{index}].{field} must be a non-empty string"
    if not re.match(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.\-]+)?$", entry["version"]):
        return f"plugins[{index}].version must look like X.Y.Z or X.Y.Z-prerelease"
    src_err = _validate_catalog_source(entry.get("source"))
    if src_err:
        return f"plugins[{index}].{src_err}"
    if "tags" in entry:
        tags = entry["tags"]
        if not isinstance(tags, list) or any(not isinstance(t, str) or not t.strip() for t in tags):
            return f"plugins[{index}].tags must be a list of non-empty strings"
    for opt in ("license", "min_agent_manager"):
        if opt in entry and not isinstance(entry[opt], str):
            return f"plugins[{index}].{opt} must be a string"
    if "pricing" in entry:
        p_err = _validate_catalog_pricing(entry["pricing"])
        if p_err:
            return f"plugins[{index}].{p_err}"
    return None


def validate_plugin_catalog(doc):
    """Strict validation of the whole catalog document. Returns an error string or None."""
    if not isinstance(doc, dict):
        return "catalog must be a JSON object"
    unknown = set(doc) - {"catalog_version", "generated_at", "plugins"}
    if unknown:
        return f"catalog has unknown key(s): {', '.join(sorted(unknown))}"
    cv = doc.get("catalog_version")
    if not isinstance(cv, int) or isinstance(cv, bool) or cv < 1:
        return "catalog_version must be an integer >= 1"
    ga = doc.get("generated_at")
    if not isinstance(ga, str):
        return "generated_at must be a string"
    try:
        datetime.fromisoformat(ga)
    except (TypeError, ValueError):
        return "generated_at must be a valid ISO-8601 timestamp"
    plugins = doc.get("plugins")
    if not isinstance(plugins, list):
        return "plugins must be a list"
    seen_ids = set()
    for i, entry in enumerate(plugins):
        err = _validate_catalog_entry(entry, i)
        if err:
            return err
        if isinstance(entry, dict):
            if entry.get("id") in seen_ids:
                return f"duplicate plugin id '{entry.get('id')}'"
            seen_ids.add(entry.get("id"))
    return None


def _read_plugin_catalog():
    """Reads and validates PLUGIN_CATALOG_PATH. Returns (doc, None) on success,
    ({}, reason) if the file is missing, unreadable, or fails validation."""
    if not PLUGIN_CATALOG_PATH.is_file():
        return {}, f"catalog file not found: {PLUGIN_CATALOG_PATH}"
    try:
        doc = json.loads(PLUGIN_CATALOG_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        return {}, f"failed to read catalog: {e}"
    err = validate_plugin_catalog(doc)
    if err:
        return {}, err
    return doc, None


def _version_tuple(v):
    """Parses 'X.Y.Z(-tail)' into a comparable tuple; returns the (0,) sentinel for
    anything unparseable so mixed values compare safely."""
    if not isinstance(v, str):
        return (0,)
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.\-]+)?$", v)
    if not m:
        return (0,)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _installed_plugin_version(manifest, plugin_id):
    """The 'version' field of the first manifest entry whose 'name' == plugin_id, else
    None. The manifest's 'name' is the plugin repo's directory slug (see
    _plugin_name_from_path) -- the same value a catalog entry carries as 'id', NOT the
    catalog's human-readable 'name'."""
    for entry in manifest:
        if isinstance(entry, dict) and entry.get("name") == plugin_id:
            return entry.get("version")
    return None


def _plugins_install_dir() -> Path:
    """The directory plugins are installed into: $AGENT_MANAGER_PLUGINS_DIR if set and
    non-empty, else the default <package root>/plugins."""
    env_val = os.environ.get(PLUGINS_INSTALL_DIR_ENV, "")
    if env_val:
        return Path(env_val)
    return PLUGINS_INSTALL_DIR_DEFAULT


@app.route("/api/plugins/marketplace")
def api_plugins_marketplace():
    """Marketplace listing: the validated catalog entries annotated with whether each
    plugin is installed and whether a newer version than the installed one is
    available. Always 200 -- an unreadable/invalid catalog means entries [] with
    catalogError set."""
    doc, err = _read_plugin_catalog()
    manifest = _read_plugins_manifest()
    entries = []
    for raw in doc.get("plugins", []):
        if not isinstance(raw, dict):
            continue
        entry = dict(raw)
        # Match on the catalog entry's 'id' (the repo slug), which is what the installed-
        # plugins manifest stores as its 'name' -- NOT the catalog's human-readable 'name'.
        plugin_id = raw.get("id")
        installed = any(isinstance(p, dict) and p.get("name") == plugin_id for p in manifest)
        installed_version = _installed_plugin_version(manifest, plugin_id)
        update_available = bool(
            installed
            and installed_version
            and _version_tuple(raw.get("version")) > _version_tuple(installed_version)
        )
        entry["installed"] = installed
        entry["installedVersion"] = installed_version
        entry["updateAvailable"] = update_available
        entries.append(entry)
    return jsonify({
        "catalogError": err,
        "pluginsDir": str(_plugins_install_dir()),
        "entries": entries,
    })


def _stop_pipeline(force: bool = False) -> list:
    """Stops whatever launch.sh/launch.bat started. On Windows, kills by PID from the
    current instances/*.json heartbeats (same trust model queue-watchdog.ps1's own
    dead-process check already uses) via taskkill. On Linux there is no taskkill --
    confirmed live (2026-08-15): every call here silently no-op'd (OSError from the
    missing binary, caught and ignored) except for deleting the heartbeat file below, so
    Stop Pipeline in the dashboard *looked* successful (heartbeats vanished, UI showed
    stopped) while every daemon kept running untouched in the background. Linux instead
    shells out to scripts/stop.sh, which SIGTERMs each daemon by its launch.sh pidfile,
    waits out a grace period for it to exit cleanly (see each daemon's own trap), and
    SIGKILLs stragglers -- the actual kill logic lives there, not duplicated here.

    force=False (the toggle button's first click) launches stop.sh in the background and
    returns immediately -- the frontend's existing 3s status poll picks up the moment
    daemons actually exit, and the toggle offers a force option meanwhile rather than the
    request hanging open for up to the grace period. force=True (the toggle's second
    click, or _restart_pipeline() which needs this to be synchronous) waits for stop.sh's
    own --force path, which skips SIGTERM/grace entirely and SIGKILLs immediately.

    Does NOT touch anything if nothing looks like it's running, so this is safe to call
    even when unsure. Shared by /api/pipeline/stop and _restart_pipeline()."""
    inst_dir = instances_dir()
    stopped = []
    if inst_dir and inst_dir.is_dir():
        for f in inst_dir.glob("*.json"):
            data = read_json_safe(f)
            if data and data.get("instanceId"):
                stopped.append(data["instanceId"])
            if os.name == "nt":
                pid = data.get("pid") if data else None
                if pid:
                    try:
                        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=10)
                    except (OSError, subprocess.SubprocessError) as exc:
                        logger.warning("taskkill failed for PID %s (instance: %s): %s", pid, f, exc)
            # Confirmed live (2026-07-22): without this, _pipeline_running()'s worker-1
            # heartbeat check kept reporting the pipeline as running for up to
            # WORKING_STALE_SECONDS (20 min) after a real, successful stop -- the killed
            # process's last-written heartbeat file just sat there looking recent, and
            # /api/pipeline/start's "already running" guard blocked a genuine restart the
            # whole time. Remove the heartbeat regardless of whether the kill itself
            # reported success (the process may have already been dead) -- either way,
            # this instance should no longer read as live.
            try:
                f.unlink()
            except OSError:
                pass

    if os.name != "nt":
        stop_sh = PACKAGE_ROOT / "scripts" / "stop.sh"
        if stop_sh.is_file():
            args = ["bash", str(stop_sh), "--keep-dashboard"]
            if force:
                args.append("--force")
            try:
                if force:
                    # --force SIGKILLs immediately, no grace-period wait -- fast enough to
                    # block on, and _restart_pipeline() needs the old daemons actually gone
                    # before it starts new ones against the same pidfiles/queue dir.
                    subprocess.run(args, capture_output=True, timeout=10)
                else:
                    # Backgrounded so this request returns immediately instead of holding
                    # the (single-threaded dev server) connection open for up to the grace
                    # period -- the toggle button's second click (force) needs to reach the
                    # server promptly, not queue behind this one.
                    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            except (OSError, subprocess.SubprocessError, ValueError) as exc:
                logger.error(
                    "Failed to launch pipeline stop command (force=%s, args=%s): %s: %s",
                    force, args, type(exc).__name__, exc,
                )
                stopped = False

    return stopped


def _start_pipeline(raw_path: str, include_apply: bool, skip_push: bool) -> dict:
    """Writes the chosen path/toggles into agent-manager.env (creating the file if it
    doesn't exist yet) and spawns the relevant loops as real, visible console windows,
    same as launch.bat's own `start powershell.exe -NoExit ...` pattern -- shared by
    /api/pipeline/start and _restart_pipeline()."""
    record_project_used(raw_path)
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_REPO_ROOT", raw_path)
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_INCLUDE_APPLY", "true" if include_apply else "false")
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_APPLY_SKIP_PUSH", "true" if skip_push else "false")

    # Fix, 2026-07-26 (Grimmethy: "I keep setting the Project tab's path to TaxHarvest,
    # but it doesn't stick -- navigating away and back reverts to agent-manager"):
    # get_active_repo_root() checks os.environ FIRST, only falling back to the .env FILE
    # if unset -- by design, so a project pre-configured via launch.bat's own env vars
    # wins at startup rather than a stale leftover .env value silently overriding it. But
    # writing the new path to the file above was never reflected back into THIS already-
    # running dashboard process's own os.environ, so get_active_repo_root() kept
    # returning whatever the dashboard happened to be launched with, forever -- no
    # dashboard restart, no amount of clicking Start Pipeline, would ever change what it
    # reported as active. Mutating os.environ here keeps the original precedence (an
    # externally-set env var still wins at the NEXT dashboard restart) while making an
    # in-dashboard project switch actually take effect and persist for the rest of this
    # process's lifetime, matching what the Project tab visibly promises.
    os.environ["AGENT_MANAGER_REPO_ROOT"] = raw_path

    # Fix, 2026-08-20 (Grimmethy: "I'm still only seeing the agent manager and it's clone
    # [in the Project tab] -- we should be able to select from any of the projects"):
    # AGENT_MANAGER_PIPELINE_DIR/AGENT_MANAGER_DOMAINS_PATH were NEVER written here at
    # all -- only REPO_ROOT/INCLUDE_APPLY/SKIP_PUSH were -- so switching to a project with
    # its own dedicated pipeline dir (several new plugin repos this session each got one,
    # separate from repoRoot so pipeline internals don't land inside the tracked git repo)
    # silently kept whatever pipelineDir the PREVIOUSLY active project left behind in the
    # shared .env, real risk of one project's tasks landing in a completely different
    # project's live queue. If this repoRoot was already registered (via a prior Start
    # Pipeline, or set up directly -- see record_project_registry_entry), honor ITS
    # pipelineDir/domainsPath instead of leaving the stale previous value in place; a
    # genuinely first-time repo still falls through to the old raw_path-based default
    # below, unchanged.
    normalized_raw_path = os.path.normpath(raw_path)
    existing_registration = next(
        (e for e in read_project_registry() if os.path.normpath(e.get("repoRoot", "")) == normalized_raw_path),
        None,
    )
    if existing_registration and existing_registration.get("pipelineDir"):
        write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_PIPELINE_DIR", existing_registration["pipelineDir"])
        os.environ["AGENT_MANAGER_PIPELINE_DIR"] = existing_registration["pipelineDir"]
        if existing_registration.get("domainsPath"):
            write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_DOMAINS_PATH", existing_registration["domainsPath"])
            os.environ["AGENT_MANAGER_DOMAINS_PATH"] = existing_registration["domainsPath"]

    env_overrides = read_env_file(ENV_FILE_PATH)
    env_overrides["AGENT_MANAGER_REPO_ROOT"] = raw_path
    child_env = {**os.environ, **env_overrides}

    _ensure_task_domains(child_env, raw_path, list(read_active_job_types()))

    # Same pipelineDir/domainsPath resolution _ensure_task_domains just used above --
    # recorded here so a later brain-dump routing decision can locate THIS project's
    # queue even after a different project becomes active (project-history.json alone
    # only ever stored the bare repoRoot).
    pipeline_dir_for_registry = child_env.get("AGENT_MANAGER_PIPELINE_DIR") or raw_path
    domains_path_for_registry = child_env.get("AGENT_MANAGER_DOMAINS_PATH") or str(Path(pipeline_dir_for_registry) / "task-domains.json")
    record_project_registry_entry(raw_path, pipeline_dir_for_registry, domains_path_for_registry)

    # Explicit pipeline start is a "GPU work now" signal -- stomp any ComfyUI GPU lease
    # PromptForge left behind so the local-model daemons don't yield their ticks to a
    # generation that isn't the priority anymore (see comfyui_lease_held in
    # agent-manager-common.sh). scripts/launch.sh does the same on the Linux path; this
    # also covers the Windows .ps1 path below.
    _comfy_lease = Path(
        os.environ.get("AGENT_MANAGER_COMFY_LEASE_PATH")
        or (Path(os.environ.get("HOME") or "~").expanduser()
            / ".local/state/agent-manager/comfyui-lease.json")
    )
    try:
        _comfy_lease.unlink(missing_ok=True)
    except OSError as exc:
        logger.debug("ComfyUI lease unlink failed: %s", exc, exc_info=True)

    if os.name != "nt":
        import platform, subprocess as sp, shlex
        LOG_DIR = Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/logs"
        launch_py = str(PACKAGE_ROOT / 'scripts' / 'launch.sh')
        if not Path(launch_py).is_file():
            return {"started": False, "reason": f"{launch_py} missing; cannot start daemons on Linux without a working launch script."}
        subprocess.Popen(
            ["bash", launch_py],
            env=child_env,
            cwd=str(PACKAGE_ROOT),
            stdout=(LOG_DIR / 'launch-python.log').open('a'),
            stderr=sp.STDOUT,
            start_new_session=True,
        )
        return {"started": True, "repoRoot": raw_path}

    creationflags = subprocess.CREATE_NEW_CONSOLE
    scripts = [
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "local-worker.ps1"), "-InstanceId", "worker-1"], "Local Worker 1"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "review-runner.ps1")], "Local Review Runner"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "queue-watchdog.ps1")], "Queue Watchdog"),
    ]
    if include_apply:
        scripts.insert(2, (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "apply-runner.ps1")], "Apply Runner"))

    for args, _label in scripts:
        subprocess.Popen(args, env=child_env, creationflags=creationflags, cwd=str(PACKAGE_ROOT))

    return {"started": True, "repoRoot": raw_path, "includeApply": include_apply, "skipPush": skip_push}


def _restart_pipeline():
    """Stop, then start again against whatever's currently persisted in agent-manager.env
    (repoRoot + includeApply/skipPush) -- used when a Job List toggle needs to take effect
    on an already-running pipeline immediately, not just on the next manual restart."""
    env = read_env_file(ENV_FILE_PATH)
    raw_path = env.get("AGENT_MANAGER_REPO_ROOT", "")
    if not raw_path or not Path(raw_path).is_dir():
        return
    _stop_pipeline(force=True)  # needs to be synchronous -- start_pipeline() below must not race a still-shutting-down daemon for the same pidfiles/queue dir
    include_apply = env.get("AGENT_MANAGER_INCLUDE_APPLY", "false") == "true"
    skip_push = env.get("AGENT_MANAGER_APPLY_SKIP_PUSH", "true") == "true"
    _start_pipeline(raw_path, include_apply, skip_push)


@app.route("/api/pipeline/start", methods=["POST"])
def api_pipeline_start():
    """The Project tab's entry point. includeApply controls whether apply-runner.ps1 runs
    at all (False = nothing can touch the target repo's files or git history, the safest
    setting). skipPush no longer prevents pushing -- src/apply-task.js's applyTask() now
    always pushes applied work regardless (an unpushed branch was a real durability risk,
    confirmed live 2026-08-16/17: ~300 were silently lost to a bulk local branch cleanup
    over time). What it still controls: whether the local checkout returns to main after
    each apply, or stays on the applied branch for inspection. Which job TYPES run is no
    longer chosen here -- see /api/job-types, a top-level setting independent of which
    project this starts against."""
    if _pipeline_running():
        return jsonify({"started": False, "reason": "a pipeline is already running -- stop it first"}), 409

    body = request.get_json(silent=True) or {}
    raw_path = (body.get("path") or "").strip()
    if not raw_path:
        abort(400, description="path is required")
    if not Path(raw_path).is_dir():
        abort(404, description="path does not exist")

    include_apply = bool(body.get("includeApply", False))
    skip_push = bool(body.get("skipPush", True))

    result = _start_pipeline(raw_path, include_apply, skip_push)
    status_code = 200 if result.get("started") else 501
    return jsonify(result), status_code


@app.route("/api/pipeline/stop", methods=["POST"])
def api_pipeline_stop():
    body = request.get_json(silent=True) or {}
    force = bool(body.get("force", False))
    return jsonify({"stopped": _stop_pipeline(force=force)})


def _is_loopback_host(host: str) -> bool:
    return host in ("127.0.0.1", "localhost", "::1")


if __name__ == "__main__":
    _filled = backfill_env_from_file(ENV_FILE_PATH)
    if _filled:
        print(f"[dashboard] backfilled {len(_filled)} env var(s) from agent-manager.env "
              f"(not started via launch.sh): {', '.join(sorted(_filled))}", file=sys.stderr)

    port = int(os.environ.get("AGENT_MANAGER_DASHBOARD_PORT", "7420"))
    # Default stays loopback-only; AGENT_MANAGER_DASHBOARD_HOST=0.0.0.0 (or a specific LAN
    # IP) opts into LAN access for the companion app (see lan_mutation_gate above for what
    # that changes on the auth side).
    host = os.environ.get("AGENT_MANAGER_DASHBOARD_HOST", "127.0.0.1").strip() or "127.0.0.1"

    # TLS: AGENT_MANAGER_DASHBOARD_CERT/_KEY point at a cert/key pair (self-signed via
    # openssl/mkcert is fine -- see README's Dashboard section) so app.run() below can
    # terminate HTTPS itself. Binding to a non-loopback host without them means every
    # request -- including the claude-token setter and the Bearer token itself -- would
    # cross the LAN in plaintext, so that combination is refused outright rather than
    # silently serving plaintext HTTP to other machines. Running behind a reverse proxy
    # (Caddy/Nginx/Tailscale serve, README documents Caddy) is the other supported path:
    # in that setup AGENT_MANAGER_DASHBOARD_HOST stays at its loopback default and the
    # proxy is what binds the LAN-facing address and terminates TLS.
    cert_path = (os.environ.get("AGENT_MANAGER_DASHBOARD_CERT") or "").strip()
    key_path = (os.environ.get("AGENT_MANAGER_DASHBOARD_KEY") or "").strip()
    ssl_context = None
    if cert_path or key_path:
        if not (cert_path and key_path):
            sys.exit(
                "AGENT_MANAGER_DASHBOARD_CERT and AGENT_MANAGER_DASHBOARD_KEY must both be "
                "set to enable HTTPS -- only one was provided."
            )
        ssl_context = (cert_path, key_path)
    elif not _is_loopback_host(host):
        sys.exit(
            f"AGENT_MANAGER_DASHBOARD_HOST={host!r} binds off loopback, which sends "
            "credentials and task data over the network in plaintext unless TLS is "
            "terminated somewhere. Either set AGENT_MANAGER_DASHBOARD_CERT/_KEY to a "
            "cert/key pair so this process serves HTTPS directly, or put a TLS-terminating "
            "reverse proxy (Caddy/Nginx/Tailscale serve) in front and leave "
            "AGENT_MANAGER_DASHBOARD_HOST unset -- see the README's Dashboard section."
        )

    active = get_active_repo_root()
    print(f"Dashboard reading pipeline dir: {get_pipeline_dir() if active else '(none configured yet -- use the Project tab)'}")
    print(f"Open {'https' if ssl_context else 'http'}://localhost:{port}")
    # use_reloader=True alone (Werkzeug watches app.py's directory, restarts the whole
    # process on change) WITHOUT debug=True -- confirmed live 2026-07-25: a dashboard
    # process left running all night served stale API endpoints for hours after multiple
    # rounds of app.py edits, since nothing ever restarted it. Deliberately NOT full
    # debug=True: that also enables Werkzeug's interactive debugger, which lets anyone who
    # can reach this port execute arbitrary Python from an error page's traceback --
    # unnecessary risk for a hot-reload need that use_reloader alone already covers.
    # Pipeline state (_pipeline_running() etc.) is read fresh from instances/*.json on
    # every call, never held in Python memory across requests, so a reloader-triggered
    # restart can't lose track of anything.
    # threaded=True (2026-08-22): Flask's dev server is single-request-at-a-time by
    # default, which meant the continuous 5s nav-badge poll (plus any other open tab, or
    # a second client like the phone app) could starve a slower request behind it purely
    # by arrival order -- confirmed live as the direct cause of "/api/adhoc-tasks -> timed
    # out after 8s" (a real request that took ~1s in isolation) once queue/done/ grew
    # large enough to make ANY request briefly slower. Every route here already reads
    # state fresh from disk on each call (see the comment just above -- no shared
    # in-memory state to race on), so allowing overlapping requests is safe, not just a
    # speed hack.
    # Chat panel reservation idle-timeout sweep -- daemon=True, same fire-and-forget
    # shape as _run_build's own background thread; see _chat_reservation_watchdog's own
    # docstring for why this has to be built here rather than reused from elsewhere.
    threading.Thread(target=_chat_reservation_watchdog, daemon=True).start()
    # Hardware stats sampler -- 10s interval, 24h retention (Grimmethy, 2026-08-24): the
    # module's own start_sampler() already implements the sleep-and-sweep loop (same
    # daemon=True shape as _chat_reservation_watchdog above), it just wasn't called from
    # anywhere yet. /api/hardware/stats reads whatever this thread has persisted.
    hardware_stats.start_sampler(interval_seconds=10, retention_hours=24)

    app.run(host=host, port=port, debug=False, use_reloader=True, threaded=True, ssl_context=ssl_context)
