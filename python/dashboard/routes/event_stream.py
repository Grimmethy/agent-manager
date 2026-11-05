"""GET /api/stream -- the dashboard's server-sent-event channel (event_stream.py). The page listens to it (static/js/live-updates.js); the pieces of 'UI triggers, not polls' that built it are listed in docs/adr/0024-triggers-not-polls.md."""
import os
import re
import urllib.request

from flask import Blueprint, Response, jsonify, request, stream_with_context

import event_stream

event_stream_bp = Blueprint("event-stream-bp", __name__)
KEEPALIVE_S = 15.0     # a comment line so a dead connection is noticed; it carries no data and triggers no redraw


def _resolve():
    from app import instances_dir, queue_dir, PLUGINS_MANIFEST_PATH
    return {"queue": queue_dir(), "instances": instances_dir(), "plugins": PLUGINS_MANIFEST_PATH}


def _providers():
    """Facts the hub cannot derive from the queue directories. memory-changed: the host-memory chip's state and reason, from the gpu-broker's marker file."""
    import memory_status
    # The marker's reason carries live numbers ("memory stall 11.64%"): announce a change of the STATE or of the reason's wording, never of a number inside it.
    return {"hardware-changed": (_http(_hardware_url), HARDWARE_INTERVAL_S),
            "tokenfold-changed": (_http(_tokenfold_url), TOKENFOLD_INTERVAL_S),
            "reports-changed": event_stream.dir_files_fact(_reports_specs),
            "discovery-changed": event_stream.dir_files_fact(lambda: [], _discovery_files),
            "plugin-states-changed": (_plugin_states, PLUGIN_STATES_INTERVAL_S),
            "settings-changed": event_stream.dir_files_fact(lambda: [], _settings_files),
            "benchmark-changed": event_stream.dir_files_fact(_benchmark_specs, subdirs=True),
            "worker-panels-changed": event_stream.dir_files_fact(_panel_specs, _panel_files), "memory-changed": event_stream.json_file_fact(memory_status.marker_path, lambda d: (d.get("state"), re.sub(r"\d+", "#", str(d.get("reason") or ""))))}


# The files the Workers tab's panels read (routes/stalled_worker.py, verifier_worker.py, needswork_worker.py, context_worker.py, pipeline_ops_workers.py, cloud_meter.py, worker_switch.py and the
# cost summary): the pipeline-ops workers' ledgers, indexes and on/off markers, the cloud gateway's spend ledger, the worker switch markers and the model-stats database. NOT their drain logs,
# beats, locks or trigger files: those are rewritten on every idle tick and would announce nothing new.
PANEL_FILE_RE = re.compile(r"(-ledger\.jsonl|-index\.json|-disabled)$")
WORKER_MARKER_RE = re.compile(r"^worker-[a-z0-9]+$")


def _panel_specs():
    import worker_switch
    from routes import context_worker
    ops = context_worker.state_dir()
    return [(ops, PANEL_FILE_RE), (os.path.join(ops, "gateway"), PANEL_FILE_RE), (worker_switch.switch_dir(), WORKER_MARKER_RE)]


def _settings_files():
    """The files the Job List and Models tabs' settings come from (routes/job_types.py, routes/worker_models_1_more.py): agent-manager.env (the task-source allowlist, priorities, approval modes, worker types,
    the lane models), dashboard-settings.json and the lanes registry file (the models each lane runs)."""
    from app import ENV_FILE_PATH
    from app_settings_helpers import DASHBOARD_SETTINGS_PATH
    from app import SRC_DIR, read_env_file
    registry = {**os.environ, **read_env_file(ENV_FILE_PATH)}.get("AGENT_MANAGER_LANES_PATH") or str(SRC_DIR.parent / "lanes.json")
    return [ENV_FILE_PATH, DASHBOARD_SETTINGS_PATH, registry]


# Sampled sources: the hardware plugin's stats and the TokenFold proxy's stats are live numbers behind HTTP, with no file to watch. ONE shared sampler asks them (the hub's single clock, only while a page
# is connected) every few seconds and announces a change only when a number moved by a visible amount (event_stream.coarse: two significant figures); a service that goes away or comes back is a change too.
HARDWARE_INTERVAL_S = 5.0
PLUGIN_STATES_INTERVAL_S = 5.0            # one shared sampler pass over the plugin pid files; the Plugins tab never samples
TOKENFOLD_INTERVAL_S = 10.0


def _hardware_url():
    from routes.hardware import _active_hardware_plugin
    active = _active_hardware_plugin()
    return "%s/api/hardware/stats" % active["url"] if active and active.get("url") else None


def _tokenfold_url():
    return "http://localhost:%s/tokenfold/stats" % os.environ.get("TOKENFOLD_PORT", "9339")


def _http(url_fn):
    # the opener is looked up at call time so a test can replace urllib.request.urlopen
    return event_stream.http_json_fact(url_fn, opener=lambda *a, **k: urllib.request.urlopen(*a, **k))


