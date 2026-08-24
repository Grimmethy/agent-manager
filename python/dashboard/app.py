#!/usr/bin/env python3
"""Read-only monitoring dashboard for the agent-manager pipeline. No database, no build
step -- reads queue/*.json and instances/*.json directly off disk, the same filesystem
state every other part of this package already uses.

Usage: python dashboard/app.py
Reads AGENT_MANAGER_PIPELINE_DIR (or AGENT_MANAGER_REPO_ROOT as a fallback) for where
queue/ and instances/ live, same as every other script in this package.
AGENT_MANAGER_DASHBOARD_PORT (default 7420) picks the port.
"""

import fcntl
import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import string
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, abort, request
from werkzeug.exceptions import HTTPException

# build_graph.py / visualize_graph.py live one directory up (python/), not inside
# dashboard/ -- added explicitly rather than relying on an installed package, matching
# this whole project's no-build-step, run-from-source philosophy.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import build_graph  # noqa: E402
import visualize_graph  # noqa: E402

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


_NEEDS_CLARIFICATION_REASON_TEXT = {
    "no-match": "No matching file found for this change.",
    "ambiguous": "Multiple candidate files found -- needs a human pick.",
}


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
        except Exception:
            pass  # unreadable feed file -- queue-derived alerts still go out

    return jsonify({"generatedAt": generated_at, "alerts": alerts})


QUEUE_STATES = ["pending", "review", "approved", "blocked", "done", "needs-clarification", "awaiting-confirm"]

# dashboard/ -> python/ -> package root (where agent-manager.env, launch.bat, and src/ live).
PACKAGE_ROOT = Path(__file__).resolve().parent.parent.parent
ENV_FILE_PATH = PACKAGE_ROOT / "agent-manager.env"
SRC_DIR = PACKAGE_ROOT / "src"

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
    except OSError:
        pass


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
    error" page with no indication of what actually went wrong or how to fix it."""
    from claude_client import ClaudeClientError
    try:
        return fn(*args, **kwargs)
    except ClaudeClientError as e:
        abort(502, description=str(e))


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
    except OSError:
        pass

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
        cache = _fallback_cache_paths(path_str, grep_dirs)
        cache["dir"].mkdir(parents=True, exist_ok=True)
        return cache


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


def get_active_repo_root() -> str | None:
    """Env vars (set by launch.bat, or by whatever launched this process) win first --
    that's still how the 4 pipeline loops themselves get configured. Falling back to
    reading agent-manager.env directly means the dashboard also works when started with
    NO env vars pre-set at all (e.g. launch.bat now starts it unconditionally, project
    or not) and still remembers whatever project was last started via the Project tab."""
    v = os.environ.get("AGENT_MANAGER_REPO_ROOT")
    if v:
        return v
    return read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_REPO_ROOT")


def get_active_grep_dirs() -> str | None:
    """Same env-then-file resolution as get_active_repo_root(), for the one other setting
    Ornith's harness-mediated retrieval needs (discuss_sessions.py's
    _ornith_harness_context) -- grep-codebase-tool.js/arch-import-fetch.js's own repoRoot-
    relative search scope. Unset means grep_fetch_client falls back to the same
    'frontend/src,backend/src' default src/config.js's getConfig() already uses for every
    other AGENT_MANAGER_GREP_DIRS consumer."""
    v = os.environ.get("AGENT_MANAGER_GREP_DIRS")
    if v:
        return v
    return read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_GREP_DIRS")


