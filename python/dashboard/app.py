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
from pathlib import Path, PurePosixPath

from flask import Flask, jsonify, render_template, abort, request, Response, stream_with_context
from werkzeug.exceptions import HTTPException

# graph_build.py / visualize_graph.py live one directory up (python/), not inside
# dashboard/ -- added explicitly rather than relying on an installed package, matching
# this whole project's no-build-step, run-from-source philosophy.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import graph_build  # noqa: E402
import visualize_graph  # noqa: E402

import plugin_process_manager

# Moved verbatim into app_settings_helpers.py (2026-10-01 breakdown); re-exported so every importer of app.X is unchanged.
from app_settings_helpers import (  # noqa: F401
    CHAT_RESERVATION_IDLE_TIMEOUT_S,
    CLAUDE_EFFORT_CHOICES,
    CLAUDE_MODEL_CHOICES,
    DASHBOARD_SETTINGS_PATH,
    GITHUB_PROJECTS_ROOT,
    MAX_PROJECT_HISTORY,
    OTHER_STALE_SECONDS,
    PACKAGE_ROOT,
    PLUGINS_INSTALL_DIR_ENV,
    PROJECT_CACHE_DIR,
    PROJECT_HISTORY_PATH,
    QUEUE_STATES,
    SRC_DIR,
    WORKING_STALE_SECONDS,
    _EXCESS_FRACTIONAL_SECONDS_RE,
    _NEEDS_CLARIFICATION_REASON_TEXT,
    _build_lock,
    _build_state,
    _cache_paths_for_dir,
    _call_discuss,
    _chat_reservation_watchdog,
    _chat_reservations,
    _chat_reservations_lock,
    _discuss_provider_args,
    _fallback_cache_paths,
    _grepdirs_slug,
    _has_cost_usd_column,
    _has_hypothetical_cost_column,
    _has_instance_id_column,
    _migrate_legacy_cache_if_needed,
    _sanitize_disposition,
    claude_defaults,
    discover_github_repos,
    logger,
    parse_hb_timestamp,
    project_cache_paths,
    project_slug,
    read_dashboard_settings,
    read_project_history,
    remove_env_value,
    resolve_writable_cache,
    write_dashboard_settings,
    write_env_value,
)

# Moved verbatim into app_catalog_helpers.py (2026-10-01 breakdown); re-exported so every importer of app.X is unchanged.
from app_catalog_helpers import (  # noqa: F401
    ARCH_CANDIDATE_HEADING_RE,
    BRAIN_DUMP_NEEDS_ATTENTION_STATES,
    CHAT_STORAGE_DIR,
    CONCEPT_STABLE_STATUSES,
    GHOST_CONCEPT_ID,
    _BRANCH_CACHE_TTL_SECONDS,
    _COMMUNITY_ID_SUFFIX_RE,
    _DEEP_DIVE_ITEM_RE,
    _FAMILY_LABELS,
    _FAMILY_MEMBER_SUFFIXES,
    _GHOST_HAND_FIX_ACTORS,
    _PIPELINE_DAEMON_PGREP_RE,
    _TASK_REF_RE,
    _TOPOLOGY_FALLBACK_PATH,
    _TOPOLOGY_TTL_SECONDS,
    _adhoc_task_excerpt,
    _assign_brain_dump_serials,
    _brain_dump_needs_attention_count,
    _branch_cache,
    _branch_cache_lock,
    _call_chat,
    _find_concept_or_404,
    _find_live_task_file,
    _grep_dirs_from_query,
    _load_topology_fallback,
    _pid_alive,
    _resolve_under_second_brain,
    _slugify_project_name,
    _task_state_index,
    _topology_cache,
    parse_arch_candidates,
    slugify_concept_name,
    slugify_for_id,
    task_source_family_key,
    task_source_family_label,
)