def _reports_specs():
    """The Markdown reports the Reports tab lists: <Second Brain>/Agent Manager Reports/<period>/<file>.md for every period."""
    from app import _REPORT_PERIODS
    from routes.reports import _reports_root
    root = _reports_root()
    return [(str(root / period), re.compile(r"\.md$")) for period in _REPORT_PERIODS] if root else []


def _mtime_ns(path):
    try:
        return os.stat(path).st_mtime_ns
    except (OSError, TypeError, ValueError):
        return None


def _head_log_path(cwd):
    """`logs/HEAD` of the git directory that governs `cwd` (git's own upward search: the nearest ancestor holding `.git`, a directory or a worktree's `gitdir:` file), or None.
    Pure file reads: the reflog is appended on every commit, pull, merge and checkout, so its mtime is the cheap signal that "HEAD moved"."""
    path = os.path.abspath(cwd)
    while True:
        dot_git = os.path.join(path, ".git")
        if os.path.isdir(dot_git):
            return os.path.join(dot_git, "logs", "HEAD")
        if os.path.isfile(dot_git):
            try:
                with open(dot_git, encoding="utf-8") as f:
                    line = f.readline().strip()
            except OSError:
                return None
            if line.startswith("gitdir:"):
                return os.path.join(os.path.normpath(os.path.join(path, line[len("gitdir:"):].strip())), "logs", "HEAD")
            return None
        parent = os.path.dirname(path)
        if parent == path:
            return None
        path = parent


def _plugin_states(full=False):
    """What the Plugins tab shows beyond plugins.json, as a value that changes exactly when the tab would look different: for every plugin that owns a process
    (a slot or a processName) whether it is running, when its pid file was written (a restart) and when its checkout last moved (`.git/logs/HEAD` of the directory behind_checkout runs git in: a commit, pull or
    checkout, which is what flips "restart needed"). Stat calls only: no git process is spawned on the sampler's clock. Never raises: an unreadable manifest is ()."""
    import plugin_process_manager as ppm
    from app import _read_plugins_manifest
    try:
        manifest = _read_plugins_manifest()
    except Exception:
        return ()
    rows = []
    for entry in manifest if isinstance(manifest, list) else []:
        if not isinstance(entry, dict) or not (entry.get("slot") or entry.get("processName")):
            continue
        key = ppm.process_key(entry)
        cwd = entry.get("cwd") or os.getcwd()                     # the same directory plugin_process_manager.behind_checkout runs git in
        head = _head_log_path(cwd) if isinstance(cwd, str) else None
        rows.append([str(entry.get("name") or key), bool(ppm.is_running(key)), _mtime_ns(ppm._pidfile(key)), _mtime_ns(head)])
    return tuple(sorted(rows, key=lambda r: r[0]))


def _discovery_files():
    """The files the Deep Dive and Discovery tabs read, for the ACTIVE project (resolved on every pass): the project-search index (the scouted leads), the deep-dive coverage file, the arch-discovery community
    coverage file and the architecture review candidates document. A path that does not exist (or no active project) simply contributes nothing. The arch-discovery TASKS the Discovery tab lists live in the
    queue, which counts-changed already announces."""
    from app import arch_candidates_path, community_coverage_path, project_search_index_path
    from routes.deep_dive import deep_dive_coverage_path
    return [project_search_index_path(), deep_dive_coverage_path(), community_coverage_path(), arch_candidates_path()]


def _benchmark_specs():
    """The benchmark state: <repo>/.agent-manager-cache/benchmarks holds the current-run-id.txt pointer and one directory per run (a run directory changes while a benchmark runs)."""
    from app import BENCHMARK_STATE_DIR
    return [(str(BENCHMARK_STATE_DIR), re.compile(r"."))]


def _panel_files():
    from app import model_stats_db_path
    db = model_stats_db_path()
    return [db, (str(db) + "-wal") if db else None]


@event_stream_bp.route("/api/stream")
def api_stream():
    if not event_stream.enabled():
        return jsonify({"enabled": False}), 404
    hub = event_stream.get_hub(_resolve, _providers())
    try:
        last_id = int(request.headers.get("Last-Event-ID", ""))
    except ValueError:
        last_id = None

    def generate():
        seq = hub.subscribe()
        try:
            yield "retry: 3000\n\n"
            events, resync = ([], True) if last_id is None else hub.events_after(last_id, 0)
            if resync:
                yield event_stream.sse("snapshot", {"seq": seq, "events": hub.event_names()}, seq)
                cursor = seq
            else:
                cursor = last_id
                for e in events:
                    yield event_stream.sse(e["event"], e["data"], e["id"])
                    cursor = e["id"]
            while True:
                events, resync = hub.events_after(cursor, KEEPALIVE_S)
                if resync:
                    cursor = hub.status()["seq"]       # read once, BEFORE the yield: an event published while the snapshot is being sent must still be delivered next
                    yield event_stream.sse("snapshot", {"seq": cursor, "events": hub.event_names()}, cursor)
                    continue
                if not events:
                    yield ": keepalive\n\n"
                    continue
                for e in events:
                    yield event_stream.sse(e["event"], e["data"], e["id"])
                    cursor = e["id"]
        finally:
            hub.unsubscribe()

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
