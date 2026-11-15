"""GET /api/nodes: the node registry (src/node-registry.js) as the dashboard shows it: one entry per registered machine with its details, last heartbeat and a
computed status (up, paused, off or stale). Read-only; the heartbeat itself is NOT a dashboard route (src/node-registry-server.js receives it, so a node never needs
the dashboard's LAN secret). The registry rule lives once, in node, which this route shells out to (this blueprint is nested under instances_bp, so app.py needs no
change). See docs/agents/nodes.md."""
import json
import os
import subprocess
from pathlib import Path

from flask import Blueprint, abort, jsonify

nodes_bp = Blueprint("nodes-bp", __name__)

REGISTRY_JS = Path(__file__).resolve().parents[3] / "src" / "node-registry.js"
TIMEOUT_S = 10


@nodes_bp.route("/api/nodes")
def api_nodes():
    try:
        r = subprocess.run(["node", str(REGISTRY_JS), "list"], capture_output=True, text=True, timeout=TIMEOUT_S, env=os.environ.copy())
    except (OSError, subprocess.SubprocessError) as exc:
        abort(500, description=f"could not run the node registry: {exc}")
    if r.returncode != 0:
        abort(500, description=(r.stderr or "the node registry failed").strip()[:200])
    try:
        nodes = json.loads(r.stdout)
    except ValueError:
        abort(500, description="the node registry answered with something that is not JSON")
    return jsonify(nodes)