# Moved verbatim into app_task_helpers.py (2026-10-01 breakdown); re-exported so every importer of app.X is unchanged.
from app_task_helpers import (  # noqa: F401
    BENCHMARK_CURRENT_POINTER,
    BENCHMARK_STATE_DIR,
    PIPELINE_HISTORY_LOG_FILENAME,
    _DIFF_GIT_HEADER_RE,
    _FENCED_JSON_RE,
    _GIVE_UP_ARCHIVE_STATES,
    _LANE_IDS_CACHE,
    _LANE_IDS_TTL_S,
    _QUOTED_SYMBOL_RE,
    _REPEATED_BLOCKER_THRESHOLD,
    _REPORT_PERIODS,
    _STOPWORDS,
    _TASK_INPUT_FIELDS,
    _archive_task_file,
    _case_result_score,
    _extract_balanced_json,
    _fetch_ollama_models,
    _files_touched_for,
    _jaccard,
    _parse_json_maybe_fenced,
    _quoted_symbols,
    _read_pipeline_history_events,
    _recent_task_ids_for_instance,
    _repeated_blocker_match,
    _safe_run_id,
    _significant_words,
    _task_input_summary,
    _zero_stats_model_row,
    task_summary,
)

# Moved verbatim into app_branch_helpers.py (2026-10-01 breakdown); re-exported so every importer of app.X is unchanged.
from app_branch_helpers import (  # noqa: F401
    _CANDIDATE_METADATA_LINE_RE,
    _CONFLICT_LINE_RE,
    _DESCRIPTION_MAX_CHARS,
    _HUB_LEGACY_MERGED,
    _HUB_TITLE_LABEL_RE,
    _RESOLUTION_LINE_RE,
    _TASK_TRAILER_RE,
    _annotate_hub_sibling_conflicts,
    _check_merge_conflict,
    _check_sibling_conflict,
    _describe_change,
    _detect_main_branch,
    _history_entry_detail_text,
    _hub_child_phase,
    _is_real_ship,
    _norm_path,
    _summarize_hub,
    _summarize_task_record,
)

# Moved verbatim into app_source_plugin_helpers.py (2026-10-01 breakdown); re-exported so every importer of app.X is unchanged.
from app_source_plugin_helpers import (  # noqa: F401
    ALWAYS_ACTIVE_SOURCES,
    SOURCE_DESCRIPTIONS,
    SOURCE_DOMAIN_LABELS,
    VALID_APPROVAL_MODES,
    VALID_WORKER_TYPES,
    _ALWAYS_ENSURE_DOMAINS,
    _COMMIT_LOG_FIELD_SEP,
    _COMMIT_LOG_RECORD_SEP,
    _DOMAIN_DEFAULTS_TO_ENSURE,
    _SOURCE_TO_DOMAIN_KEY,
    _acquire_apply_lock,
    _acquire_gpu_lease,
    _installed_plugin_version,
    _is_loopback_host,
    _job_log_outcome,
    _job_log_row_when,
    _job_log_task_dirs,
    _manifest_tabs_enabled,
    _pipeline_live_counts,
    _plugin_name_from_path,
    _release_apply_lock,
    _resolve_source_name,
    _validate_catalog_entry,
    _validate_catalog_pricing,
    _validate_catalog_source,
    _validate_plugin_tab,
    _version_tuple,
    validate_plugin_catalog,
)

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


ENV_FILE_PATH = PACKAGE_ROOT / "agent-manager.env"
# Which AGENT_MANAGER_REGISTER_PATH plugins are installed / enabled. Read by src/config.js's
# ensureRegistered() (JS side: src/plugins-manifest.js) and by the Plugins tab here. Lives
# beside agent-manager.env; seeded from AGENT_MANAGER_REGISTER_PATH on first read.
PLUGINS_MANIFEST_PATH = PACKAGE_ROOT / "plugins.json"
PLUGINS_INSTALL_DIR_DEFAULT = PACKAGE_ROOT / "plugins"
PLUGIN_CATALOG_PATH = PACKAGE_ROOT / "plugins-catalog.json"


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
    result = read_json_safe(p)
    return result if isinstance(result, dict) else {}


