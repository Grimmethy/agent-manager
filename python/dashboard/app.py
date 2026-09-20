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
import uuid
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, abort, request, Response, stream_with_context
from werkzeug.exceptions import HTTPException

# graph_build.py / visualize_graph.py live one directory up (python/), not inside
# dashboard/ -- added explicitly rather than relying on an installed package, matching
# this whole project's no-build-step, run-from-source philosophy.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import graph_build  # noqa: E402
import visualize_graph  # noqa: E402

import plugin_process_manager

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
        prior = next((e for e in entries if os.path.normpath(e.get("repoRoot", "")) == normalized_root), {})
        entries = [e for e in entries if os.path.normpath(e.get("repoRoot", "")) != normalized_root]
        entry = {
            "repoRoot": normalized_root,
            "pipelineDir": os.path.normpath(pipeline_dir),
            "domainsPath": os.path.normpath(domains_path),
            "label": Path(normalized_root).name,
        }
        # applyRepoRoot is hand-set per project (see _start_pipeline) -- never let this
        # upsert silently drop it. `pool` (docs/idle-pool-borrowing.md) is the same kind of
        # hand-set opt-in: an idle lane may borrow work from this project; switching to the
        # project from the Project tab must not silently un-opt it.
        for k in ("applyRepoRoot", "grepDirs", "pool"):
            if prior.get(k):
                entry[k] = prior[k]
        entries.insert(0, entry)
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
        # graph_build.py's build_import_graph. Build-process bookkeeping, not graph data
        # any consumer reads, same reasoning as graph_build.py's own .graph-file-cache.json
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


def remove_env_value(env_path: Path, key: str):
    """Drops a KEY=VALUE line from the env file if present (comments and every other
    line untouched). No-op when the file or key doesn't exist."""
    if not env_path.is_file():
        return
    kept = [
        line for line in env_path.read_text(encoding="utf-8").splitlines()
        if line.strip().startswith("#") or "=" not in line.strip()
        or line.strip().partition("=")[0].strip() != key
    ]
    env_path.write_text("\n".join(kept) + "\n", encoding="utf-8")


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


def task_links_db_path() -> Path | None:
    """Task Linking's storage (2026-09-08) -- mirrors model_stats_db_path()'s own
    resolution exactly (env override, else a flat file in pipelineDir)."""
    override = os.environ.get("AGENT_MANAGER_TASK_LINKS_DB_PATH")
    if override:
        return Path(override)
    d = get_pipeline_dir()
    return (d / "task-links.db") if d else None


def _incoming_task_links(task_id: str) -> list:
    """Reverse lookup -- "everything that links TO this task", read from task-links.db's
    task_links table (task-links-client.js's recordLink() is the only writer -- nothing
    writes a links[] field onto the task's own JSON, see _outgoing_task_links below).
    Returns [] (not None) when the db doesn't exist yet or the table is empty, so the
    frontend's Related Tasks section can treat "no incoming links" the same whether Task
    Linking has never been used yet or genuinely has nothing pointing at this task --
    unlike _task_cost_summary's None-vs-real-data distinction, there's no meaningful third
    state here worth telling apart."""
    db_path = task_links_db_path()
    if not db_path or not db_path.is_file():
        return []
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT source_id, type, label, created_at FROM task_links "
            "WHERE target_id = ? ORDER BY created_at DESC",
            (task_id,),
        ).fetchall()
        return [
            {"sourceId": r[0], "type": r[1], "label": r[2], "createdAt": r[3]}
            for r in rows
        ]
    except sqlite3.Error:
        return []
    finally:
        conn.close()


def _outgoing_task_links(task_id: str) -> list:
    """Forward lookup -- "everything this task links TO" -- 2026-09-08 fix: the frontend's
    renderRelatedTasks() was written expecting an inline task.links[] field that nothing
    ever wrote (recordLink() only ever wrote task_links.db); the "Links to" half of every
    task's Related Tasks section has been silently empty since Task Linking shipped. Mirrors
    _incoming_task_links exactly, just the source_id/target_id roles swapped."""
    db_path = task_links_db_path()
    if not db_path or not db_path.is_file():
        return []
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT target_id, type, label, created_at FROM task_links "
            "WHERE source_id = ? ORDER BY created_at DESC",
            (task_id,),
        ).fetchall()
        return [
            {"targetId": r[0], "type": r[1], "label": r[2], "createdAt": r[3]}
            for r in rows
        ]
    except sqlite3.Error:
        return []
    finally:
        conn.close()


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


def _sanitize_disposition(task: dict) -> dict:
    """Strip merge-metadata fields when the task is not in a 'merged' terminal state.

    Pops mergedAt, mergedAtSource, mergeCommit, and autoMergeCommit if
    terminalDisposition is present and its value is not 'merged'. Returns the
    same dict (mutated in-place) so callers can use it directly."""
    td = task.get("terminalDisposition")
    if td is not None and td != "merged":
        task.pop("mergedAt", None)
        task.pop("mergedAtSource", None)
        task.pop("mergeCommit", None)
        task.pop("autoMergeCommit", None)
    return task


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
        # True when this task was blocked at the review stage with its draft intact -- the row then offers
        # Re-review (send the SAME draft back to review, no redraft; src/rereview-task.js). Mirrors that
        # module's isRereviewable().
        "rereviewable": data.get("blockedStage") == "review" and bool((data.get("implementResponse") or "").strip()),
        # Same shape/purpose as stalenessFlag above but for context-trim-sweep.js: the
        # task's file-content anchoring went stale and re-anchoring never resolved it.
        "contextTrimFlag": data.get("contextTrimFlag"),
        # Coordinator (decomposed parent) checklist -- a small [{id,title,status}] list plus
        # a {done,total} rollup, stamped by coordinator-sweep.js. The Coordinating list row
        # shows the "N of M" from `progress` without a per-row round-trip.
        "subTasks": data.get("subTasks"),
        "progress": data.get("progress"),
        # For the Hub Tasks row's "ready to merge" (needs the stacked-hub integration gate's status as well as the piece counts).
        "integrationGate": data.get("integrationGate"),
        "hubSerial": data.get("hubSerial"),
        "hubLabel": data.get("hubLabel"),
        # Operator-set integer on a coordinating hub (LOWER = more urgent), stamped by
        # POST /api/task-anywhere/<id>/hub-priority. Drives the Hub Tasks tab's default
        # sort AND the worker claim order for that hub's children (src/hub-priority.js).
        "hubPriority": data.get("hubPriority"),
        # coordinator-sweep.js stamps this on a hub whose remaining sub-tasks can't proceed
        # (a child stuck in needs-clarification/blocked, or a sibling waiting on one). The
        # Coordinating row shows ⛔ + the reason instead of the plain progress count.
        "coordinatorBlocked": data.get("coordinatorBlocked"),
        # Owning hub, when this hub itself was spawned from an existing hub's child (see
        # decompose-loop-autoroute.js / apply-task.js's recordApplyOutcome). api_queue_state
        # uses this to build the Hub Tasks tab's real family-tree order + hubDepth.
        "parentHub": data.get("parentHub"),
    }


@app.route("/")
def index():
    return render_template("index.html")


_LANE_IDS_CACHE: dict = {"at": 0.0, "ids": []}
_LANE_IDS_TTL_S = 60.0


def worker_lane_ids() -> list[str]:
    """The pipeline's worker lane ids -- one per GPU, named for the GPU (worker-3090, worker-p40).
    src/lanes.js is the single definition (launch.sh, the watchdog's restart rule and this list
    all read it); shelled out to rather than re-derived here so the two languages can never drift,
    and cached briefly because this is called from status polls. Falls back to the last good answer
    (or a single 'worker-local') if node is unavailable."""
    now = time.monotonic()
    if _LANE_IDS_CACHE["ids"] and now - _LANE_IDS_CACHE["at"] < _LANE_IDS_TTL_S:
        return list(_LANE_IDS_CACHE["ids"])
    ids: list[str] = []
    try:
        cp = subprocess.run(
            ["node", str(SRC_DIR / "lanes.js"), "--ids"],
            capture_output=True, text=True, timeout=5,
            env={**os.environ, **read_env_file(ENV_FILE_PATH)},
        )
        ids = [line.strip() for line in cp.stdout.splitlines() if line.strip()]
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("could not read worker lanes from src/lanes.js: %s", exc)
    if ids:
        _LANE_IDS_CACHE.update(at=now, ids=ids)
        return list(ids)
    return list(_LANE_IDS_CACHE["ids"]) or ["worker-local"]


def _expected_instance_ids() -> list[str]:
    """Every daemon scripts/launch.sh starts: one worker lane per GPU (worker_lane_ids()), the
    reviewer, and the queue-watchdog. apply-task-loop is deliberately excluded -- it's a single-shot
    pass with no heartbeat file of its own (see launch.sh's own comment), so it never has a slot to
    be "offline" in."""
    return [*worker_lane_ids(), "reviewer", "watchdog"]


