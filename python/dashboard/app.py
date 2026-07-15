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
import string
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, abort, request

# build_graph.py / visualize_graph.py live one directory up (python/), not inside
# dashboard/ -- added explicitly rather than relying on an installed package, matching
# this whole project's no-build-step, run-from-source philosophy.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import build_graph  # noqa: E402
import visualize_graph  # noqa: E402

app = Flask(__name__)

QUEUE_STATES = ["pending", "review", "approved", "blocked", "done"]

# dashboard/ -> python/ -> package root (where agent-manager.env, launch.bat, and src/ live).
PACKAGE_ROOT = Path(__file__).resolve().parent.parent.parent
ENV_FILE_PATH = PACKAGE_ROOT / "agent-manager.env"
SRC_DIR = PACKAGE_ROOT / "src"

# Project tab: browsing/graphing an arbitrary codebase is decoupled from whichever repo
# the live worker/review-runner/apply-runner/queue-watchdog loops are actually pointed at
# (that's still controlled by agent-manager.env + launch.bat) -- this lets you explore any
# project's structure without touching, or needing, a running pipeline for it. Each
# browsed project gets its own cache dir here, keyed by a hash of its absolute path, so
# multiple projects' graphs can be inspected across sessions without colliding or writing
# anything into the target project itself.
PROJECT_CACHE_DIR = Path(__file__).resolve().parent / "project_cache"

# In-memory only -- background-build progress/status for whichever project(s) a build was
# triggered for THIS server process's lifetime. Deliberately not persisted: a build in
# progress when the server restarts should just be re-triggered, not resumed.
_build_state = {}
_build_lock = threading.Lock()


def project_slug(path_str: str) -> str:
    return hashlib.sha256(path_str.encode("utf-8")).hexdigest()[:16]


def project_cache_paths(path_str: str) -> dict:
    slug = project_slug(path_str)
    cache_dir = PROJECT_CACHE_DIR / slug
    return {
        "dir": cache_dir,
        "graph": cache_dir / "graph.json",
        "coverage": cache_dir / "coverage.json",
        "meta": cache_dir / "meta.json",
    }

# Same staleness thresholds TaxHarvest's own dashboard route already used: a 'working'
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


