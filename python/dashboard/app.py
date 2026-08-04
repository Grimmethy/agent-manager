#!/usr/bin/env python3
"""Read-only monitoring dashboard for the agent-manager pipeline. No database, no build
step -- reads queue/*.json and instances/*.json directly off disk, the same filesystem
state every other part of this package already uses.

Usage: python dashboard/app.py
Reads AGENT_MANAGER_PIPELINE_DIR (or AGENT_MANAGER_REPO_ROOT as a fallback) for where
queue/ and instances/ live, same as every other script in this package.
AGENT_MANAGER_DASHBOARD_PORT (default 7420) picks the port.
"""

import hashlib
import json
import os
import re
import shutil
import sqlite3
import string
import subprocess
import sys
import threading
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


QUEUE_STATES = ["pending", "review", "approved", "blocked", "done"]

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


def second_brain_dir() -> Path | None:
    """Same SECOND_BRAIN_DIR env var ornith-worker.ps1 / src/config.js already read --
    kept in sync by hand since this dashboard is Python, not Node."""
    v = os.environ.get("SECOND_BRAIN_DIR")
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
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/instances")
def api_instances():
    results = []
    inst_dir = instances_dir()
    if inst_dir and inst_dir.is_dir():
        for f in sorted(inst_dir.glob("*.json")):
            data = read_json_safe(f)
            if not data or not data.get("instanceId") or not data.get("lastHeartbeat"):
                continue
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
        rows = conn.execute("""
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
                   SUM(CASE WHEN call_error IS NOT NULL THEN 1 ELSE 0 END) AS error_count
            FROM model_calls
            WHERE stage = 'implement'
            GROUP BY model
            ORDER BY model
        """).fetchall()
    finally:
        conn.close()

    results = []
    for model, call_count, approved, rejected, avg_latency_ms, avg_tok_s, min_tok_s, max_tok_s, degenerate_count, error_count in rows:
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
        })
    return jsonify(results)


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

    entries = []
    total = 0
    state_dir = qdir / state
    if state_dir.is_dir():
        files = sorted(state_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        total = len(files)
        page = files[offset:offset + limit] if limit is not None else files[offset:]
        for f in page:
            data = read_json_safe(f)
            if data:
                entries.append(task_summary(data, f.stem))
    return jsonify({"items": entries, "total": total})


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
                    return jsonify(data)
        abort(404)

    if state not in QUEUE_STATES:
        abort(404)
    f = qdir / state / f"{task_id}.json"
    data = read_json_safe(f)
    if not data:
        abort(404)
    return jsonify(data)


@app.route("/api/task/<state>/<task_id>/archive", methods=["POST"])
def api_task_archive(state, task_id):
    """Manual archive (Job Status > Blocked/Done tabs, per-row button): moves the task file
    to queue/done/_archived_no_action/ -- not a new convention, the exact folder already
    used for every manual archive done by hand earlier in this project's history.
    Load-bearing detail: src/task-sources.js's taskIdExistsInQueue() only ever checks the
    direct queue/<state>/<id>.json path, never nested subfolders, so moving a file here
    silently frees up its underlying item (a brain-dump entry, an arch_import itemId, a
    deep_dive community) for reconsideration next time its source generator runs -- with
    zero source-specific logic needed on this end."""
    if state not in ("blocked", "done"):
        abort(400, description="only a blocked or done task can be archived")
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


@app.route("/api/task/<state>/<task_id>/requeue", methods=["POST"])
def api_task_requeue(state, task_id):
    """Manual requeue (Job Status > Blocked/Done tabs, per-row button): moves the task back
    to pending/, stripped to the same shape a freshly-generated task has -- every
    drafting/review/apply artifact (blockedReason, doneMarker, ornithVotes, planResponse,
    implementResponse, etc.) is dropped, not carried forward. ornithRejectCount resets to 0
    deliberately: a manual requeue is a deliberate human do-over, not a continuation of the
    same automatic retry cycle queue-watchdog.ps1's Invoke-RejectRetryCheck already runs for
    review-stage rejections (capped at $MaxOrnithRejectRetries=2) -- carrying the old count
    forward would let a manually-requeued task block again after fewer real attempts than
    a task hitting that cap for the first time gets."""
    if state not in ("blocked", "done"):
        abort(400, description="only a blocked or done task can be requeued")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    src = qdir / state / f"{task_id}.json"
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
                return jsonify({**data, "_foundState": "drafting"})

    for state in QUEUE_STATES:
        data = read_json_safe(qdir / state / f"{task_id}.json")
        if data:
            return jsonify({**data, "_foundState": state})

    abort(404, description=f"task {task_id} not found in any queue state")


@app.route("/api/summary")
def api_summary():
    qdir = queue_dir()
    counts = {s: 0 for s in QUEUE_STATES}
    counts["drafting"] = 0
    counts["brain-dump"] = sum(1 for e in read_brain_dump_entries() if e.get("status") != "actioned")
    if not qdir:
        return jsonify(counts)

    for state in QUEUE_STATES:
        state_dir = qdir / state
        counts[state] = len(list(state_dir.glob("*.json"))) if state_dir.is_dir() else 0
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        counts["drafting"] = len(list(drafting_root.rglob("*.json")))
    return jsonify(counts)


def read_brain_dump_entries() -> list:
    path = brain_dump_path()
    if not path:
        return []
    data = read_json_safe(path)
    entries = data.get("entries") if isinstance(data, dict) else None
    return entries if isinstance(entries, list) else []


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


@app.route("/api/brain-dump")
def api_brain_dump():
    """Brain Dump tab's left pane. Defaults to everything not yet actioned (captured +
    sorted) -- the working queue a human actually needs to see. ?status=<value> narrows to
    one status, ?status=all returns the full history."""
    entries = read_brain_dump_entries()
    status_filter = request.args.get("status", "").strip()
    if status_filter and status_filter != "all":
        entries = [e for e in entries if e.get("status") == status_filter]
    elif not status_filter:
        entries = [e for e in entries if e.get("status") != "actioned"]
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

    path = brain_dump_path()
    if not path:
        abort(500, description="no active project configured")

    data = read_json_safe(path)
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        data = {"entries": []}

    entry_id = f"bd-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{slugify_for_id(text)}"
    entry = {
        "id": entry_id,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "rawText": text,
        "status": "captured",
    }
    data["entries"].append(entry)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
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
        ornith_model = os.environ.get("ORNITH_MODEL", "ornith:9b")
        result = build_graph.build_graph_data(Path(path_str), grep_dirs, ollama_url, ornith_model, progress=progress)

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
    "adhoc", "trouble_log", "secondbrain", "brain_dump_sort", "arch_review",
    "arch_import_review", "arch_discovery", "arch_import", "observability_review",
    "deep_dive", "project_search", "unused_export",
]

