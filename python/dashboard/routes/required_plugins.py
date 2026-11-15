import json
import subprocess

from flask import Blueprint, jsonify

# app.py helpers (SRC_DIR, logger) are imported lazily inside the view, same circular-import pattern as routes/capability.py.

required_plugins_bp = Blueprint("required-plugins-bp", __name__)

TIMEOUT_SECONDS = 15


@required_plugins_bp.route("/api/required-plugins")
def api_required_plugins():
    """The Kernel's required-plugins check for the dashboard banner (src/required-plugins.js, config/required-plugins.json). Read-only. The CLI prints
    {ok, results} on stdout and exits 0 (all met) or 3 (one unmet): both are normal answers. Anything else (exit 2 = unusable config, a timeout, output that is
    not JSON) answers 200 with ok false and an error text, so the page can say 'the check could not run' and never meets a 5xx."""
    from app import SRC_DIR, logger

    def failed(why):
        logger.warning("required-plugins check could not run: %s", why)
        return jsonify({"ok": False, "error": why, "results": []})

    try:
        out = subprocess.run(["node", str(SRC_DIR / "required-plugins.js"), "--json"], capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return failed(f"{type(exc).__name__}: {exc}"[:200])
    if out.returncode not in (0, 3):
        return failed(f"the check exited {out.returncode}: {(out.stderr or out.stdout).strip()[:200]}")
    try:
        body = json.loads(out.stdout)
    except json.JSONDecodeError:
        return failed("the check printed no JSON")
    if not isinstance(body, dict) or "ok" not in body:
        return failed("the check printed an unexpected shape")
    return jsonify(body)