def _is_live_worker_instance(instance_id: str) -> bool:
    """Real "does this worker lane actually exist right now" check for the assign-task /
    assignable-tasks routes (2026-09-07 bug, Grimmethy: "worker-reasoning doesn't have
    any task option"). These routes used to gate on `instance_id in _expected_instance_ids()`
    -- but that list's worker-reasoning entry is itself gated on
    is_claude_token_configured(), a completely orthogonal concern (whether a Claude
    subscription token happens to be configured) that has nothing to do with whether the
    lane exists or can run local-model drafts, which it can and does. A running
    worker-reasoning daemon has a real instances/worker-reasoning.json heartbeat file
    regardless of Claude-token config, so checking for that file directly -- what every
    lane actually IS, not what launch.sh would have started under some other env -- is
    both simpler and correct. _expected_instance_ids() itself is unaffected: its one
    remaining caller (api_instances' offline-placeholder logic) has a different, correct
    use for "would launch.sh have started this," not "is this assignable right now."""
    if not instance_id.startswith("worker"):
        return False
    inst_dir = instances_dir()
    return bool(inst_dir and (inst_dir / f"{instance_id}.json").is_file())


def _zero_stats_model_row(model: str) -> dict:
    """A placeholder row for a model api_models() knows is available but has never been
    called -- same field shape as a real row, with every stat null/zero rather than the
    row being absent entirely."""
    return {
        "model": model, "callCount": 0, "approved": 0, "rejected": 0, "approveRate": None,
        "avgLatencyMs": None, "avgTokensPerSec": None, "minTokensPerSec": None,
        "maxTokensPerSec": None, "degenerateCount": 0, "errorCount": 0, "totalCostUsd": None,
    }


def _scan_recently_completed_tasks(limit, before_iso=None, reviewed_only=False):
    """Scans queue/done/'s own top level (mtime-sorted, most-recent-first; NOT the dated
    queue/done/_archived/<YYYY-MM>/ or _archived_no_action/ buckets -- those hold work
    already aged out of the "recent" window this is for) for completed tasks, reading
    each one's own real history/terminalDisposition -- NOT model_calls.

    2026-09-08, Grimmethy: "Under reviewer they're all showing approved and 5 hours ago.
    I don't think it's updating properly." Root-caused live: model_calls is the ONLY
    place api_instance_recent_tasks's 'reviewer' branch (below) ever looked, but a
    deterministic review verdict (deterministic-script-extract-approve,
    brain_dump_sort's deterministicReviewValidate, and every other deterministic gate
    this session added/expanded) makes NO real model call at all -- there is nothing for
    it to record. Confirmed directly against the real db: the single most recent
    outcome_stage='review' row genuinely was ~4.5 hours old at the moment of the report,
    because every review in that window happened to be a deterministic one, and the
    dashboard was accurately reporting a query that has been silently blind to a growing
    share of real review activity. Reading each task's own history file instead is
    complete by construction -- it can't miss a review class that hasn't been invented
    yet either, unlike a query hardcoded to one instrumentation table's own schema.

    Returns (rows, nextCursor). `before_iso`, when given, only returns tasks whose done/
    FILE mtime is strictly before that timestamp -- the cursor is always derived from the
    same mtime the scan itself is ordered and filtered by, never from a task's own
    history 'at' field (which is a free-form value a source can write anything into, and
    is NOT guaranteed unique or even monotonic across tasks the way file mtime is -- an
    earlier version of this returned the history-derived completedAt as the cursor while
    filtering on mtime, two different clocks that could silently disagree and drop or
    duplicate rows across a page boundary). Stable across concurrent completions between
    page requests, unlike an offset that would skip/duplicate rows once new tasks land
    above a previously-fetched page.
    `reviewed_only` keeps only tasks whose own history actually shows an 'approved' or
    'blocked' review-stage event (the reviewer card's own definition of "reviewed",
    mirrored from the model_calls branch below)."""
    qdir = queue_dir()
    if not qdir:
        return [], None
    done_dir = qdir / "done"
    if not done_dir.is_dir():
        return [], None
    # Rounded to microseconds at the source (not just when formatting the cursor below):
    # datetime only carries microsecond precision, so a raw st_mtime float compared
    # against a value that has round-tripped through isoformat()/fromisoformat() can
    # disagree by sub-microsecond floating-point noise -- enough to make the boundary
    # row of a page reappear (or vanish) depending on rounding direction. Rounding both
    # sides to the same precision here makes the later `>=` comparison exact.
    try:
        entries = [(e.path, round(e.stat().st_mtime, 6)) for e in os.scandir(done_dir) if e.is_file() and e.name.endswith(".json")]
    except OSError:
        return [], None
    entries.sort(key=lambda e: e[1], reverse=True)

    before_ts = None
    if before_iso:
        try:
            before_ts = round(datetime.fromisoformat(before_iso.replace("Z", "+00:00")).timestamp(), 6)
        except ValueError:
            before_ts = None

    results = []
    next_cursor = None
    for path, mtime in entries:
        if before_ts is not None and mtime >= before_ts:
            continue
        rec = read_json_safe(Path(path))
        if not isinstance(rec, dict):
            continue
        history = rec.get("history") or []
        if reviewed_only and not any(isinstance(h, dict) and h.get("stage") in ("approved", "blocked") for h in history):
            continue
        last = history[-1] if history and isinstance(history[-1], dict) else {}
        mtime_iso = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
        results.append({
            "taskId": rec.get("id") or Path(path).stem,
            "title": rec.get("title"),
            "source": rec.get("source"),
            "model": rec.get("draftModel"),
            "instanceId": rec.get("claimedBy"),
            "completedAt": last.get("at") or mtime_iso,
            "outcome": rec.get("terminalDisposition") or rec.get("status"),
            "reviewProvider": rec.get("reviewProvider"),
        })
        if len(results) >= limit:
            next_cursor = mtime_iso
            break
    return results, next_cursor


def _recent_task_ids_for_instance(conn, instance_id, fetch_n):
    """task_ids most recently associated with instance_id in model_calls, regardless of
    that call's own outcome column. Deliberately drops the outcome='approved' filter the
    original query used (2026-09-08, Grimmethy: "Worker-1 and Worker-reasoning have the
    same problem. All task history information is stale.") -- root-caused live the same
    way as the reviewer branch above, but through a different mechanism: outcome/
    outcome_stage are ONLY populated on a call's row when review-task.js's
    recordModelOutcome actually runs against it, which happens for a reviewed
    approve/reject verdict -- a draft that resolves as a no-op/stale-task short-circuit,
    a needs-clarification block, or any other non-reviewed terminal path leaves those
    columns NULL forever on that call's row, even though the task itself did reach a
    real terminal state. Confirmed directly against the db: worker-1's last
    outcome='approved' row was from 00:50, but model_calls had real worker-reasoning
    activity on that same task_id at 05:15-05:16 with outcome IS NULL (its actual
    resolution was a stale-task no-op, not a review). instance_id itself IS reliable
    unconditionally -- every real call stamps it via AGENT_MANAGER_INSTANCE_ID at call
    time (model-stats-client.js:96) -- so it stays the attribution source of truth here;
    only the outcome/title/completedAt need to come from the task's own real record
    instead of this table's outcome columns (see the caller's lookup loop)."""
    rows = conn.execute("""
        SELECT task_id, MAX(started_at) AS at
        FROM model_calls
        WHERE instance_id = ?
        GROUP BY task_id
        ORDER BY at DESC
        LIMIT ?
    """, (instance_id, fetch_n)).fetchall()
    return [t for t, _ in rows]


PIPELINE_HISTORY_LOG_FILENAME = "pipeline-history.log"


def _read_pipeline_history_events(instances_d, event_type, instance_id=None, limit=200):
    """Reads <instancesDir>/pipeline-history.log (src/pipeline-history.js's unified
    NDJSON writer -- see that file's own header for why the previously-separate
    degenerate/hard-failure/context-budget/fact-check-block logs were consolidated into
    one stream discriminated by `type`) for events of one `type`, newest first.
    `instance_id`, when given, filters to that field -- added to hard-failure/degenerate
    entries 2026-09-08 specifically so a failed run can be attributed to the worker that
    produced it (see local-client.js's logHardFailureAudit/logDegenerateAudit wrapper
    comments)."""
    if not instances_d:
        return []
    path = instances_d / PIPELINE_HISTORY_LOG_FILENAME
    if not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    results = []
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") != event_type:
            continue
        if instance_id is not None and ev.get("instanceId") != instance_id:
            continue
        results.append(ev)
        if len(results) >= limit:
            break
    return results


