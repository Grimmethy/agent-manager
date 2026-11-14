import time
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

import memory_pressure_fold as fold_mod
import memory_pressure_trail as trail

# app.py helpers are not needed: this view only reads the broker's journal file (memory_pressure_trail.journal_path) and never writes.

triggers_bp = Blueprint("triggers-bp", __name__)

EPISODE_LIMIT = 200


@triggers_bp.route("/api/triggers/memory-pressure")
def api_memory_pressure():
    """The data trail of host memory pressure: the broker's journal folded into episodes (newest first), the processes that were biggest when pressure hit, and a daily
    view. Read-only; a missing or unreadable journal answers 200 with an empty trail."""
    try:
        days = max(1, min(90, int(request.args.get("days", 14))))
    except ValueError:
        days = 14
    path = trail.journal_path()
    entries, truncated = trail.read_entries(path, since_ts=time.time() - days * 86400)
    folded = fold_mod.fold(entries)
    return jsonify({"generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "days": days,
                    "source": {"path": path, "exists": bool(entries) or _exists(path), "truncated": truncated},
                    "episodes": folded["episodes"][::-1][:EPISODE_LIMIT], "summary": folded["summary"]})


def _exists(path):
    import os
    return os.path.isfile(path)