def read_json_safe(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


@app.route("/")
def index():
    return render_template("index.html")


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


def _second_brain_bench_dir(run_id: str | None = None) -> Path | None:
    sb = second_brain_dir()
    if not sb:
        return None
    return (sb / "Model Benchmarks" / run_id) if run_id else (sb / "Model Benchmarks")


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
        except sqlite3.DatabaseError:
            # is_file() only confirms the path exists -- a zeroed-out or otherwise
            # corrupt file (SQLite doesn't validate the header until first real access)
            # reaches here instead. Same "no data yet" contract as the missing-file case
            # above, rather than a 500 for every caller of this task's detail view.
            return None
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


# --- Live task-source topology -----------------------------------------------------------


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
    _arbiter_cancel_below, _chat_preempt_enabled, _chat_preempt_gate_state,
    _chat_preempt_max_age_s,
    _is_preemptable_child_pass, _kill_and_requeue_instance, _preempt_decision,
    _preempt_lane_sets, _preempt_pipeline_for_chat,
    _read_fresh_model_locks, log_preempt_gate_off,
)


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


def _run_git(args, cwd, timeout=30):
    result = subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


# Task states a hub child is "finished" in, for progress + readiness (mirrors
# coordinator-sweep.js's TERMINAL_GOOD).


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


def _active_project_label() -> str | None:
    """Registry label of the project the pipeline is running now (idle-pool borrowing: the Workers tab names the project each task belongs
    to), else the repo directory's name."""
    pd = get_pipeline_dir()
    rr = get_active_repo_root()
    for e in read_project_registry():
        if (pd and _norm_path(e.get("pipelineDir")) == _norm_path(pd)) or (rr and _norm_path(e.get("repoRoot")) == _norm_path(rr)):
            return e.get("label") or Path(str(e.get("repoRoot"))).name
    return Path(rr).name if rr else None


def _queue_dir_for_project_label(label):
    """queue/ of the registered project called `label` (a lane borrowing from that project reports it in its heartbeat), or None."""
    for e in read_project_registry():
        if e.get("label") == label and e.get("pipelineDir"):
            q = Path(e["pipelineDir"]) / "queue"
            if q.is_dir():
                return q
    return None


def _worker_project_info(hb: dict, active_label, active_qdir):
    """(projectLabel, borrowed, qdir) for a worker heartbeat. A lane running another suite project's task writes that project's label into its
    heartbeat (`project`); otherwise the task belongs to the active project. qdir is where that task's record and hub live."""
    project = hb.get("project") or active_label
    borrowed = bool(hb.get("project")) and hb.get("project") != active_label
    qdir = (_queue_dir_for_project_label(hb["project"]) if borrowed else None) or active_qdir
    return project, borrowed, qdir


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


class _DefaultHubDataProvider:
    """Swap point for "how does the dashboard look up hub data for a task/branch" (S5d
    of the hub-tasks extraction, 2026-09-25) -- the Python-side twin of the JS hooks
    (hub-apply-routing.js, apply-branch-prep-route.js, split-coverage-judging-route.js).
    Default = today's file-based lookup, moved here as static methods rather than a fresh
    reimplementation. Same "always-installed default" shape: every task/branch lookup
    needs SOME hub-data answer, and None is a valid one ("not part of a hub"), so there is
    no "unregistered" state.

    _summarize_hub / _hub_child_phase / _hub_label_index stay as plain module functions,
    not part of this interface -- they are internal helpers of the default implementation
    (used only by _hub_for_branch / tests), not something a caller reaches directly."""

    hub_for_branch = staticmethod(_hub_for_branch)
    hub_info_for_task = staticmethod(_hub_info_for_task)


_hub_data_provider = _DefaultHubDataProvider()


def get_hub_data_provider():
    return _hub_data_provider


def set_hub_data_provider(provider):
    """A single swap point, not a registry -- same discipline as the JS-side hooks.
    Passing None restores the default; used by tests to reset state between runs."""
    global _hub_data_provider
    _hub_data_provider = provider or _DefaultHubDataProvider()


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
        hub = get_hub_data_provider().hub_for_branch(qdir, f"agent/{task_id}", [])
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