def _relocate_task_to_pending(qdir: Path, task_id: str, target_instance_id: str) -> dict:
    """Resolve `task_id` to a real file and, if necessary, move it into pending/ so the
    normal pin-and-preempt flow below can operate on it uniformly. Extends the original
    assign-task route (which only ever looked in pending/) to also find a task that's
    already claimed -- sitting in some OTHER lane's drafting/ -- per the same 2026-09-07
    feedback the assignable-tasks route above documents: "The task I want, autodecomp,
    is in drafting."

    Returns {"found": bool, "already_here": bool} -- "already_here" means the task is
    sitting in `target_instance_id`'s OWN drafting/ (reassigning it to the lane already
    running/queuing it is a pure no-op, handled by the caller)."""
    pending_path = qdir / "pending" / f"{task_id}.json"
    if pending_path.is_file():
        return {"found": True, "already_here": False}

    drafting_dir = qdir / "drafting"
    try:
        lanes = [p.name for p in drafting_dir.iterdir() if p.is_dir()]
    except OSError:
        lanes = []
    for lane in lanes:
        src = drafting_dir / lane / f"{task_id}.json"
        if not src.is_file():
            continue
        if lane == target_instance_id:
            return {"found": True, "already_here": True}

        inst_dir = instances_dir()
        hb = (read_json_safe(inst_dir / f"{lane}.json") if inst_dir else None) or {}
        if hb.get("currentTaskId") == task_id:
            # Actively in-flight on `lane` -- kill it and let _kill_and_requeue_instance's
            # own requeue-to-pending/ do the relocation (content preserved, history
            # explained) exactly like it already does for the target lane's own
            # in-flight task below.
            _kill_and_requeue_instance(lane, f"reassigned to {target_instance_id} by operator override")
        else:
            # Just sitting in `lane`'s own drafting/ backlog, not actively running --
            # nothing to kill; relocate the file directly with the same history note
            # convention _kill_and_requeue_instance uses.
            try:
                data = json.loads(src.read_text(encoding="utf-8"))
                data.setdefault("history", []).append({
                    "stage": "operator-preempted", "at": datetime.now(timezone.utc).isoformat(),
                    "detail": f"removed from {lane}'s backlog by operator override -- reassigned to {target_instance_id}",
                })
                _sanitize_disposition(data)
                src.write_text(json.dumps(data, indent=2), encoding="utf-8")
            except (OSError, ValueError):
                pass  # best-effort -- still attempt the move even if the history stamp failed
            dst = qdir / "pending" / f"{task_id}.json"
            try:
                if src.is_file() and not dst.exists():
                    os.replace(src, dst)
            except OSError:
                pass
        return {"found": pending_path.is_file(), "already_here": False}

    return {"found": False, "already_here": False}


# Per-instance model override for the Workers tab's dropdown (Grimmethy, 2026-08-18: "I
# need to be able to manually select which model to use for each worker type"). Lives in
# dashboard-settings.json alongside claudeDefaultModel/claudeDefaultEffort -- same "takes
# effect without a pipeline restart" shape those already have, since agent-manager.env's
# LOCAL_MODEL/CLAUDE_MODEL only apply at daemon launch. local-worker.sh/review-runner.sh
# re-read this file once per tick (get_model_override in agent-manager-common.sh) so a
# change here reaches a running worker within one tick, no restart needed. watchdog has no
# entry -- it never calls a model at all (queue-watcher.sh always heartbeats model="").
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


_REPORT_PERIODS = ("hourly", "daily", "weekly")


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


def _archive_task_file(qdir, src):
    """Moves a task file to queue/done/_archived_no_action/<id>.json -- not a new
    convention, the exact folder already used for every manual archive done by hand
    earlier in this project's history. Shared by api_task_archive (manual per-row button)
    and api_git_discard_branch (discarding a branch's own task) so both go through the
    exact same move logic rather than a second, possibly-inconsistent copy. Raises
    FileExistsError if an archived copy already exists at the destination -- callers
    decide how to surface that (api_task_archive 409s; api_git_discard_branch treats it
    as already-archived and moves on)."""
    dest_dir = qdir / "done" / "_archived_no_action"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    if dest.exists():
        raise FileExistsError(f"an archived copy of '{src.stem}' already exists")
    shutil.move(str(src), str(dest))
    return dest


# States whose archive means "we are giving up on this task" (as opposed to the Done tab's tidy-up of finished work).
_GIVE_UP_ARCHIVE_STATES = ("blocked", "needs-clarification", "awaiting-confirm")


def _stamp_manual_archive(src, state, reason=None):
    """Records WHAT a manual archive of an unfinished task means, on the record, before it is moved.

    Root-caused 2026-09-19: the Archive button only moved the file, so a blocked/needs-clarification task archived by a
    human sat in _archived_no_action/ with NO terminalDisposition -- "unclassified" in the Hygiene tab, and an eternal,
    silent block for any task that dependsOn it (isDependencySatisfied only releases on merged / a no-code-coming
    disposition). That is exactly how arch-review-ac-7 stayed ineligible after arch-review-ac-6 was archived by hand.

    Stamps terminalDisposition 'abandoned' -- the disposition the coordinator sweep already infers for every
    _archived_no_action record (coordinator-sweep.js) and that isDependencySatisfied / hub-priority already treat as "a human
    accepted this outcome, no code is coming from this record" -- plus a `manualArchive` block {at, from, reason} and a history
    event. Only for the give-up states (a Done-tab archive is housekeeping for finished work and keeps its own disposition), and
    never over an existing disposition. Best-effort: an unreadable record is archived unchanged, as before.
    """
    if state not in _GIVE_UP_ARCHIVE_STATES:
        return False
    data = read_json_safe(src)
    if not isinstance(data, dict) or data.get("terminalDisposition"):
        return False
    now_iso = datetime.now(timezone.utc).isoformat()
    why = (reason or "").strip() or None
    hist = data.get("history")
    if not isinstance(hist, list):
        hist = data["history"] = []
    hist.append({
        "stage": "abandoned",
        "at": now_iso,
        "detail": f"archived by a human from {state}/ via the dashboard" + (f" -- {why}" if why else ""),
    })
    data["terminalDisposition"] = "abandoned"
    data["manualArchive"] = {"at": now_iso, "from": state, "reason": why}
    try:
        src.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.error("Could not stamp the manual-archive disposition on %s: %s", src, exc)
        return False
    return True


def _delete_local_branch(repo_root, branch):
    """Deletes the LOCAL copy of a branch the Unmerged Branches tab just discarded.

    Root-caused 2026-09-19 (PropertyForager): api_git_discard_branch deleted only the REMOTE branch, but the
    apply repo is usually the very checkout the pipeline works in, so the local agent/<id> branch -- and the
    discarded commit on it -- stayed behind. That kept the task reading `pending-merge` (the disposition scan
    sees the local ref ahead of main) and, worse, apply-task's prepareStackedBranch treats a local branch that
    descends from current main as "real unpushed work" and reuses it: the next triage batch would have rebuilt
    on the discarded commit and pushed it back. Discard means discard.

    Never deletes a branch that is checked out (that would need a checkout, i.e. moving the pipeline's working
    tree -- reported instead) and always returns the branch's sha so the discard stays recoverable
    (`git branch <name> <sha>`). Best-effort: a failure here is reported, never raised -- the remote delete is
    the part that matters. `-D` (not `-d`): the whole point is that this work is NOT merged."""
    ref = f"refs/heads/{branch}"
    try:
        sha = _run_git(["rev-parse", "--verify", "--quiet", ref], repo_root).strip()
    except RuntimeError:
        sha = ""
    if not sha:
        return {"deleted": False, "reason": "no local branch"}
    try:
        current = _run_git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo_root).strip()
    except RuntimeError:
        current = ""  # detached HEAD -- not on this branch
    if current == branch:
        return {"deleted": False, "sha": sha, "reason": "checked out in the apply repo -- switch off it and delete it by hand"}
    try:
        _run_git(["branch", "-D", branch], repo_root)
    except RuntimeError as exc:
        return {"deleted": False, "sha": sha, "reason": str(exc)[:200]}
    return {"deleted": True, "sha": sha}


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


def _record_manual_requeue(task: dict, *, reason_hint: str, requeue_writer: str, actor: str = "operator-manual"):
    """Best-effort: record an operator-initiated requeue into requeue-attribution.db with
    actor='operator-manual', so the Ghost-in-the-Machine concept card can trend hand-fixes
    against pipeline-mechanism recoveries. Never raises -- a telemetry write must not turn
    a working requeue into a 500. See requeue_attribution_client.py."""
    try:
        import requeue_attribution_client
        d = get_pipeline_dir()
        requeue_attribution_client.classify_requeue(
            task,
            reason_hint=reason_hint,
            requeue_writer=requeue_writer,
            actor=actor,
            blocked_stage=(task or {}).get("blockedStage"),
            pipeline_dir=str(d) if d else None,
        )
    except Exception:
        pass


import logging

logger = logging.getLogger(__name__)