def read_json_safe(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


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
    from datetime import datetime, timezone

    results = []
    inst_dir = instances_dir()
    if inst_dir and inst_dir.is_dir():
        for f in sorted(inst_dir.glob("*.json")):
            data = read_json_safe(f)
            if not data or not data.get("instanceId") or not data.get("lastHeartbeat"):
                continue
            try:
                last_hb = datetime.fromisoformat(data["lastHeartbeat"].replace("Z", "+00:00"))
                if last_hb.tzinfo is None:
                    last_hb = last_hb.replace(tzinfo=timezone.utc)
                age = (datetime.now(timezone.utc) - last_hb).total_seconds()
            except (ValueError, KeyError):
                age = None
            threshold = WORKING_STALE_SECONDS if data.get("status") == "working" else OTHER_STALE_SECONDS
            results.append({
                **data,
                "heartbeatAgeSeconds": round(age) if age is not None else None,
                "stale": age is not None and age > threshold,
            })
    results.sort(key=lambda r: r.get("instanceId") or "")
    return jsonify(results)


@app.route("/api/queue/<state>")
def api_queue_state(state):
    qdir = queue_dir()
    if not qdir:
        return jsonify([])

    if state == "drafting":
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
        return jsonify(entries)

    if state not in QUEUE_STATES:
        abort(404)
    entries = []
    state_dir = qdir / state
    if state_dir.is_dir():
        for f in sorted(state_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            data = read_json_safe(f)
            if data:
                entries.append(task_summary(data, f.stem))
    return jsonify(entries)


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


@app.route("/api/summary")
def api_summary():
    qdir = queue_dir()
    counts = {s: 0 for s in QUEUE_STATES}
    counts["drafting"] = 0
    if not qdir:
        return jsonify(counts)

    for state in QUEUE_STATES:
        state_dir = qdir / state
        counts[state] = len(list(state_dir.glob("*.json"))) if state_dir.is_dir() else 0
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        counts["drafting"] = len(list(drafting_root.rglob("*.json")))
    return jsonify(counts)


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


@app.route("/api/project/status")
def api_project_status():
    raw_path = request.args.get("path", "").strip()
    if not raw_path:
        abort(400, description="path query param is required")

    cache = project_cache_paths(raw_path)
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

        cache = project_cache_paths(path_str)
        cache["dir"].mkdir(parents=True, exist_ok=True)
        cache["graph"].write_text(json.dumps(result["graph"], indent=2), encoding="utf-8")
        cache["coverage"].write_text(json.dumps(result["coverage"], indent=2), encoding="utf-8")
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

    grep_dirs = body.get("grepDirs") or ["src", "frontend/src", "backend/src"]
    grep_dirs = [d for d in grep_dirs if (Path(raw_path) / d).is_dir()]
    if not grep_dirs:
        abort(400, description="none of the given grepDirs exist under this path -- pass an explicit grepDirs list")

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
    cache = project_cache_paths(raw_path)
    if not cache["graph"].is_file():
        return "<p style='font-family:sans-serif;padding:20px'>No graph built yet for this project.</p>", 404

    graph_data = json.loads(cache["graph"].read_text(encoding="utf-8"))
    coverage_data = read_json_safe(cache["coverage"])
    html = visualize_graph.render_html(graph_data, coverage_data)
    return html


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
    try:
        last_hb = datetime.fromisoformat(data["lastHeartbeat"].replace("Z", "+00:00"))
        if last_hb.tzinfo is None:
            last_hb = last_hb.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - last_hb).total_seconds()
    except (ValueError, KeyError):
        return False
    threshold = WORKING_STALE_SECONDS if data.get("status") == "working" else OTHER_STALE_SECONDS
    return age <= threshold


@app.route("/api/pipeline/status")
def api_pipeline_status():
    return jsonify({
        "activeRepoRoot": get_active_repo_root(),
        "running": _pipeline_running(),
    })


@app.route("/api/pipeline/start", methods=["POST"])
def api_pipeline_start():
    """The Project tab's "make it automatic" entry point: writes the chosen path into
    agent-manager.env (creating the file if it doesn't exist yet -- no more required
    manual copy-the-example-file step) and spawns the 4 loops as real, visible console
    windows, same as launch.bat's own `start powershell.exe -NoExit ...` pattern, just
    triggered by a click instead of a batch file."""
    if _pipeline_running():
        return jsonify({"started": False, "reason": "a pipeline is already running -- stop it first"}), 409

    body = request.get_json(silent=True) or {}
    raw_path = (body.get("path") or "").strip()
    if not raw_path:
        abort(400, description="path is required")
    if not Path(raw_path).is_dir():
        abort(404, description="path does not exist")

    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_REPO_ROOT", raw_path)

    env_overrides = read_env_file(ENV_FILE_PATH)
    env_overrides["AGENT_MANAGER_REPO_ROOT"] = raw_path
    child_env = {**os.environ, **env_overrides}

    if os.name != "nt":
        return jsonify({"started": False, "reason": "process auto-start is only implemented for Windows -- use launch.bat manually"}), 501

    creationflags = subprocess.CREATE_NEW_CONSOLE
    scripts = [
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "ornith-worker.ps1"), "-InstanceId", "worker-1"], "Ornith Worker 1"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "review-runner.ps1")], "Ornith Review Runner"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "apply-runner.ps1")], "Apply Runner"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "queue-watchdog.ps1")], "Queue Watchdog"),
    ]
    for args, _label in scripts:
        subprocess.Popen(args, env=child_env, creationflags=creationflags, cwd=str(PACKAGE_ROOT))

    return jsonify({"started": True, "repoRoot": raw_path})


@app.route("/api/pipeline/stop", methods=["POST"])
def api_pipeline_stop():
    """Kills whatever the current instances/*.json heartbeats say is running, by PID --
    same trust model queue-watchdog.ps1's own dead-process check already uses. Does NOT
    touch anything if nothing looks like it's running, so this is safe to call even when
    unsure."""
    inst_dir = instances_dir()
    if not inst_dir or not inst_dir.is_dir():
        return jsonify({"stopped": []})

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
    return jsonify({"stopped": stopped})


if __name__ == "__main__":
    port = int(os.environ.get("AGENT_MANAGER_DASHBOARD_PORT", "7420"))
    active = get_active_repo_root()
    print(f"Dashboard reading pipeline dir: {get_pipeline_dir() if active else '(none configured yet -- use the Project tab)'}")
    print(f"Open http://localhost:{port}")
    app.run(host="127.0.0.1", port=port, debug=False)
