from flask import Blueprint, abort, jsonify, request

import json

# The app.py helpers these views call (_read_plugins_manifest) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

hardware_bp = Blueprint("hardware-bp", __name__)

def _active_hardware_plugin():
    """The plugins.json entry currently active for the "hardware-tab" slot, or None if
    monitoring is off -- shared by /api/hardware/stats and the watch-config routes
    below so all three agree on the exact same lookup."""
    from app import _read_plugins_manifest
    manifest = _read_plugins_manifest()
    return next(
        (p for p in manifest if p.get("slot") == "hardware-tab" and p.get("active")),
        None,
    )


@hardware_bp.route("/api/hardware/stats")
def api_hardware_stats():
    # Hardware is now a swappable plugin slot (2026-09-05) -- this route is a thin
    # same-origin proxy to whichever plugin is currently active for "hardware-tab" in
    # plugins.json, same urllib.request.urlopen(..., timeout=3) + broad except ->
    # degraded-but-200 pattern api_tokenfold_stats() already uses just above, rather
    # than raising or 500ing when no plugin is running.
    import urllib.request

    active = _active_hardware_plugin()
    if active is None:
        return jsonify({"available": False})
    try:
        with urllib.request.urlopen(f"{active['url']}/api/hardware/stats", timeout=3) as r:
            data = json.loads(r.read().decode())
        return jsonify({"available": True, "plugin": active["name"], **data})
    except Exception:
        return jsonify({"available": False, "plugin": active["name"]})


@hardware_bp.route("/api/hardware/watch-config", methods=["GET"])
def api_hardware_watch_config_get():
    # Not every hardware-tab plugin supports this (only the goatmon-backed one, as of
    # this writing) -- a plain {} (not a 404/500) when unsupported or inactive lets the
    # frontend treat "no watch-config" and "nothing to show yet" the same way, same
    # fail-open shape api_hardware_stats() above uses for "no plugin active" at all.
    import urllib.request

    active = _active_hardware_plugin()
    if active is None:
        return jsonify({})
    try:
        with urllib.request.urlopen(f"{active['url']}/api/hardware/watch-config", timeout=3) as r:
            return jsonify(json.loads(r.read().decode()))
    except Exception:
        return jsonify({})


@hardware_bp.route("/api/hardware/watch-config", methods=["POST"])
def api_hardware_watch_config_post():
    import urllib.request

    active = _active_hardware_plugin()
    if active is None:
        abort(404, description="no hardware-tab plugin is currently active")
    body = request.get_json(silent=True) or {}
    req = urllib.request.Request(
        f"{active['url']}/api/hardware/watch-config",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return jsonify(json.loads(r.read().decode()))
    except Exception as exc:
        abort(502, description=f"failed to reach the active hardware plugin: {exc}")