def _find_live_task_file(qdir: Path, task_id: str) -> Path | None:
    """Same search order as api_task_anywhere above (drafting first, then every
    QUEUE_STATES dir, then adhoc/), but returns the actual file Path instead of its
    parsed content -- for a route that needs to WRITE the file back, not just display it.
    Deliberately does not search the done/_archived* trees api_task_anywhere also checks:
    a task that has already reached a terminal, archived state is never read by
    next-claimable-task.js's claim ranking again, so there's nothing for a priority flag
    to affect there."""
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for candidate in drafting_root.rglob(f"{task_id}.json"):
            return candidate
    for state in QUEUE_STATES:
        p = qdir / state / f"{task_id}.json"
        if p.is_file():
            return p
    adhoc_p = qdir / "adhoc" / f"{task_id}.json"
    if adhoc_p.is_file():
        return adhoc_p
    return None


def _adhoc_task_excerpt(data):
    """Short status-relevant snippet for the Adhoc Tasks list -- whichever field
    actually carries the human-relevant signal for wherever the task currently sits,
    same fields api_alerts() already reads for the same reason."""
    if data.get("blockedReason"):
        return data["blockedReason"][:200]
    if data.get("localVerdict") or data.get("ornithVerdict"):
        return (data.get("localVerdict") or data["ornithVerdict"])[:200]
    return None


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
    the committed snapshot on any error.

    Deliberately run with AGENT_MANAGER_TASK_PRIORITIES / AGENT_MANAGER_TASK_TIERS stripped
    from the child env: `registerTaskSource(...)` bakes `taskPriority(name, default)` /
    `taskTierFor(...)` at registration time, so inheriting those would make `priority` /
    `workerType` here the EFFECTIVE (already-overridden) values, not the registry defaults.
    task_source_default_priorities() / _worker_types() and every "collapse a row back to
    its default clears the override" check (api_job_types_priority, ...priority_family)
    depend on these being the true defaults; read_task_priorities() / read_worker_types()
    layer the live overrides back on top."""
    now = time.monotonic()
    if _topology_cache["value"] is not None and now - _topology_cache["at"] < _TOPOLOGY_TTL_SECONDS:
        return _topology_cache["value"]
    value = None
    try:
        child_env = {**os.environ, **read_env_file(ENV_FILE_PATH)}
        child_env.pop("AGENT_MANAGER_TASK_PRIORITIES", None)
        child_env.pop("AGENT_MANAGER_TASK_TIERS", None)
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


def task_source_scopes() -> dict:
    """name -> 'core' | 'project'. 'core' sources audit agent-manager itself and are skipped when another
    project is active (src/lib/source-scope.js)."""
    return {s["name"]: s.get("scope", "project") for s in load_topology()}


def task_source_default_worker_types() -> dict:
    return {s["name"]: s.get("workerType", "ornith") for s in load_topology()}


# --- Job List source families (UI grouping only) ---------------------------------------
# Several registered sources are really one pipeline the operator wants to steer with a
# single priority knob -- arch_discovery / arch_import / arch_review / arch_import_review
# are the "Architecture review" family, and observability / product_spec / performance /
# function_length / change_review / backlog / pipeline_forensics have the same
# generator + consumer (+ variant) shape. This grouping is PURELY a dashboard convenience
# derived from the source name: the registry, the priority ladder, and the running
# pipeline are untouched, and every member keeps its own independent
# AGENT_MANAGER_TASK_PRIORITIES override underneath (expand the group to edit one row).
# A trailing "_<suffix>" is stripped recursively, so arch_import_review -> arch_import ->
# arch. The suffix list is deliberately conservative -- "audit" is absent because
# pipeline_self_audit / pipeline_health_audit / staleness_audit / ui_visibility_audit are
# unrelated singletons, not a family; a suffix only belongs here once it names a real
# generator/consumer/variant split in the live catalog.
_FAMILY_MEMBER_SUFFIXES = (
    "review", "fix", "digest", "discovery", "import",
    "outline", "section", "decomposition", "fulfillment",
)
_FAMILY_LABELS = {
    "arch": "Architecture review",
    "observability": "Observability review",
    "performance": "Performance review",
    "function_length": "Function-length review",
    "change": "Change review",
    "product_spec": "Product spec",
    "pipeline_forensics": "Pipeline forensics",
    "backlog": "Backlog decomposition",
}


def task_source_family_key(name: str) -> str:
    """The family a source belongs to (recursive `_<suffix>` strip), or its own name when
    it stands alone. Not every returned key is a real family -- see task_source_families()."""
    key = name
    while True:
        for suf in _FAMILY_MEMBER_SUFFIXES:
            if key.endswith("_" + suf) and len(key) > len(suf) + 1:
                key = key[: -(len(suf) + 1)]
                break
        else:
            return key


def task_source_families() -> dict:
    """{familyKey: [member source names]} for every family with >= 2 members in the live
    catalog. A key with a single member is NOT a family (it renders as an ordinary flat
    row under its own name). Member order follows the catalog's own registry order."""
    groups: dict = {}
    for name in task_source_catalog():
        groups.setdefault(task_source_family_key(name), []).append(name)
    return {k: v for k, v in groups.items() if len(v) >= 2}


def task_source_family_of() -> dict:
    """{sourceName: familyKey}, only for sources that belong to a real (>=2 member) family."""
    out = {}
    for key, members in task_source_families().items():
        for m in members:
            out[m] = key
    return out


def task_source_family_label(key: str) -> str:
    return _FAMILY_LABELS.get(key) or key.replace("_", " ").capitalize()


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


def concepts_path() -> Path | None:
    """Mirrors brain_dump_path()'s shape -- src/concepts.js (Node side) and this module
    read/write the exact same concepts.json, same theoretical cross-process race already
    accepted for brain-dump.json (see write_brain_dump_entries's own precedent), not a
    new or weaker guarantee."""
    d = get_pipeline_dir()
    return (d / "concepts.json") if d else None


def read_concepts() -> list:
    path = concepts_path()
    if not path:
        return []
    data = read_json_safe(path)
    concepts = data.get("concepts") if isinstance(data, dict) else None
    return concepts if isinstance(concepts, list) else []


GHOST_CONCEPT_ID = "concept-ghost-in-the-machine-0dbeea"
_GHOST_HAND_FIX_ACTORS = ("operator-manual", "agent-session")


def _requeue_attribution_db_path() -> Path | None:
    v = os.environ.get("AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH")
    if v:
        return Path(v)
    d = get_pipeline_dir()
    return (d / "requeue-attribution.db") if d else None


def _ghost_telemetry(days: int = 30) -> dict:
    """Read requeue-attribution.db's `actor` dimension straight (stdlib sqlite3, read-only)
    -- the Node getActorRollup's Python twin. 'hand-fixes' = operator-manual + agent-session
    (a person or an assistant tool clicked Requeue); 'mechanism recoveries' =
    pipeline-mechanism (a watchdog sweep, no one in the loop). Plus openDebt = the count of
    distinct still-open ghost-debt signatures (Part B's queue/ghost-debt-state.json).
    Everything degrades to zero on a missing db / table / column."""
    out = {
        "window": f"{days}d",
        "handFixes": 0,
        "mechanismRecoveries": 0,
        "byActor": {},
        "series": [],
        "openDebt": 0,
    }
    db_path = _requeue_attribution_db_path()
    if db_path and db_path.is_file():
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = conn.execute(
                "SELECT actor, at FROM requeue_causes WHERE at >= ?", (since,)
            ).fetchall()
        except sqlite3.Error:
            rows = []
        finally:
            conn.close()
        by_actor: dict = {}
        by_day: dict = {}
        for actor, at in rows:
            actor = actor or "pipeline-mechanism"
            by_actor[actor] = by_actor.get(actor, 0) + 1
            day = (at or "")[:10]
            bucket = by_day.setdefault(day, {"handFixes": 0, "mechanismRecoveries": 0})
            if actor in _GHOST_HAND_FIX_ACTORS:
                bucket["handFixes"] += 1
            else:
                bucket["mechanismRecoveries"] += 1
        out["byActor"] = by_actor
        out["handFixes"] = sum(by_actor.get(a, 0) for a in _GHOST_HAND_FIX_ACTORS)
        out["mechanismRecoveries"] = by_actor.get("pipeline-mechanism", 0)
        out["series"] = [
            {"at": day, **counts} for day, counts in sorted(by_day.items()) if day
        ]

    d = get_pipeline_dir()
    if d:
        state = read_json_safe(d / "queue" / "ghost-debt-state.json")
        if isinstance(state, dict):
            out["openDebt"] = len(state)
    return out


def write_concepts(concepts: list):
    path = concepts_path()
    if not path:
        abort(500, description="no active project configured")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"concepts": concepts}, indent=2), encoding="utf-8")


def slugify_concept_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:48] or "concept"


CONCEPT_STABLE_STATUSES = ("shelved", "shipped")


def _find_concept_or_404(concepts: list, concept_id: str) -> dict:
    concept = next((c for c in concepts if c.get("id") == concept_id), None)
    if not concept:
        abort(404, description=f"no concept with id {concept_id}")
    return concept


