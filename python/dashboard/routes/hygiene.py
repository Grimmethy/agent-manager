"""Hygiene tab backend: one read-only picture of the hygiene backlog for the ACTIVE project.

Why (2026-09-19, Grimmethy): "don't create new tasks before working through what exists" is a sound throttle
when the pile is visible (brain-dump entries are). Hygiene work is not: scanners keep findings in
queue/*-flags.json, reviews turn them into Docs/*_CANDIDATES.md, fixes become tasks and branches, and the
queue only shows the slice already tasked. src/hygiene-inventory.js joins every stage; this route serves it.

Whatever project the dashboard's project selector points at is what is shown -- the inventory reads
AGENT_MANAGER_REPO_ROOT / PIPELINE_DIR from the same env the pipeline gets.

The size estimate is deliberately rough: open work units x the average total model time per FINISHED task of
that family over the last 30 days (model_calls). It is labelled as an estimate, and a family with fewer than
MIN_SAMPLES finished tasks gets no estimate rather than a made-up one.
"""
import json
import os
import sqlite3
import subprocess
import time

from flask import Blueprint, jsonify, request

# The app.py helpers this view calls (ENV_FILE_PATH, SRC_DIR, get_active_repo_root, get_pipeline_dir, model_stats_db_path,
# read_env_file) are imported lazily inside each function: app.py imports THIS module to register the blueprint, so a
# top-level `from app import ...` is a circular import that only fails when app.py is the entrypoint (how the dashboard
# runs). Same pattern as routes/discovery.py, routes/job_types.py.

hygiene_bp = Blueprint("hygiene-bp", __name__)

CACHE_TTL_SECONDS = 10
NODE_TIMEOUT_SECONDS = 45   # a cold filesystem cache on a big repo took ~14 s; warm runs are ~2 s
MIN_SAMPLES = 3
ESTIMATE_WINDOW_DAYS = 30

# family key -> task-id prefixes (must match src/hygiene-inventory.js FAMILIES)
FAMILY_PREFIXES = {
    "observability": ["observability-"],
    "performance": ["performance-"],
    "function_length": ["function-length-"],
    "unused_export": ["deadcode-"],
    "arch": ["arch-"],
    "change_review": ["change-review-"],
}

_cache = {"key": None, "at": 0.0, "payload": None}


def _avg_seconds_per_task(conn, prefixes):
    """(average total model seconds per task, sample count) over the last ESTIMATE_WINDOW_DAYS, or (None, n)."""
    where = " OR ".join("task_id LIKE ?" for _ in prefixes)
    rows = conn.execute(
        f"SELECT SUM(latency_ms) FROM model_calls WHERE ({where}) AND latency_ms IS NOT NULL "
        f"AND started_at >= datetime('now', ?) GROUP BY task_id",
        [f"{p}%" for p in prefixes] + [f"-{ESTIMATE_WINDOW_DAYS} days"],
    ).fetchall()
    totals = [r[0] for r in rows if r[0]]
    if len(totals) < MIN_SAMPLES:
        return None, len(totals)
    return sum(totals) / len(totals) / 1000.0, len(totals)


def build_estimate(inventory):
    """Rough model-time to clear what is waiting on a WORKER (waiting flags + eligible candidates + tasks in flight).
    Work waiting on a HUMAN (blocked, awaiting merge) and stuck candidates are not counted -- no amount of GPU time clears them."""
    from app import model_stats_db_path
    db = model_stats_db_path()
    if not db or not os.path.exists(str(db)):
        return {"available": False, "reason": "no model-stats database for this project yet"}
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as exc:
        return {"available": False, "reason": f"could not open model-stats database: {exc}"}
    try:
        by_family = {}
        total_seconds = 0.0
        units_without_basis = 0
        for fam in inventory.get("families", []):
            o = fam.get("open") or {}
            units = int(o.get("waitingFlags", 0)) + int(o.get("waitingCandidates", 0)) + int(o.get("inFlight", 0))
            if units == 0:
                continue
            avg, samples = _avg_seconds_per_task(conn, FAMILY_PREFIXES.get(fam["key"], []))
            entry = {"units": units, "avgSecondsPerTask": None if avg is None else round(avg, 1), "samples": samples}
            if avg is None:
                units_without_basis += units
            else:
                entry["seconds"] = round(units * avg)
                total_seconds += units * avg
            by_family[fam["key"]] = entry
        return {
            "available": True,
            "seconds": round(total_seconds),
            "hours": round(total_seconds / 3600.0, 1),
            "byFamily": by_family,
            "unitsWithoutBasis": units_without_basis,
            "windowDays": ESTIMATE_WINDOW_DAYS,
            "note": "rough: open units x average model time per finished task (last %d days); excludes work waiting on a human" % ESTIMATE_WINDOW_DAYS,
        }
    except sqlite3.Error as exc:
        return {"available": False, "reason": f"model-stats query failed: {exc}"}
    finally:
        conn.close()


def run_inventory():
    """-> (inventory dict | None, error string | None). Same env the pipeline loops get (agent-manager.env on top of
    os.environ): the inventory needs AGENT_MANAGER_REPO_ROOT, and AGENT_MANAGER_REGISTER_PATH so the hygiene plugin's
    sources (and their inventory hooks) are registered."""
    from app import ENV_FILE_PATH, SRC_DIR, read_env_file
    child_env = {**os.environ, **read_env_file(ENV_FILE_PATH)}
    try:
        result = subprocess.run(
            ["node", str(SRC_DIR / "hygiene-inventory.js")],
            capture_output=True, text=True, timeout=NODE_TIMEOUT_SECONDS, cwd=str(SRC_DIR), env=child_env,
        )
    except subprocess.TimeoutExpired:
        return None, f"hygiene-inventory.js timed out after {NODE_TIMEOUT_SECONDS}s"
    if result.returncode != 0:
        return None, (result.stderr or result.stdout or "hygiene-inventory.js exited non-zero").strip()[:500]
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None, "hygiene-inventory.js returned non-JSON output"
    if isinstance(data, dict) and data.get("error"):
        return None, str(data["error"])[:500]
    return data, None


@hygiene_bp.route("/api/hygiene/inventory")
def api_hygiene_inventory():
    """The whole Hygiene tab in one call. `?refresh=1` bypasses the short cache."""
    from app import get_active_repo_root, get_pipeline_dir
    key = (str(get_active_repo_root()), str(get_pipeline_dir()))
    now = time.time()
    if not request.args.get("refresh") and _cache["key"] == key and now - _cache["at"] < CACHE_TTL_SECONDS and _cache["payload"] is not None:
        return jsonify(_cache["payload"])

    inventory, error = run_inventory()
    if inventory is None:
        # Never cache a failure; report it so the tab can say why instead of showing zeros.
        return jsonify({"available": False, "reason": error})
    payload = {"available": True, **inventory, "estimate": build_estimate(inventory)}
    _cache.update({"key": key, "at": now, "payload": payload})
    return jsonify(payload)