def _branch_content_already_on_main(repo_root, main_branch, full_ref):
    """True when every file this branch changed (vs. where it forked from main) is byte-identical on origin/<main>: there is nothing left to merge.

    Why (2026-09-21): a SQUASH merge writes a new commit on main and leaves the branch's own commits unmerged by ancestry, so `rev-list main..branch` stayed >0 and
    the branch sat in the Unmerged Branches tab forever after its PR landed (the rolling agent/triage-queue branch after PRs squashed with --squash). Comparing
    CONTENT, not ancestry, catches that. Conservative on purpose: any doubt (git error, no merge-base, a huge file list, a file main has since changed differently, a
    branch that touches something main lacks) returns False, i.e. the branch stays listed. Kill switch: AGENT_MANAGER_BRANCH_LIST_HIDE_SQUASHED=false."""
    if os.environ.get("AGENT_MANAGER_BRANCH_LIST_HIDE_SQUASHED", "").strip().lower() == "false":
        return False
    try:
        base = _run_git(["merge-base", f"origin/{main_branch}", full_ref], repo_root).strip()
        if not base:
            return False
        changed = [f for f in _run_git(["diff", "--name-only", "-z", base, full_ref], repo_root).split("\0") if f]
        if not changed or len(changed) > 500:
            return False
        differing = _run_git(["diff", "--name-only", "-z", f"origin/{main_branch}", full_ref, "--", *changed], repo_root)
        return not any(differing.split("\0"))
    except (RuntimeError, subprocess.SubprocessError, OSError):
        return False


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
        if _branch_content_already_on_main(repo_root, main_branch, full_ref):
            # Landed by SQUASH (or an identical hand-applied change): the commits are "ahead" by ancestry but there is nothing left to merge.
            continue

        try:
            behind_raw = _run_git(["rev-list", "--count", f"{full_ref}..origin/{main_branch}"], repo_root)
            behind = int(behind_raw.strip() or "0")
        except (RuntimeError, ValueError):
            behind = None

        conflict = _check_merge_conflict(repo_root, main_branch, branch)

        label = _label_for_branch(task_id, pipeline_dir, subject.strip(), repo_root=repo_root)
        qdir = (pipeline_dir / "queue") if pipeline_dir else None
        hub = get_hub_data_provider().hub_for_branch(qdir, branch, [task_id])
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
    import branch_verdicts  # lazy: keeps app.py's import block untouched
    branch_verdicts.enrich_branches_with_verdicts(queue_dir(), repo_root, branches, _run_git, hub_lookup=get_hub_data_provider().hub_for_branch)
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


# Kept in sync by hand with src/task-sources.js's registerTaskSource() calls, same
# "Python duplicates Node's knowledge" convention already used for SECOND_BRAIN_DIR above.
# The canonical source-name list (Job List isActive checkboxes, /api/pipeline/start's
# task-domain healing) now comes from task_source_catalog() -> load_topology(), so it can
# never drift from the real registry (built-ins + AGENT_MANAGER_REGISTER_PATH plugins).


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


# --- Plugins tab ------------------------------------------------------------------------
# Enable/disable the AGENT_MANAGER_REGISTER_PATH plugins the manager is working on, and
# register a new one by path. Persists to plugins.json (PLUGINS_MANIFEST_PATH); src/
# config.js's ensureRegistered() loads only the enabled entries. Since every loop entry
# point re-runs ensureRegistered() in a fresh process per tick, a change takes effect on
# the next task -- the pipeline is still restarted on a change (like the Job List toggles)
# so an in-flight draft for a now-disabled source can't hit "no prompt template".


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


def _resolve_plugin_root(name: str):
    """Resolve a NAMED, enabled AGENT_MANAGER_REGISTER_PATH plugin's root directory as a
    Path, or None if not found/not enabled (S5a of the hub-tasks extraction, 2026-09-25) --
    the Python-side twin of
    src/resolve-plugin-root.js. Corrects the same real gap that module's own docstring
    describes: the ORIGINAL resolution this generalizes, `.split(",")[0]`, only ever worked
    because it assumed whichever plugin needed resolving was the FIRST (or only)
    comma-separated entry -- true for agent-manager-hygiene when that trick was built,
    false the moment a second plugin (agent-manager-hub-tasks) needed the same treatment.
    _read_plugins_manifest() always returns a list (it seeds from
    AGENT_MANAGER_REGISTER_PATH itself when plugins.json doesn't exist yet), so there is no
    separate raw-env-var fallback branch needed here the way the JS/bash side has one."""
    for entry in _read_plugins_manifest():
        if (
            isinstance(entry, dict)
            and entry.get("name") == name
            and entry.get("enabled") is not False
            and isinstance(entry.get("registerPath"), str)
            and entry["registerPath"].strip()
        ):
            return Path(entry["registerPath"].strip()).parent
    return None