CONCEPT_TASK_SCAN_BUDGET_SECONDS = 1.5


def _concept_task_history_rows(pipeline_dir: Path, concept_id: str) -> tuple:
    """Scans queue locations a task can carry a conceptId in, on demand -- computed only
    when a concept's timeline is actually opened, never polled.

    BUG FOUND LIVE (2026-09-06): an unbounded glob over every QUEUE_STATES dir plus every
    done/-archive location took 73s on this repo's own real done/ (6,077 files, 290MB
    accumulated over this session) for a feature that, on day one, matches nothing at
    all -- the "View timeline" button hung and the dashboard's own 8s client fetch
    timeout fired. A full-history scan does not scale with this pipeline's real size, so
    this now scans the small, actively-changing states in full (pending/review/
    approved/blocked/needs-clarification/awaiting-confirm/coordinating -- always cheap,
    bounded by how much work is in flight, not by all-time history) and the large
    done/-archive locations under a hard wall-clock budget, returning a `truncated` flag
    the caller must surface rather than silently presenting a partial history as
    complete -- matching AGENTS.md's "say explicitly when something can't be fully
    explained" principle applied to "can't fully scan" too. Once real conceptId-tagged
    tasks exist, a durable incrementally-updated index (matching side-finding.js's own
    write-as-it-happens convention, not a re-derive-by-scanning-everything approach) is
    the right follow-up -- flagged, not built here, since no real usage data exists yet
    to size it against."""
    rows = []
    qdir = pipeline_dir / "queue"
    fast_states = ["pending", "review", "approved", "blocked", "needs-clarification", "awaiting-confirm", "coordinating"]
    fast_dirs = [qdir / state for state in fast_states]

    slow_dirs = [qdir / "done"]
    archived_no_action = qdir / "done" / "_archived_no_action"
    if archived_no_action.is_dir():
        slow_dirs.append(archived_no_action)
    dated_archive_root = qdir / "done" / "_archived"
    if dated_archive_root.is_dir():
        slow_dirs.extend(p for p in dated_archive_root.iterdir() if p.is_dir())

    def scan(d, deadline):
        for f in d.glob("*.json"):
            if deadline is not None and time.monotonic() > deadline:
                return True  # truncated
            task = read_json_safe(f)
            if isinstance(task, dict) and task.get("conceptId") == concept_id:
                rows.append({
                    "at": task.get("completedAt") or task.get("updatedAt") or task.get("createdAt"),
                    "kind": "task",
                    "ref": task.get("id") or f.stem,
                    "summary": task.get("title") or task.get("id") or f.stem,
                })
        return False

    for d in fast_dirs:
        if d.is_dir():
            scan(d, None)  # small, in-flight-work-sized dirs -- no budget needed

    truncated = False
    deadline = time.monotonic() + CONCEPT_TASK_SCAN_BUDGET_SECONDS
    for d in slow_dirs:
        if not d.is_dir():
            continue
        if scan(d, deadline):
            truncated = True
            break
    return rows, truncated


# Matches the exact cross-reference line applyBrainDumpSort (apply-group-a.js) writes
# into a vault note when belongsToProject matches -- "Queued as adhoc task `id` in
# **label**", with an optional ", held for clarification (...)" suffix after the closing
# ** that this regex doesn't need to care about (it only needs the id/label pair).
_TASK_REF_RE = re.compile(r"Queued as adhoc task `([^`]+)` in \*\*([^*]+)\*\*")


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


# --- Chat "make GPU space" preemption (brain dump #5) ----------------------------------
# Extracted to chat_preempt.py (2026-09-15) -- see that module's own header for the full
# rationale -- so it can be vendored into a standalone Chat plugin repo without dragging
# this whole file along. Re-imported here (not moved-and-forgotten) so every existing
# bare call site in this file (_kill_and_requeue_instance, _preempt_pipeline_for_chat,
# etc.) and every external `from app import _chat_preempt_enabled` (routes/chat.py)
# keep working unchanged -- pure re-export, zero behavior change.
from chat_preempt import (  # noqa: E402
    _arbiter_cancel_below, _chat_preempt_enabled, _chat_preempt_max_age_s,
    _is_preemptable_child_pass, _kill_and_requeue_instance, _preempt_decision,
    _preempt_lane_sets, _preempt_pipeline_for_chat,
    _read_fresh_model_locks,
)


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


def _slugify_project_name(stem: str) -> str:
    """Note filename (no .md) -> filesystem/repo-friendly name: spaces to hyphens, strip
    anything that isn't alphanumeric/hyphen/underscore. Deliberately NOT lowercased --
    the real GitHub folders already mix casing (TaxHarvest-GrimmethyLocal, SGCElementals),
    so forcing one convention here would look inconsistent next to them."""
    name = stem.replace(" ", "-")
    name = re.sub(r"[^A-Za-z0-9_-]", "", name)
    return name.strip("-_") or "untitled-project"


_DEEP_DIVE_ITEM_RE = re.compile(
    r"^## (?P<title>.+?)\s*\n\n"
    r"\*\*Community:\*\* (?P<community>.+?)\s*\n"
    r"\*\*Rating:\*\* (?P<rating>.+?)\s*\n"
    r"(?:\*\*Files:\*\* (?P<files>.+?)\s*\n)?"
    r"\n(?P<rationale>.*?)(?=\n## |\Z)",
    re.MULTILINE | re.DOTALL,
)
_COMMUNITY_ID_SUFFIX_RE = re.compile(r"^(?P<name>.*?)\s*\(community #(?P<id>\d+)\)\s*$")


def _grep_dirs_from_query() -> list[str]:
    """Matches the frontend's comma-separated grepDirs input convention -- the same
    string already sent to /api/project/build, now also needed by the read/write routes
    below so they resolve the same per-grepDirs cache slot a build wrote to."""
    raw = request.args.get("grepDirs", "").strip()
    return [d.strip() for d in raw.split(",") if d.strip()]


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
        # loaded the previous build's graph/coverage at all (unlike graph_build.py's own
        # main()/check_due(), which already did), so it never even carried forward
        # lastReviewedAt review state on a rebuild, let alone skipped re-parsing unchanged
        # files or re-naming unchanged communities. Now does all three, via the SAME
        # file_cache/old_coverage/old_graph_nodes params graph_build.py's own callers use.
        old_graph = read_json_safe(cache["graph"]) or {"nodes": [], "links": []}
        old_coverage = read_json_safe(cache["coverage"]) or {"communities": []}
        file_cache = read_json_safe(cache["file_cache"]) or {}

        result = graph_build.build_graph_data(
            Path(path_str), grep_dirs, ollama_url, local_model, progress=progress,
            file_cache=file_cache, old_coverage=old_coverage, old_graph_nodes=old_graph.get("nodes", []),
        )
        merged_coverage = graph_build.merge_coverage(old_coverage, old_graph.get("nodes", []), result["coverage"], result["graph"]["nodes"])

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
        for name in (*worker_lane_ids(), "reviewer", "watchdog"):
            data = read_json_safe(inst_dir / f"{name}.json")
            if data and data.get("pid") and _pid_alive(data["pid"]):
                return True
    return False