# Exempt from any allowlist restriction regardless of stored state -- task-sources.js's
# getNextTask() hardcodes this same exemption ('adhoc': fixed contract per README,
# "preempts every deterministic source"; 'brain_dump_sort': always-on background source,
# confirmed live 2026-07-23 it was silently getting gated out by Project Search mode's
# allowlist before that fix). Presenting either as toggleable in the UI would be a lie.
ALWAYS_ACTIVE_SOURCES = {"adhoc", "brain_dump_sort"}


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
    "adhoc": 10, "trouble_log": 20, "secondbrain": 40, "brain_dump_sort": 42,
    "arch_review": 70, "arch_import_review": 71, "arch_discovery": 80, "observability_review": 80,
    "arch_import": 81, "deep_dive": 82, "project_search": 85, "unused_export": 90,
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
# deep_dive, brain_dump_sort, secondbrain) -- but six of them (trouble_log, arch_review,
# arch_import_review, arch_discovery, arch_import, observability_review, unused_export)
# all share the single 'default' domain (task-sources.js's defaultDomain), since
# task-sources.js's own getConfig().defaultDomain is what nextCandidateFulfillmentTask/
# nextTroubleLogTask/nextArchDiscoveryTask/nextArchImportTask/nextObservabilityReviewTask/
# nextUnusedExportTask all stamp -- confirmed by reading each one directly, not assumed
# from the source name. Getting this mapping WRONG (or incomplete) is exactly what
# happened before this fix: 'default' was missing entirely from _DOMAIN_DEFAULTS_TO_ENSURE,
# so every arch_import/observability_review/trouble_log task failed immediately with
# "Unknown task domain: default" from its very first run against a freshly-started project
# (confirmed live 2026-07-26 on TaxHarvest: 250 tasks accumulated blocked before anyone
# noticed, since a blocked task produces no visible error beyond the Blocked tab's count).
_SOURCE_TO_DOMAIN_KEY = {
    "trouble_log": "default", "arch_review": "default", "arch_import_review": "default",
    "arch_discovery": "default", "arch_import": "default", "observability_review": "default",
    "unused_export": "default",
    "project_search": "project_search", "deep_dive": "deep_dive",
    "brain_dump_sort": "brain_dump_sort", "secondbrain": "secondbrain", "adhoc": "adhoc",
}