# --- Manifest-driven dashboard tab (Docs/hub-tasks-extraction-plan.md section 5) --------
# A plugins.json entry may declare a `tab` object so its own dashboard tab is served from
# the plugin's repo instead of a hardcoded row in templates/index.html. `_validate_plugin_tab`
# is the schema gate: callers (api_plugins_add today; the tab-bar merge and the plugin
# static-file route in later pieces) treat an invalid `tab` as absent rather than crashing --
# the dashboard must behave exactly as today when no plugin declares a usable tab.


def _resolve_plugin_ui_asset(name: str, filename: str) -> tuple[Path | None, str | None, int]:
    """Resolves an asset under a plugin's 'ui/' directory for the plugin-served dashboard
    tab (piece 2). Returns (path, None, 200) on success, or (None, error, status) on
    failure. Refuses to serve anything for a plugin that is missing, disabled, or has no
    valid tab declared (piece 1's schema gate) -- a plugin only gets a static-file route
    once it has opted in with a well-formed tab. Within that, only .js/.css files that
    resolve (after following symlinks) inside the plugin's own ui/ directory are served;
    request-supplied '..' segments and symlink escapes are both refused."""
    if not _manifest_tabs_enabled():
        return None, "manifest-driven dashboard tabs are disabled (AGENT_MANAGER_MANIFEST_TABS=false)", 404
    manifest = _read_plugins_manifest()
    entry = next((p for p in manifest if p.get("name") == name), None)
    if entry is None:
        return None, f"no plugin named '{name}'", 404
    if entry.get("enabled") is False:
        return None, f"plugin '{name}' is not enabled", 404
    if _validate_plugin_tab(entry.get("tab")) is not None:
        return None, f"plugin '{name}' has no valid tab declared", 404
    register_path = entry.get("registerPath")
    if not register_path:
        return None, f"plugin '{name}' has no registerPath to serve ui/ assets from", 404

    requested = PurePosixPath(filename)
    if requested.is_absolute() or ".." in requested.parts:
        return None, "filename must be a relative path with no '..' segments", 400
    if requested.suffix not in (".js", ".css"):
        return None, "only .js and .css files are served", 400

    ui_dir = Path(os.path.realpath(os.path.join(os.path.dirname(register_path), "ui")))
    target = Path(os.path.realpath(str(ui_dir / filename)))
    try:
        target.relative_to(ui_dir)
    except ValueError:
        return None, "resolved path escapes the plugin's ui/ directory", 403
    if not target.is_file():
        return None, f"no such file: {filename}", 404
    return target, None, 200


# --- Marketplace (plugin catalog) -------------------------------------------------------
# The catalog is a static, pre-generated JSON file (plugins-catalog.json) at the package
# root. These helpers only read and validate it, and expose it via GET
# /api/plugins/marketplace alongside installed-plugin status. Hand-rolled strict
# validation -- no jsonschema dependency.


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


def _persist_launch_env(raw_path: str, include_apply: bool, skip_push: bool) -> None:
    """Write the launch toggles (REPO_ROOT/INCLUDE_APPLY/SKIP_PUSH) to ENV_FILE_PATH and
    mirror AGENT_MANAGER_REPO_ROOT into os.environ so the running dashboard process sees
    the new value immediately."""
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


def _build_pipeline_env(raw_path: str, include_apply: bool, skip_push: bool) -> dict:
    """Builds the child-process env for a pipeline start: records the project in the
    history, persists the launch toggles, resolves this project's per-project keys
    (AGENT_MANAGER_PIPELINE_DIR/DOMAINS_PATH, AGENT_MANAGER_APPLY_REPO_ROOT, and
    AGENT_MANAGER_GREP_DIRS) to the registered project's values or clears stale ones,
    then merges agent-manager.env over os.environ. Extracted verbatim from
    _start_pipeline so the env setup is testable in isolation; behavior is unchanged."""
    record_project_used(raw_path)
    _persist_launch_env(raw_path, include_apply, skip_push)

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
    return {**os.environ, **env_overrides}


