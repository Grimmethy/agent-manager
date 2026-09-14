from flask import Blueprint, jsonify

import json
import os

# The app.py helpers these views call (logger) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

embedded_tools_bp = Blueprint("embedded-tools-bp", __name__)

@embedded_tools_bp.route("/api/tokenfold/stats")
def api_tokenfold_stats():
    from app import logger
    # Thin same-origin proxy to the TokenFold proxy's own stats endpoint (launch.sh starts
    # TokenFold on TOKENFOLD_PORT, default 9339) -- the dashboard page can't fetch the
    # 9339 origin directly without CORS. "available": False (never an HTTP error) when the
    # proxy isn't running, so the tab can render a quiet "not running" state instead of
    # tripping the generic error path.
    import urllib.request

    port = os.environ.get("TOKENFOLD_PORT", "9339")
    try:
        with urllib.request.urlopen(
                f"http://localhost:{port}/tokenfold/stats", timeout=3) as r:
            data = json.loads(r.read().decode())
        return jsonify({"available": True, "port": port, "stats": data})
    except Exception as exc:
        logger.warning(
            "TokenFold stats fetch failed (localhost:%s /tokenfold/stats): %s: %s",
            port, type(exc).__name__, exc,
        )
        return jsonify({"available": False, "port": port})


@embedded_tools_bp.route("/api/promptforge/config")
def api_promptforge_config():
    # PromptForge is a separate local app (its own Flask server). The dashboard just
    # tells the browser where to point the embedded iframe -- PROMPTFORGE_URL, else the
    # convention :7430. No proxy: the iframe loads that origin directly.
    return jsonify({"url": os.environ.get("PROMPTFORGE_URL", "http://localhost:7430")})


@embedded_tools_bp.route("/api/adforge/config")
def api_adforge_config():
    # AdForge is a separate local app (its own Flask server), same as PromptForge above.
    # Just tells the browser where to point the embedded iframe -- ADFORGE_URL, else the
    # convention :7431. No proxy.
    return jsonify({"url": os.environ.get("ADFORGE_URL", "http://localhost:7431")})


@embedded_tools_bp.route("/api/scriptforge/config")
def api_scriptforge_config():
    # ScriptForge is a separate local app (phase 1 of the AdForge pipeline), same shape
    # as the two above -- SCRIPTFORGE_URL, else the convention :7432.
    return jsonify({"url": os.environ.get("SCRIPTFORGE_URL", "http://localhost:7432")})