_DOMAIN_DEFAULTS_TO_ENSURE = {
    "default": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "adhoc": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "secondbrain": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "project_search": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "deep_dive": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "brain_dump_sort": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
}

# adhoc and brain_dump_sort are always in read_active_job_types()'s result regardless of
# any allowlist (see ALWAYS_ACTIVE_SOURCES above) -- ensure their domains unconditionally,
# a belt-and-suspenders floor in case some future call site ever passes a hand-built
# task_sources list that forgot one, since the failure mode ("Unknown task domain") is
# silent and easy to miss (as just proven).
_ALWAYS_ENSURE_DOMAINS = ["brain_dump_sort", "adhoc"]


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
    return jsonify([
        {
            "name": name,
            "active": name in active,
            "alwaysActive": name in ALWAYS_ACTIVE_SOURCES,
            "priority": priorities.get(name, TASK_SOURCE_DEFAULT_PRIORITIES.get(name)),
            "approvalMode": approval_modes.get(name),
        }
        for name in TASK_SOURCE_CATALOG
    ])


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


def _stop_pipeline() -> list:
    """Kills whatever the current instances/*.json heartbeats say is running, by PID --
    same trust model queue-watchdog.ps1's own dead-process check already uses. Does NOT
    touch anything if nothing looks like it's running, so this is safe to call even when
    unsure. Shared by /api/pipeline/stop and _restart_pipeline()."""
    inst_dir = instances_dir()
    if not inst_dir or not inst_dir.is_dir():
        return []

    stopped = []
    for f in inst_dir.glob("*.json"):
        data = read_json_safe(f)
        if not data or not data.get("pid"):
            continue
        try:
            subprocess.run(["taskkill", "/F", "/PID", str(data["pid"])], capture_output=True, timeout=10)
            stopped.append(data.get("instanceId", str(data["pid"])))
        except (OSError, subprocess.SubprocessError):
            continue
        finally:
            # Confirmed live (2026-07-22): without this, _pipeline_running()'s worker-1
            # heartbeat check kept reporting the pipeline as running for up to
            # WORKING_STALE_SECONDS (20 min) after a real, successful stop -- the killed
            # process's last-written heartbeat file just sat there looking recent, and
            # /api/pipeline/start's "already running" guard blocked a genuine restart the
            # whole time. Remove the heartbeat regardless of whether taskkill itself
            # reported success (the process may have already been dead) -- either way,
            # this instance should no longer read as live.
            try:
                f.unlink()
            except OSError:
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
        return {"started": False, "reason": "process auto-start is only implemented for Windows -- use launch.bat manually"}

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
    _stop_pipeline()
    include_apply = env.get("AGENT_MANAGER_INCLUDE_APPLY", "false") == "true"
    skip_push = env.get("AGENT_MANAGER_APPLY_SKIP_PUSH", "true") == "true"
    _start_pipeline(raw_path, include_apply, skip_push)


@app.route("/api/pipeline/start", methods=["POST"])
def api_pipeline_start():
    """The Project tab's entry point. includeApply controls whether apply-runner.ps1 runs
    at all (False = nothing can touch the target repo's files or git history, the safest
    setting); skipPush controls whether apply-runner is allowed to push approved commits
    to the remote once it does run. Which job TYPES run is no longer chosen here -- see
    /api/job-types, a top-level setting independent of which project this starts against."""
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
    return jsonify({"stopped": _stop_pipeline()})


if __name__ == "__main__":
    port = int(os.environ.get("AGENT_MANAGER_DASHBOARD_PORT", "7420"))
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
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=True)
