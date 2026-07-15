#!/usr/bin/env python3
"""Read-only monitoring dashboard for the agent-manager pipeline. No database, no build
step -- reads queue/*.json and instances/*.json directly off disk, the same filesystem
state every other part of this package already uses.

Usage: python dashboard/app.py
Reads AGENT_MANAGER_PIPELINE_DIR (or AGENT_MANAGER_REPO_ROOT as a fallback) for where
queue/ and instances/ live, same as every other script in this package.
AGENT_MANAGER_DASHBOARD_PORT (default 7420) picks the port.
"""

import json
import os
from pathlib import Path

from flask import Flask, jsonify, render_template, abort

app = Flask(__name__)

QUEUE_STATES = ["pending", "review", "approved", "blocked", "done"]

# Same staleness thresholds TaxHarvest's own dashboard route already used: a 'working'
# instance legitimately takes many minutes between heartbeats (a single model call can run
# long), so it gets a generous threshold; anything else stale after 3 minutes means the
# instance stopped progressing.
WORKING_STALE_SECONDS = 1200
OTHER_STALE_SECONDS = 180


def get_pipeline_dir() -> Path:
    pipeline_dir = os.environ.get("AGENT_MANAGER_PIPELINE_DIR") or os.environ.get("AGENT_MANAGER_REPO_ROOT")
    if not pipeline_dir:
        raise SystemExit("AGENT_MANAGER_PIPELINE_DIR or AGENT_MANAGER_REPO_ROOT env var is required.")
    return Path(pipeline_dir)


def queue_dir() -> Path:
    return get_pipeline_dir() / "queue"


def instances_dir() -> Path:
    return get_pipeline_dir() / "instances"


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
    if inst_dir.is_dir():
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
    if state == "drafting":
        entries = []
        drafting_root = queue_dir() / "drafting"
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
    state_dir = queue_dir() / state
    if state_dir.is_dir():
        for f in sorted(state_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            data = read_json_safe(f)
            if data:
                entries.append(task_summary(data, f.stem))
    return jsonify(entries)


@app.route("/api/task/<state>/<task_id>")
def api_task_detail(state, task_id):
    if state == "drafting":
        drafting_root = queue_dir() / "drafting"
        if drafting_root.is_dir():
            for candidate in drafting_root.rglob(f"{task_id}.json"):
                data = read_json_safe(candidate)
                if data:
                    return jsonify(data)
        abort(404)

    if state not in QUEUE_STATES:
        abort(404)
    f = queue_dir() / state / f"{task_id}.json"
    data = read_json_safe(f)
    if not data:
        abort(404)
    return jsonify(data)


@app.route("/api/summary")
def api_summary():
    counts = {}
    for state in QUEUE_STATES:
        state_dir = queue_dir() / state
        counts[state] = len(list(state_dir.glob("*.json"))) if state_dir.is_dir() else 0
    drafting_root = queue_dir() / "drafting"
    drafting_count = 0
    if drafting_root.is_dir():
        drafting_count = len(list(drafting_root.rglob("*.json")))
    counts["drafting"] = drafting_count
    return jsonify(counts)


if __name__ == "__main__":
    port = int(os.environ.get("AGENT_MANAGER_DASHBOARD_PORT", "7420"))
    print(f"Dashboard reading pipeline dir: {get_pipeline_dir()}")
    print(f"Open http://localhost:{port}")
    app.run(host="127.0.0.1", port=port, debug=False)