def get_pipeline_dir() -> Path | None:
    pipeline_dir = os.environ.get("AGENT_MANAGER_PIPELINE_DIR")
    if pipeline_dir:
        return Path(pipeline_dir)
    repo_root = get_active_repo_root()
    if not repo_root:
        return None
    pipeline_dir = read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_PIPELINE_DIR") or repo_root
    return Path(pipeline_dir)


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
    """Same SECOND_BRAIN_DIR env var ornith-worker.ps1 / src/config.js already read --
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
    except OSError:
        return []
    repos = []
    for child in candidates:
        try:
            if child.is_dir() and (child / ".git").exists():
                repos.append({"name": child.name, "path": str(child)})
        except OSError:
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
        "ornithRejectCount": data.get("ornithRejectCount"),
        # Small (a reason string + a handful of short candidate paths at most) -- nothing
        # like the promptContext/planResponse bulk excluded above, and the needs-
        # clarification row rendering needs it to show WHICH kind of hold this is without
        # a second round-trip per row.
        "needsClarification": data.get("needsClarification"),
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
    must not look like a winner in a raw tok/s-only view."""
    db_path = model_stats_db_path()
    if not db_path or not db_path.is_file():
        return jsonify([])

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
    return jsonify(results)


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
        return jsonify([])
    if result.returncode != 0:
        return jsonify([])
    try:
        cases = json.loads(result.stdout)
    except json.JSONDecodeError:
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
            "SELECT COALESCE(SUM(cost_usd), 0), COUNT(*), SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) "
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
    total_cost, total_calls, calls_with_cost = row
    if total_calls == 0:
        return None
    return {
        "totalCostUsd": total_cost, "totalCalls": total_calls, "callsWithCost": calls_with_cost or 0,
        "hypotheticalCostUsd": hypothetical_cost_usd,
    }


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
                    return jsonify({**data, "_costSummary": _task_cost_summary(task_id)})
        abort(404)

    if state not in QUEUE_STATES:
        abort(404)
    f = qdir / state / f"{task_id}.json"
    data = read_json_safe(f)
    if not data:
        abort(404)
    return jsonify({**data, "_costSummary": _task_cost_summary(task_id)})


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

    approved_dir = qdir / "approved"
    approved_dir.mkdir(parents=True, exist_ok=True)
    dest = approved_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in approved/")
    dest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    src.unlink()
    return jsonify({"id": task_id, "confirmed": True})


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
    un-archived through the UI before this)."""
    if state not in ("blocked", "done", "archived"):
        abort(400, description="only a blocked, done, or archived task can be requeued")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = (qdir / "done" / "_archived_no_action" / f"{task_id}.json") if state == "archived" \
        else (qdir / state / f"{task_id}.json")
    data = read_json_safe(src)
    if not data:
        abort(404)

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
    except subprocess.TimeoutExpired:
        return jsonify({"id": task_id, "applied": False, "reason": "apply-runner.ps1 -TaskId did not finish within 300s (still may complete -- check the Done/Blocked tabs)"}), 504

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
                return jsonify({**data, "_foundState": "drafting", "_costSummary": _task_cost_summary(task_id)})

    for state in QUEUE_STATES:
        data = read_json_safe(qdir / state / f"{task_id}.json")
        if data:
            return jsonify({**data, "_foundState": state, "_costSummary": _task_cost_summary(task_id)})

    abort(404, description=f"task {task_id} not found in any queue state")


def _adhoc_task_excerpt(data):
    """Short status-relevant snippet for the Adhoc Tasks list -- whichever field
    actually carries the human-relevant signal for wherever the task currently sits,
    same fields api_alerts() already reads for the same reason."""
    if data.get("blockedReason"):
        return data["blockedReason"][:200]
    if data.get("ornithVerdict"):
        return data["ornithVerdict"][:200]
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
                "ornithRejectCount": data.get("ornithRejectCount"),
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
        except OSError:
            pass  # doc unreadable -- tab still renders coverage/tasks

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
                             grep_dirs=get_active_grep_dirs())
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
                             grep_dirs=get_active_grep_dirs())
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
                             grep_dirs=get_active_grep_dirs())
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
                nc.pop("suggested", None)
                nc["suggestionAttempted"] = False
                # Brain Dump #77: reset alongside suggestionAttempted so a human-reopened
                # task gets a fresh automatic low-then-high reasoning pair again, not just
                # the low tier (see task-sources.js's nextPathPrefetchResolveTask()).
                nc["highReasoningAttempted"] = False
                # Bumped so nextPathPrefetchResolveTask()'s resolve-task id includes the
                # attempt number -- without this, a second attempt's id collides with the
                # first attempt's now-done/ file forever (taskIdExistsInQueue() checks
                # done/ too), silently blocking every re-attempt after Discuss.
                nc["attempt"] = nc.get("attempt", 1) + 1
                held_path.write_text(json.dumps(held_task, indent=2), encoding="utf-8")

    return jsonify({"session": session, "entry": entry, "noteUpdated": note_updated, "heldTask": held_task})


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
        result = build_graph.build_graph_data(Path(path_str), grep_dirs, ollama_url, local_model, progress=progress)

        cache = resolve_writable_cache(path_str, grep_dirs)
        cache["graph"].write_text(json.dumps(result["graph"], indent=2), encoding="utf-8")
        cache["coverage"].write_text(json.dumps(result["coverage"], indent=2), encoding="utf-8")
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


def _pipeline_running() -> bool:
    """A pipeline counts as running if worker-1's own heartbeat is fresh -- the other 3
    loops matter too, but the worker is the one that actually produces work, and checking
    just one avoids this being wrong the moment any ONE of the other 3 is mid-restart."""
    inst_dir = instances_dir()
    if not inst_dir or not inst_dir.is_dir():
        return False
    worker_hb = inst_dir / "worker-1.json"
    data = read_json_safe(worker_hb)
    if not data or not data.get("lastHeartbeat"):
        return False
    last_hb = parse_hb_timestamp(data["lastHeartbeat"])
    if not last_hb:
        return False
    age = (datetime.now(timezone.utc) - last_hb).total_seconds()
    threshold = WORKING_STALE_SECONDS if data.get("status") == "working" else OTHER_STALE_SECONDS
    return age <= threshold


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


_RESOLUTION_LINE_RE = re.compile(r"RESOLUTION:\s*(?:implemented|no-changes-needed)\b", re.IGNORECASE)
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
        except (RuntimeError, ValueError):
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
        except RuntimeError:
            # Non-fatal -- the merge to main already succeeded and is the part that
            # matters; a leftover now-fully-merged remote branch is harmless clutter
            # (next list will filter it out via the ahead==0 check) rather than a real
            # failure worth reporting as one.
            pass
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
                    data["mergedAt"] = datetime.now(timezone.utc).isoformat()
                    try:
                        candidate.write_text(json.dumps(data, indent=2), encoding="utf-8")
                    except OSError:
                        pass
                break

    return jsonify({"succeeded": True, "branch": branch, "mainBranch": main_branch, "liveSync": live_sync})


@app.route("/api/pipeline/status")
def api_pipeline_status():
    env = read_env_file(ENV_FILE_PATH)
    return jsonify({
        "activeRepoRoot": get_active_repo_root(),
        "running": _pipeline_running(),
        # Which job types actually run is no longer a bundled "mode" -- see /api/job-types.
        # includeApply/skipPush are the two run-specific safety toggles that used to be
        # implied by mode; they're per-repoRoot and persisted the same way REPO_ROOT is.
        "includeApply": env.get("AGENT_MANAGER_INCLUDE_APPLY", "false") == "true",
        "skipPush": env.get("AGENT_MANAGER_APPLY_SKIP_PUSH", "true") == "true",
    })


# Kept in sync by hand with src/task-sources.js's registerTaskSource() calls, same
# "Python duplicates Node's knowledge" convention already used for SECOND_BRAIN_DIR above.
# This is the canonical name list both the Job List tab's isActive checkboxes and
# /api/pipeline/start's task-domain healing draw from -- there is no mode bundling these
# into fixed sets anymore (removed 2026-07-23 at Grimmethy's request: job-type activity is
# a top-level, cross-project setting, the same "sits above any single active project"
# reasoning as AGENT_MANAGER_BRAIN_DUMP_PATH).
TASK_SOURCE_CATALOG = [
    "adhoc", "research_task", "trouble_log", "secondbrain", "brain_dump_sort", "path_prefetch_resolve",
    "arch_review", "arch_import_review", "arch_discovery", "arch_import", "observability_review",
    "performance_review",
    "deep_dive", "project_search", "unused_export", "pipeline_self_audit", "staleness_audit", "observability_fix", "performance_fix",
]

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
        return set(TASK_SOURCE_CATALOG)
    return listed | ALWAYS_ACTIVE_SOURCES

# Mirrors the priority values templates/index.html's JOB_TYPES constant documents (which
# itself mirrors src/task-sources.js's registerTaskSource() calls) -- the default a
# source falls back to when AGENT_MANAGER_TASK_PRIORITIES has no override for it.
TASK_SOURCE_DEFAULT_PRIORITIES = {
    "adhoc": 10, "research_task": 10, "trouble_log": 20, "secondbrain": 40, "brain_dump_sort": 42,
    "path_prefetch_resolve": 45,
    "arch_review": 70, "arch_import_review": 71, "observability_fix": 72, "performance_fix": 73,
    "pipeline_self_audit": 65,
    "arch_discovery": 80, "observability_review": 80,
    "performance_review": 80,
    "arch_import": 81, "deep_dive": 82, "project_search": 85, "unused_export": 90,
    "staleness_audit": 91,
}


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
    return {name: overrides.get(name, default) for name, default in TASK_SOURCE_DEFAULT_PRIORITIES.items()}


VALID_WORKER_TYPES = ("ornith", "reasoning")

# Mirrors src/task-sources.js's registerTaskSource({reasoningTier}) calls: only adhoc and
# research_task are registered 'high' (Claude/reasoning worker); every other source defaults
# to 'low' (Ornith). The default a source falls back to when AGENT_MANAGER_TASK_TIERS has no
# override for it -- same "Python duplicates Node's knowledge" convention as
# TASK_SOURCE_DEFAULT_PRIORITIES above.
TASK_SOURCE_DEFAULT_WORKER_TYPES = {
    name: ("reasoning" if name in ("adhoc", "research_task") else "ornith") for name in TASK_SOURCE_CATALOG
}


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
    return {name: overrides.get(name, default) for name, default in TASK_SOURCE_DEFAULT_WORKER_TYPES.items()}


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
    return {name: overrides.get(name, default) for name in TASK_SOURCE_CATALOG}


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
    "staleness_audit": "default",
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
    except OSError:
        pass


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
    return jsonify([
        {
            "name": name,
            "active": name in active,
            "alwaysActive": name in ALWAYS_ACTIVE_SOURCES,
            "priority": priorities.get(name, TASK_SOURCE_DEFAULT_PRIORITIES.get(name)),
            "approvalMode": approval_modes.get(name),
            "workerType": worker_types.get(name, TASK_SOURCE_DEFAULT_WORKER_TYPES.get(name)),
            "timesPerformed": counters.get(name, 0),
        }
        for name in TASK_SOURCE_CATALOG
    ])


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
    if name not in TASK_SOURCE_CATALOG:
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
    if current == set(TASK_SOURCE_CATALOG):
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
    if name not in TASK_SOURCE_CATALOG:
        abort(400, description=f"unknown job type '{name}'")
    try:
        priority = int(body.get("priority"))
    except (TypeError, ValueError):
        abort(400, description="priority must be an integer")

    priorities = read_task_priorities()
    priorities[name] = priority

    # Collapse back to "no overrides" (empty string) when every source ends up at its own
    # default -- same tidy-round-trip reasoning as api_job_types_toggle()'s allowlist collapse.
    non_default = {n: p for n, p in priorities.items() if p != TASK_SOURCE_DEFAULT_PRIORITIES.get(n)}
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
    if name not in TASK_SOURCE_CATALOG:
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
    if name not in TASK_SOURCE_CATALOG:
        abort(400, description=f"unknown job type '{name}'")
    if worker_type not in VALID_WORKER_TYPES:
        abort(400, description=f"workerType must be one of {VALID_WORKER_TYPES}")

    worker_types = read_worker_types()
    worker_types[name] = worker_type

    # Collapse back to "no overrides" (empty string) when every source ends up at its own
    # default -- same tidy-round-trip reasoning as the priority/approval-mode collapses above.
    worker_type_to_tier = {"ornith": "low", "reasoning": "high"}
    non_default = {
        n: worker_type_to_tier[wt] for n, wt in worker_types.items() if wt != TASK_SOURCE_DEFAULT_WORKER_TYPES.get(n)
    }
    new_value = ",".join(f"{n}:{t}" for n, t in sorted(non_default.items()))
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_TASK_TIERS", new_value)

    return jsonify({"name": name, "workerType": worker_type})


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
                    except (OSError, subprocess.SubprocessError):
                        pass
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
            except (OSError, subprocess.SubprocessError, ValueError):
                pass

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

    if os.name != "nt":
        import platform, subprocess as sp, shlex
        LOG_DIR = Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/logs"
        launch_py = str(PACKAGE_ROOT / 'scripts' / 'launch.sh')
        if not Path(launch_py).is_file():
            return {"started": False, "reason": f"{launch_py} missing; cannot start daemons on Linux without a working launch script."}
        subprocess.Popen(
            ["bash", launch_py, "--no-browser"],
            env=child_env,
            cwd=str(PACKAGE_ROOT),
            stdout=(LOG_DIR / 'launch-python.log').open('a'),
            stderr=sp.STDOUT,
            start_new_session=True,
        )
        return {"started": True, "repoRoot": raw_path}

    creationflags = subprocess.CREATE_NEW_CONSOLE
    scripts = [
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "ornith-worker.ps1"), "-InstanceId", "worker-1"], "Ornith Worker 1"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "review-runner.ps1")], "Ornith Review Runner"),
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


if __name__ == "__main__":
    port = int(os.environ.get("AGENT_MANAGER_DASHBOARD_PORT", "7420"))
    # Default stays loopback-only; AGENT_MANAGER_DASHBOARD_HOST=0.0.0.0 opts into LAN
    # access for the companion app (see lan_mutation_gate above for what that changes).
    host = os.environ.get("AGENT_MANAGER_DASHBOARD_HOST", "127.0.0.1").strip() or "127.0.0.1"
    active = get_active_repo_root()
    print(f"Dashboard reading pipeline dir: {get_pipeline_dir() if active else '(none configured yet -- use the Project tab)'}")
    print(f"Open http://localhost:{port}")
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
    app.run(host=host, port=port, debug=False, use_reloader=True, threaded=True)