def _pipeline_running() -> bool:
    """A pipeline counts as running if ANY worker lane's heartbeat is fresh -- the other
    loops matter too, but the workers are what actually produce work, and not requiring
    every lane avoids this being wrong the moment any ONE of the others is mid-restart.

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

    lane_ids = worker_lane_ids()
    for lane in lane_ids:
        data = read_json_safe(inst_dir / f"{lane}.json")
        if data and data.get("lastHeartbeat"):
            last_hb = parse_hb_timestamp(data["lastHeartbeat"])
            if last_hb:
                age = (datetime.now(timezone.utc) - last_hb).total_seconds()
                threshold = WORKING_STALE_SECONDS if data.get("status") == "working" else OTHER_STALE_SECONDS
                if age <= threshold:
                    return True

    # Stale or unparseable heartbeat -- believe a live process over a stale timestamp.
    for name in (*lane_ids, "reviewer"):
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


def _check_sibling_conflict(repo_root, branch_a, branch_b):
    """Same idea as _check_merge_conflict, but between two SIBLING unmerged branches
    instead of one branch against main (2026-09-16, root-caused live: a coordinator hub
    decomposed one feature into 4 sub-tasks that all edit the same file -- local-
    tool-client.js -- but the model never declared `after` links between them, so each
    was independently branched straight off the same main commit. Every branch's own
    willConflict (checked only against main) correctly said False; the real collision
    was invisible until a human/agent merged them one at a time and hit a real conflict
    on the 2nd branch. willConflict has never checked a branch against a SIBLING still
    sitting unmerged in the same hub -- this closes that blind spot).

    Uses the two branches' own merge-base as the 3-way base (not main_branch): they
    usually branch directly off main, in which case this is equivalent, but it stays
    correct even when one is stacked on top of the other.
    """
    base = subprocess.run(
        ["git", "merge-base", f"origin/{branch_a}", f"origin/{branch_b}"],
        cwd=str(repo_root), capture_output=True, text=True, timeout=10,
    )
    if base.returncode != 0:
        return {"willConflict": None, "conflictFiles": [], "checked": False}
    base_sha = base.stdout.strip()
    if not base_sha:
        return {"willConflict": None, "conflictFiles": [], "checked": False}
    # --write-tree's own 2-branch form always computes the merge-base itself; overriding
    # it takes the separate --merge-base=<commit> OPTION, not a 3rd positional argument
    # (that positional form only exists for the older, write-tree-less --trivial-merge
    # mode) -- confirmed live the hard way: the naive 3-positional-arg form used here
    # first always errored with git's own usage text (exit 129), which this function's
    # broad "non-conflict, non-zero code" branch silently swallowed as checked:False,
    # meaning the sibling-conflict check would have silently never fired for ANY pair.
    result = subprocess.run(
        ["git", "merge-tree", "--write-tree", f"--merge-base={base_sha}", f"origin/{branch_a}", f"origin/{branch_b}"],
        cwd=str(repo_root), capture_output=True, text=True, timeout=30,
    )
    if result.returncode == 0:
        return {"willConflict": False, "conflictFiles": [], "checked": True}
    if result.returncode == 1:
        files = _CONFLICT_LINE_RE.findall(result.stdout)
        return {"willConflict": True, "conflictFiles": files, "checked": True}
    return {"willConflict": None, "conflictFiles": [], "checked": False}


def _annotate_hub_sibling_conflicts(repo_root, branches):
    """Mutates `branches` in place, adding `hubSiblingConflicts: [branch, ...]` to any
    branch whose coordinator hub has another still-unmerged sibling it would conflict
    with. O(members^2) merge-tree calls per hub -- hubs are small (2-4 real sub-tasks in
    every one seen so far), so this stays cheap. Best-effort: a git failure on any one
    pairwise check leaves that pair unflagged rather than raising (matches _check_merge_
    conflict's own "unknown, not a false 'safe'" doctrine for a checked=False result, but
    an unflagged pair here just means a human sees one fewer warning, not a false
    all-clear on the branch's own primary willConflict field).
    """
    by_hub = {}
    for b in branches:
        hub = b.get("hub")
        hub_id = hub.get("id") if hub else None
        if hub_id:
            by_hub.setdefault(hub_id, []).append(b)
            # Always present (never a missing key) for any branch with a hub, even when
            # it's the only one of that hub still unmerged -- a consumer should never
            # need to distinguish "no conflicts" from "field not computed yet".
            b["hubSiblingConflicts"] = []
    for siblings in by_hub.values():
        if len(siblings) < 2:
            continue
        for i, b in enumerate(siblings):
            conflicts_with = []
            for j, other in enumerate(siblings):
                if i == j:
                    continue
                try:
                    sib = _check_sibling_conflict(repo_root, b["branch"], other["branch"])
                except (subprocess.SubprocessError, OSError):
                    continue
                if sib["willConflict"]:
                    conflicts_with.append(other["branch"])
            b["hubSiblingConflicts"] = conflicts_with


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
        if data.get("candidateSplitRoute") == "hub":
            return (
                f"Too large for one pass -- split into {len(split_proposals)} chained piece(s) that become a coordinator hub "
                f"when applied (no code on this branch): {titles_text}"
            )[:_DESCRIPTION_MAX_CHARS]
        return (
            f"Split into {len(split_proposals)} sub-candidate(s), not yet implemented: "
            f"{titles_text}"
        )[:_DESCRIPTION_MAX_CHARS]

    # agentic-draft-common.js appends the raw diff after a `=== DIFF ===` marker
    # (`${summary}\n\n=== DIFF ===\n${task.rawDiff}`). Strip it before any strategy below
    # touches the text -- otherwise a short plain-English summary right before the marker
    # (e.g. "RESOLUTION: implemented\ndone" with nothing else) lets the 600-char slice run
    # straight into the diff itself, showing raw `diff --git ...` hunks as the "What this
    # changes" description instead of prose.
    implement = (data.get("implementResponse") or "").split("=== DIFF ===")[0].strip()

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


# Every apply-task.js commit body carries a `Task: <id> (<domain>/<source>)` trailer (see
# its commitMessage). That id is the join key back to the task's real pipeline log.
_TASK_TRAILER_RE = re.compile(r"^Task:\s*(\S+)", re.MULTILINE)

# Task states a hub child is "finished" in, for progress + readiness (mirrors
# coordinator-sweep.js's TERMINAL_GOOD).

def _is_real_ship(rec):
    """Whether a done-queue task REALLY shipped code (2026-08-25, "24 of 25 'shipped'
    tasks produced zero code" -- 24 ended with 'no candidates in implement response --
    nothing to apply', closed by deterministic-empty-approve or a 3/3 vote on a 0-char
    draft). True only when the record's own terminalDisposition is 'merged' AND its
    history has an 'applied' stage whose detail is non-empty and is not a no-op marker;
    anything else is a no-op and must not count toward the shipped headline, or every
    dashboard/SLO reading queue/done/ as 'shipped' over-reports by ~24x."""
    if not isinstance(rec, dict) or rec.get("terminalDisposition") != "merged":
        return False
    noop_markers = ("nothing to apply", "no candidates", "noop")
    for h in rec.get("history") or []:
        if not isinstance(h, dict) or h.get("stage") != "applied":
            continue
        detail = (h.get("detail") or "").strip()
        if not detail:
            return False
        if any(marker in detail.lower() for marker in noop_markers):
            return False
        return True
    return False


def _find_task_log_anywhere(repo_root, task_id):
    """Fallback for _find_task_record_anywhere when a task's queue/ record is genuinely
    gone -- not just archived (that's already covered by every branch above): the queue/
    dir was never migrated to this host, or something outside this dashboard's own
    archive sweep removed it. task-logs/<id>.json (src/task-log-store.js) is the one place
    a shipped task's complete history is guaranteed to still exist, because apply-task.js
    commits it -- tracked, not gitignored -- in the SAME commit as the real change. See
    AGENTS.md's task-log section: 'available at a click, ever' has to survive this case,
    not just the already-handled archive-bucket ones."""
    if not repo_root or not task_id:
        return None
    return read_json_safe(Path(repo_root) / "task-logs" / f"{task_id}.json")


_HUB_TITLE_LABEL_RE = re.compile(r"^(HUB\d{4,})(?:-\d+)?\b")


def _hub_label_index(qdir):
    """{hub id or any of its formerIds: hub record} for every live coordinating hub that has a HUB#### label."""
    index = {}
    d = qdir / "coordinating" if qdir else None
    if not d or not d.is_dir():
        return index
    for f in d.glob("*.json"):
        hub = read_json_safe(f)
        if not hub or not hub.get("hubLabel"):
            continue
        index[hub.get("id") or f.stem] = hub
        for old in hub.get("formerIds") or []:
            index[old] = hub
    return index


def _hub_info_for_task(task_id, task=None, index=None, qdir=None):
    """The HUB#### a task belongs to (2026-09-20, Grimmethy: "I don't see the HUB name when looking at the workers queue"), as
    {"label", "seq", "total", "isHub"} or None. seq/total are the task's slot in its hub's checklist. A hub's member is found through
    promptContext.decomposedFrom (the hub's id or one of its formerIds); a member the hub's checklist does not list, and a task whose
    id/title already leads with HUB####, still report the label. Best-effort: a lookup problem is just "no hub"."""
    try:
        if qdir is None:
            qdir = queue_dir()
        if index is None:
            index = _hub_label_index(qdir)
        if task is None:
            task, _ = _find_task_record_anywhere(qdir, task_id)
        if task_id in index:
            return {"label": index[task_id]["hubLabel"], "seq": None, "total": None, "isHub": True}
        pc = (task or {}).get("promptContext") or {}
        hub = index.get(pc.get("decomposedFrom"))
        if hub:
            subs = hub.get("subTasks") or []
            pos = next((i for i, st in enumerate(subs) if st and st.get("id") == task_id), None)
            return {"label": hub["hubLabel"], "seq": (pos + 1) if pos is not None else None, "total": len(subs), "isHub": False}
        m = _HUB_TITLE_LABEL_RE.match(str(task_id or "")) or _HUB_TITLE_LABEL_RE.match(str((task or {}).get("title") or ""))
        if m:
            return {"label": m.group(1), "seq": None, "total": None, "isHub": False}
    except Exception as e:  # noqa: BLE001 -- cosmetic
        print(f"[hub-info] lookup failed for {task_id} (non-fatal): {e}", file=sys.stderr, flush=True)
    return None


def _find_task_record_anywhere(qdir, task_id):
    """(data, state) for a task id across every queue location a branch's task could be
    sitting in -- the QUEUE_STATES dirs, the manual + dated + superseded archives, and the
    per-worker drafting subfolders -- or (None, None). Same coverage as _task_state_index,
    plus queue/done/_superseded/ (file-decompose re-file supersessions)."""
    if not qdir or not task_id:
        return None, None
    for state in QUEUE_STATES:
        d = read_json_safe(qdir / state / f"{task_id}.json")
        if d:
            return d, state
    for sub, label in (("_archived_no_action", "archived"), ("_superseded", "superseded")):
        d = read_json_safe(qdir / "done" / sub / f"{task_id}.json")
        if d:
            return d, label
    dated = qdir / "done" / "_archived"
    if dated.is_dir():
        for month_dir in dated.iterdir():
            if month_dir.is_dir():
                d = read_json_safe(month_dir / f"{task_id}.json")
                if d:
                    return d, "archived"
    drafting = qdir / "drafting"
    if drafting.is_dir():
        for sub in drafting.iterdir():
            if sub.is_dir():
                d = read_json_safe(sub / f"{task_id}.json")
                if d:
                    return d, "drafting"
    return None, None


def _history_entry_detail_text(e):
    """The visible line under a history entry's stage label in the Unmerged Branches
    modal. Older/hand-written entries (the pre-task-history.js `{"status": "pending"}`
    shape api_task_requeue used to write, still the shape of a `requeued` event's own
    note today) carry their text in `note`, not `detail` -- confirmed live 2026-09-12:
    observability-fix-ac-158's requeue entry rendered as a bare 'pending' label with
    nothing beneath it, because this used to read ONLY `detail`. Also folds in the
    blockedReasonAtRequeue/priorRejectionFeedbackAtRequeue api_task_requeue now stamps on
    its own `requeued` entry (see that endpoint) -- without this, that data is captured in
    the JSON but still invisible at a click, same failure mode this whole mechanism exists
    to close."""
    parts = []
    if e.get("detail"):
        parts.append(str(e["detail"]))
    elif e.get("note"):
        parts.append(str(e["note"]))
    if e.get("blockedReasonAtRequeue"):
        parts.append(f"(blocked for: {e['blockedReasonAtRequeue']})")
    if e.get("priorRejectionFeedbackAtRequeue"):
        parts.append(f"(prior rejections: {e['priorRejectionFeedbackAtRequeue']})")
    return " ".join(parts) if parts else None


def _summarize_task_record(data, state):
    """Compact pipeline log for one task, for the Unmerged Branches detail modal: the
    full `history[]` (created -> plan -> implement tiers -> review votes -> applied ->
    disposition), plus the fields that say what it did and where it stands."""
    history = data.get("history") or []
    review_votes = None
    for e in reversed(history):
        if (e.get("stage") or e.get("status")) == "approved" and e.get("detail"):
            review_votes = e.get("detail")
            break
    return {
        "id": data.get("id"),
        "title": data.get("title"),
        "domain": data.get("domain"),
        "source": data.get("source"),
        "state": state,
        "terminalDisposition": data.get("terminalDisposition"),
        "adhocResolution": data.get("adhocResolution"),
        "description": _describe_change(data),
        "reviewVotes": review_votes,
        "decomposedFrom": (data.get("promptContext") or {}).get("decomposedFrom"),
        "history": [
            {"stage": e.get("stage") or e.get("status"), "at": e.get("at"), "detail": _history_entry_detail_text(e)}
            for e in history
        ],
    }


# Fallback ONLY for a hub record the coordinator has not re-swept since `subTasks[].phase` was introduced (it is rewritten every tick, so this
# is transient). The real definition is coordinator-sweep.js's childPhase(); the sets below mirror it for statuses that were already there.
_HUB_LEGACY_MERGED = {"done", "gone", "merged", "applied-direct", "filed", "dismissed", "noop", "abandoned", "superseded"}


def _hub_child_phase(st):
    phase = st.get("phase")
    if phase in ("merged", "built", "open"):
        return phase
    status = st.get("status")
    if status in _HUB_LEGACY_MERGED:
        return "merged"
    return "built" if status == "pending-merge" else "open"


def _summarize_hub(data, state):
    subs = [st for st in (data.get("subTasks") or []) if isinstance(st, dict)]
    phases = [_hub_child_phase(st) for st in subs]
    done_n = sum(1 for p in phases if p == "merged")
    built_n = sum(1 for p in phases if p in ("merged", "built"))
    gate = data.get("integrationGate") or {}
    all_children_built = len(subs) > 0 and built_n == len(subs)
    gate_clear = gate.get("status") in (None, "passed", "skipped")
    return {
        "id": data.get("id"),
        "title": data.get("title"),
        "mode": data.get("mode"),
        "branch": data.get("branch"),
        "state": state,
        # done = merged/closed; built = done + finished-but-awaiting-merge (see coordinator-sweep.js childPhase)
        "progress": {"done": done_n, "built": built_n, "total": len(subs)},
        "subTasks": [
            {"id": st.get("id"), "title": st.get("title"), "status": st.get("status"), "phase": phase}
            for st, phase in zip(subs, phases)
        ],
        "integrationGate": {"status": gate.get("status"), "checks": gate.get("checks")},
        "blockedReason": data.get("blockedReason"),
        # Ready to merge = every piece is BUILT (finished, committed, waiting on the merge -- not necessarily merged already) and the
        # integration gate has passed or was skipped. A hub already in done/ shipped.
        "readyToMerge": bool(state == "done" or (all_children_built and gate_clear)),
    }


def _hub_for_branch(qdir, branch, commit_task_ids):
    """The coordinator hub that owns this branch, if any -- matched by its own `branch`
    field (stacked file-decompose hub) or by containing one of the branch's commit tasks
    in its subTasks. Returns a _summarize_hub dict or None."""
    if not qdir:
        return None
    task_set = set(commit_task_ids or [])
    seen = []
    coord = qdir / "coordinating"
    if coord.is_dir():
        seen.extend((p, "coordinating") for p in coord.glob("*.json"))
    done = qdir / "done"
    if done.is_dir():
        seen.extend((p, "done") for p in list(done.glob("*-hub-*.json")) + list(done.glob("file-decompose-hub-*.json")))
    sup = qdir / "done" / "_superseded"
    if sup.is_dir():
        seen.extend((p, "superseded") for p in sup.glob("*hub*.json"))
    for path, hstate in seen:
        d = read_json_safe(path)
        if not d:
            continue
        if d.get("branch") == branch:
            return _summarize_hub(d, hstate)
        sub_ids = {st.get("id") for st in (d.get("subTasks") or []) if isinstance(st, dict)}
        if task_set & sub_ids:
            return _summarize_hub(d, hstate)
    return None


def _label_for_branch(task_id, pipeline_dir, subject, repo_root=None):
    """Best-effort human label: the originating task's own title/domain/source (plus a
    plain-English description of what it actually changed, see _describe_change) if a
    matching queue file can still be found (checked across every terminal-ish state a
    merge-worthy branch's task could be sitting in), else the git-tracked task log
    (task-logs/<id>.json, see _find_task_log_anywhere) if THAT still exists, else the
    branch tip's own commit subject line -- never just the raw branch name, which is an
    opaque id nobody but this pipeline can read at a glance."""
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
        log_data = _find_task_log_anywhere(repo_root, task_id)
        if log_data:
            return {
                "title": log_data.get("title") or subject or task_id,
                "domain": log_data.get("domain"),
                "source": log_data.get("source"),
                "matchedTaskState": "task-log",
                "description": _describe_change(log_data),
            }
        # A stacked file-decompose branch (agent/decompose-<slug>) carries N tasks, not
        # one -- `task_id` here is "decompose-<slug>", which is no task's id. Its owning
        # coordinator hub IS findable, and is the right label + status source.
        hub = _hub_for_branch(qdir, f"agent/{task_id}", [])
        if hub:
            prog = hub["progress"]
            gate = hub["integrationGate"]["status"]
            return {
                "title": hub["title"] or subject or task_id,
                "domain": "adhoc",
                "source": "decompose-hub",
                "matchedTaskState": hub["state"],
                "description": (
                    f"Coordinator hub: {prog['built']}/{prog['total']} built"
                    + (f" ({prog['done']} merged)" if prog["built"] > prog["done"] else "")
                    + (f", integration gate {gate}" if gate else "")
                    + (" -- ready to merge" if hub["readyToMerge"] and hub["state"] != "done" else "" if hub["readyToMerge"] else " -- not ready to merge")
                ),
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

        label = _label_for_branch(task_id, pipeline_dir, subject.strip(), repo_root=repo_root)
        qdir = (pipeline_dir / "queue") if pipeline_dir else None
        hub = _hub_for_branch(qdir, branch, [task_id])
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
            # Present only when a coordinator hub owns this branch -- carries progress +
            # integration-gate status + a `readyToMerge` flag the UI uses to warn before a
            # premature merge (a stacked file-decompose branch merged before its wiring
            # task 404s the moved routes).
            "hub": hub,
        })

    _annotate_hub_sibling_conflicts(repo_root, branches)
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
            logger.error(
                "Failed to trigger reloader restart via os.utime after dashboard sync",
                exc_info=True,
            )
    return {"synced": True, "changed": True, "changedFiles": changed_files, "restartTriggered": restart_triggered}


_COMMIT_LOG_FIELD_SEP = "\x1f"  # unit separator -- won't collide with real commit text
_COMMIT_LOG_RECORD_SEP = "\x1e"  # record separator between commits


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
    "derived_task": "adhoc",
    "path_prefetch_resolve": "path_prefetch_resolve", "pipeline_self_audit": "adhoc",
    "pipeline_forensics": "default", "pipeline_forensics_fix": "default",
    "change_review": "default", "change_review_fix": "default",
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
    "derived_task": "Pipeline-DERIVED follow-up work (a pipeline_debrief Now-What item, a passive side-finding) that brain_dump_sort routed to queue/derived/. Adhoc-shaped, but its own throttleable lane at priority 48 -- it does NOT preempt deterministic sources the way genuine adhoc does.",
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
    "change_review": "Reviews the diff of each unit merged to the main branch for correctness regressions only (off-by-one, dropped error path, wrong variable, un-updated callers of a changed signature). Confirmed findings become fix candidates in Docs/CHANGE_REVIEW_CANDIDATES.md. (agent-manager-hygiene plugin.)",
    "change_review_fix": "Turns a change_review finding (Docs/CHANGE_REVIEW_CANDIDATES.md) into a real diff + regression test on an agent/ branch for manual merge. (agent-manager-hygiene plugin.)",
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


def _run_plugin_subprocess(args: list, cwd):
    """Runs one subprocess for a plugin update (git fetch/checkout, npm update/install).
    Kept as a single module-level seam so tests can monkeypatch it instead of shelling
    out. Raises subprocess.CalledProcessError / subprocess.TimeoutExpired / OSError on
    failure; returns (stdout, stderr) on success."""
    result = subprocess.run(
        args, cwd=str(cwd), capture_output=True, text=True, check=True, timeout=600
    )
    return result.stdout or "", result.stderr or ""


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

    # AGENT_MANAGER_APPLY_REPO_ROOT (the clone apply-task.js commits/pushes from, and where
    # the *_CANDIDATES.md docs the *_fix sources read live) is per-project too. It used to
    # sit in agent-manager.env untouched across project switches, so pointing the pipeline
    # at a second repo left its candidate docs and its apply target on agent-manager's own
    # clone: agent-manager's tasks got drafted against the new repo, and the new repo's
    # diffs would have been applied and pushed to agent-manager's origin (2026-09-19,
    # caught before any draft ran). Honor the registered project's applyRepoRoot; a project
    # with none applies from its own repoRoot, so clear any stale value.
    if existing_registration and existing_registration.get("applyRepoRoot"):
        write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_APPLY_REPO_ROOT", existing_registration["applyRepoRoot"])
        os.environ["AGENT_MANAGER_APPLY_REPO_ROOT"] = existing_registration["applyRepoRoot"]
    else:
        remove_env_value(ENV_FILE_PATH, "AGENT_MANAGER_APPLY_REPO_ROOT")
        os.environ.pop("AGENT_MANAGER_APPLY_REPO_ROOT", None)

    # AGENT_MANAGER_GREP_DIRS (which repo-relative dirs the pipeline's grounding grep may search)
    # is per-project for the same reason as applyRepoRoot above. It sat in agent-manager.env as
    # agent-manager's own layout ("src,python,scripts,docs") across project switches, so on
    # PF-Client-Portal -- whose docker-compose.yml lives at the repo root -- a search for
    # `backend-storage` found nothing and a task's premise was declared false (2026-09-19).
    # Honor the registered project's grepDirs; a project with none searches its whole repo
    # (config.js's default '.'), so clear any stale value.
    if existing_registration and existing_registration.get("grepDirs"):
        write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_GREP_DIRS", existing_registration["grepDirs"])
        os.environ["AGENT_MANAGER_GREP_DIRS"] = existing_registration["grepDirs"]
    else:
        remove_env_value(ENV_FILE_PATH, "AGENT_MANAGER_GREP_DIRS")
        os.environ.pop("AGENT_MANAGER_GREP_DIRS", None)

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

    # Proactive file-decompose sweep (2026-09-14): "when the project is selected as the
    # target of agent manager" is exactly this event -- a project becoming the active
    # pipeline target, whether via a fresh Start Pipeline or a restart. Fire-and-forget,
    # never blocks this response: the sweep can make a real local-model call (Tier B/C of
    # runFileDecomposePlanPass) if the file has no comment-banner structure to group
    # deterministically, and this route's own caller (the Project tab) should not wait on
    # that. --force bypasses the sweep's own 24h internal gate for this one on-demand
    # trigger; the periodic queue-watchdog tick still runs it every 24h regardless of
    # whether a project switch happens to trigger it in between.
    try:
        _decompose_log_dir = Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/logs"
        _decompose_log_dir.mkdir(parents=True, exist_ok=True)
        subprocess.Popen(
            ["node", str(SRC_DIR / "proactive-file-decompose-sweep.js"), "--force"],
            env=child_env,
            cwd=str(SRC_DIR),
            stdout=(_decompose_log_dir / "proactive-file-decompose-sweep.log").open("a"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as exc:
        logger.warning("Could not spawn proactive-file-decompose-sweep on project select: %s", exc)

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


def _is_loopback_host(host: str) -> bool:
    return host in ("127.0.0.1", "localhost", "::1")


# --- Decomposed route blueprints (file-decompose) ---
from routes.reports import reports_bp  # noqa: E402
from routes.concepts import concepts_bp  # noqa: E402
from routes.second_brain import second_brain_bp  # noqa: E402
from routes.brain_dump import brain_dump_bp  # noqa: E402
from routes.benchmark import benchmark_bp  # noqa: E402
from routes.embedded_tools import embedded_tools_bp  # noqa: E402
from routes.hardware import hardware_bp  # noqa: E402
from routes.claude_settings import claude_settings_bp  # noqa: E402
from routes.discovery import discovery_bp  # noqa: E402
from routes.hygiene import hygiene_bp  # noqa: E402
from routes.deep_dive import deep_dive_bp  # noqa: E402
from routes.job_types import job_types_bp  # noqa: E402
from routes.worker_models_1_more import worker_models_1_more_bp  # noqa: E402
from routes.instances import instances_bp  # noqa: E402
from routes.chat import chat_bp  # noqa: E402
from routes.internal_chat import internal_chat_bp  # noqa: E402
from routes.plugin_proxy import plugin_proxy_bp  # noqa: E402
from routes.project import project_bp  # noqa: E402
from routes.task_anywhere_1_more import task_anywhere_1_more_bp  # noqa: E402
from routes.pipeline_1_more import pipeline_1_more_bp  # noqa: E402
from routes.plugins import plugins_bp  # noqa: E402
from routes.task import task_bp  # noqa: E402
from routes.shared_misc import shared_misc_bp  # noqa: E402

app.register_blueprint(reports_bp)
app.register_blueprint(concepts_bp)
app.register_blueprint(second_brain_bp)
app.register_blueprint(brain_dump_bp)
app.register_blueprint(benchmark_bp)
app.register_blueprint(embedded_tools_bp)
app.register_blueprint(hardware_bp)
app.register_blueprint(claude_settings_bp)
app.register_blueprint(discovery_bp)
app.register_blueprint(hygiene_bp)
app.register_blueprint(deep_dive_bp)
app.register_blueprint(job_types_bp)
app.register_blueprint(worker_models_1_more_bp)
app.register_blueprint(instances_bp)
app.register_blueprint(chat_bp)
app.register_blueprint(internal_chat_bp)
app.register_blueprint(plugin_proxy_bp)
app.register_blueprint(project_bp)
app.register_blueprint(task_anywhere_1_more_bp)
app.register_blueprint(pipeline_1_more_bp)
app.register_blueprint(plugins_bp)
app.register_blueprint(task_bp)
app.register_blueprint(shared_misc_bp)


def _wait_for_plugin_health(entry: dict, timeout_s: float = 5.0) -> bool:
    # Bounded poll, same "never let a check block forever" shape launch.sh's own
    # TokenFold /healthz wait loop uses (20 attempts x 0.25s = 5s).
    import urllib.request

    health_path = (entry.get("process") or {}).get("healthPath", "/healthz")
    url = f"{entry['url']}{health_path}"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


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
    from routes.internal_chat import start_internal_chat_reservation_watchdog
    start_internal_chat_reservation_watchdog()

    app.run(host=host, port=port, debug=False, use_reloader=True, threaded=True, ssl_context=ssl_context)
