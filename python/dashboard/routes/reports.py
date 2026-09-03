from pathlib import Path
from datetime import datetime, timezone
import re

from flask import Blueprint, abort, jsonify

from app import _REPORT_PERIODS, second_brain_dir

reports_bp = Blueprint("reports-bp", __name__)


def _reports_root() -> Path | None:
    """Where system-report.js (src/system-report.js) writes its scheduled Markdown
    reports -- SECOND_BRAIN_DIR/Agent Manager Reports/<period>/<filename>.md, same
    'SECOND_BRAIN_DIR is the durable store, dashboard just reads it' shape as the
    benchmark endpoints above."""
    sb = second_brain_dir()
    return (sb / "Agent Manager Reports") if sb else None


def _safe_report_period(period: str) -> str:
    if period not in _REPORT_PERIODS:
        abort(400, description="invalid report period")
    return period


def _safe_report_filename(filename: str) -> str:
    """Reports are only ever named by system-report.js's own reportFilename() (a
    YYYY-MM-DD / YYYY-MM-DDThh style stem plus '.md') -- reject anything else rather than
    trust a client-supplied path segment (path traversal via '../' in the URL)."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.md", filename or ""):
        abort(400, description="invalid report filename")
    return filename


@reports_bp.route("/api/reports")
def api_reports():
    """Every generated report across all three periods, newest first -- the Time Tracking
    tab's list view. Empty (not an error) if SECOND_BRAIN_DIR isn't configured or no
    report has been generated yet, same shape every other SECOND_BRAIN_DIR-gated endpoint
    here uses."""
    root = _reports_root()
    if not root or not root.is_dir():
        return jsonify([])
    reports = []
    for period in _REPORT_PERIODS:
        period_dir = root / period
        if not period_dir.is_dir():
            continue
        for entry in period_dir.iterdir():
            if not entry.is_file() or entry.suffix != ".md":
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            reports.append({
                "period": period,
                "filename": entry.name,
                "generatedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            })
    reports.sort(key=lambda r: r["generatedAt"], reverse=True)
    return jsonify(reports)


@reports_bp.route("/api/reports/<period>/<filename>")
def api_report_detail(period, filename):
    period = _safe_report_period(period)
    filename = _safe_report_filename(filename)
    root = _reports_root()
    if not root:
        abort(404, description="SECOND_BRAIN_DIR is not configured")
    path = root / period / filename
    if not path.is_file():
        abort(404)
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        abort(404)
    return jsonify({"period": period, "filename": filename, "content": content})