def _ensure_registry_entry(child_env: dict, raw_path: str) -> None:
    """Records this project's registry entry (repoRoot -> pipelineDir/domainsPath) so a
    later brain-dump routing decision can locate THIS project's queue even after a
    different project becomes active (project-history.json alone only ever stored the
    bare repoRoot). Same pipelineDir/domainsPath resolution _build_pipeline_env used,
    ending in the same record_project_registry_entry upsert _start_pipeline did inline."""
    pipeline_dir_for_registry = child_env.get("AGENT_MANAGER_PIPELINE_DIR") or raw_path
    domains_path_for_registry = child_env.get("AGENT_MANAGER_DOMAINS_PATH") or str(Path(pipeline_dir_for_registry) / "task-domains.json")
    record_project_registry_entry(raw_path, pipeline_dir_for_registry, domains_path_for_registry)


def _launch_pipeline_subprocess(child_env: dict, raw_path: str, include_apply: bool, skip_push: bool) -> dict:
    """Spawns the actual pipeline daemons for this project, platform-specific: stomps
    any ComfyUI GPU lease PromptForge left behind (an explicit start is a "GPU work now"
    signal), fires the proactive file-decompose sweep, then launches either
    scripts/launch.sh (Linux) or the PowerShell console-window daemons (Windows).
    Extracted verbatim from _start_pipeline so the launch step is testable in
    isolation; behavior is unchanged."""
    # Explicit pipeline start is a "GPU work now" signal -- stomp any ComfyUI GPU lease
    # PromptForge left behind (see _acquire_gpu_lease).
    _acquire_gpu_lease()

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
        # S4a of the hub-tasks extraction (2026-09-24): proactive-file-decompose-sweep.js
        # moved to agent-manager-hygiene. Resolved BY NAME via _resolve_plugin_root (S5a,
        # 2026-09-25) -- skipped (not an error) if the hygiene plugin isn't installed, same
        # as scripts/queue-watcher.sh's own guard.
        _hygiene_root = _resolve_plugin_root("agent-manager-hygiene")
        _proactive_sweep = _hygiene_root / "src" / "proactive-file-decompose-sweep.js" if _hygiene_root else None
        if _proactive_sweep and _proactive_sweep.is_file():
            _decompose_log_dir = Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/logs"
            _decompose_log_dir.mkdir(parents=True, exist_ok=True)
            subprocess.Popen(
                ["node", str(_proactive_sweep), "--force"],
                env=child_env,
                cwd=str(_proactive_sweep.parent),
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


def _start_pipeline(raw_path: str, include_apply: bool, skip_push: bool) -> dict:
    """Writes the chosen path/toggles into agent-manager.env (creating the file if it
    doesn't exist yet) and spawns the relevant loops as real, visible console windows,
    same as launch.bat's own `start powershell.exe -NoExit ...` pattern -- shared by
    /api/pipeline/start and _restart_pipeline()."""
    child_env = _build_pipeline_env(raw_path, include_apply, skip_push)

    _ensure_task_domains(child_env, raw_path, list(read_active_job_types()))

    _ensure_registry_entry(child_env, raw_path)

    return _launch_pipeline_subprocess(child_env, raw_path, include_apply, skip_push)


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
from routes.branch_verdicts import branch_verdicts_bp  # noqa: E402
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
app.register_blueprint(branch_verdicts_bp)
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

    # plugin_process_manager.start() was previously only ever called from the manual
    # /api/plugins/select-slot UI action -- a slotted plugin marked active:true in
    # plugins.json (e.g. agent-manager-chat-plugin) had no path back to running after
    # its process died or the dashboard itself restarted. start() is idempotent
    # (skips if its own pidfile already shows it running), so this is safe to run on
    # every boot, including both reloader passes.
    for _plugin in _read_plugins_manifest():
        if _plugin.get("slot") and _plugin.get("active") and _plugin.get("process"):
            if plugin_process_manager.start(_plugin):
                _wait_for_plugin_health(_plugin)
            else:
                print(f"[dashboard] failed to auto-start active plugin '{_plugin.get('name')}' -- see "
                      f"~/.local/state/agent-manager/logs/plugin-{_plugin.get('name')}.log", file=sys.stderr)
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
