"""Dashboard settings helpers: shared constants and logger, project history, dashboard and Claude settings, discuss-provider args, project cache paths and the chat-reservation watchdog.

Moved verbatim out of app.py (2026-10-01 breakdown). app.py re-exports every name below, so `from app import X` and `app.X` keep working."""

import hashlib
import json
import logging
import re
import shutil
import sqlite3
import threading
import time
from datetime import datetime, timezone
from flask import abort, request
from pathlib import Path


logger = logging.getLogger(__name__)


_NEEDS_CLARIFICATION_REASON_TEXT = {
    "no-match": "No matching file found for this change.",
    "ambiguous": "Multiple candidate files found -- needs a human pick.",
}


QUEUE_STATES = ["pending", "review", "approved", "blocked", "done", "needs-clarification", "awaiting-confirm", "coordinating"]


# dashboard/ -> python/ -> package root (where agent-manager.env, launch.bat, and src/ live).
PACKAGE_ROOT = Path(__file__).resolve().parent.parent.parent


SRC_DIR = PACKAGE_ROOT / "src"


# Where installed plugins live (overridable for tests), and the static marketplace
# catalog file (plugins-catalog.json) at the package root. The dashboard only reads
# and validates the catalog -- it never fetches or writes it.
PLUGINS_INSTALL_DIR_ENV = "AGENT_MANAGER_PLUGINS_DIR"


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
    except (TimeoutError, ConnectionError) as e:
        abort(502, description=f"local model call failed ({e}) -- it may be busy with an active worker-lane task; try again shortly or switch to Claude.")


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
