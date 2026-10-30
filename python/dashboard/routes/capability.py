from flask import Blueprint, jsonify, request

import json
import subprocess

# app.py helpers (SRC_DIR, get_pipeline_dir, logger) are imported lazily inside the view, same circular-import pattern as routes/benchmark.py.

capability_bp = Blueprint("capability-bp", __name__)


@capability_bp.route("/api/capability")
def api_capability():
    """Per-(source, model) task-fit scorecard folded from the attempt ledger (src/capability-ledger.js; design note
    docs/design-notes/capability-routing-and-benchmarking.md). Read-only; the fold itself lives in node so the dashboard and the CLI agree."""
    from app import SRC_DIR, get_pipeline_dir, logger
    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        return jsonify([])
    try:
        days = max(1, min(90, int(request.args.get("days", 14))))
    except ValueError:
        days = 14
    try:
        result = subprocess.run(
            ["node", str(SRC_DIR / "capability-ledger.js"), str(days), "--json"],
            capture_output=True, text=True, timeout=15, env={**__import__("os").environ, "AGENT_MANAGER_PIPELINE_DIR": str(pipeline_dir)},
        )
        if result.returncode != 0:
            logger.warning("capability scorecard exited %d: %s", result.returncode, result.stderr[:300])
            return jsonify([])
        return jsonify(json.loads(result.stdout))
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        logger.warning("capability scorecard failed: %s", exc)
        return jsonify([])
