"""GET /api/stats/touchpoints-per-day -- owner touchpoints per day (HUB0361 piece 3).

Read-only. Counts operator-manual requeues per day over the last 14 days from
requeue-attribution.db and lists the actions that cannot be counted yet.
"""
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Blueprint, jsonify

from touchpoints_per_day import touchpoints_per_day

touchpoints_bp = Blueprint("touchpoints-bp", __name__)

WINDOW_DAYS = 14


def _db_path():
    v = os.environ.get("AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH")
    if v:
        return Path(v)
    # Lazy import: app.py imports this module, see routes/concepts.py for why.
    from app import _requeue_attribution_db_path
    return _requeue_attribution_db_path()


def _read_rows(db_path, since_iso):
    """(actor, at) rows since since_iso; [] when the db or table is missing."""
    if not db_path or not Path(db_path).is_file():
        return []
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return conn.execute(
            "SELECT actor, at FROM requeue_causes WHERE at >= ?", (since_iso,)
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()


@touchpoints_bp.route("/api/stats/touchpoints-per-day")
def api_touchpoints_per_day():
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=WINDOW_DAYS)).date().isoformat()
    rows = _read_rows(_db_path(), since)
    return jsonify(touchpoints_per_day(rows, days=WINDOW_DAYS, now=now))
