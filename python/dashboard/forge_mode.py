"""Forge mode in the dashboard (2026-11-12): GET/POST /api/pipeline/forge-mode over src/forge-mode.js.

Forge mode PAUSES the pipeline (marker file, GPU session, optional P40 VM shutdown) for an image run and puts everything back after; the script is src/forge-mode.js
(scripts/forge-mode.sh). This module only runs it: GET answers `status --json`; POST {on: true, vm: 'off'|'keep'} refuses (409) only when the status is unreadable or forge mode is already on (no memory or I/O limit: forge mode pauses the rest of the pipeline, so
there is nothing for such a limit to protect), otherwise starts `on` in the background and answers 202 (it can take minutes with the VM shutdown);
POST {on: false} starts `off` in the background the same way. routes/pipeline_1_more.py registers the route with one line, register(bp): the file's functions are size-ratcheted, so no function is added there.
Standard library plus Flask (imported lazily in view()).
"""
import json
import subprocess
import threading
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "src" / "forge-mode.js"


def run_script(args, timeout=60):
    """-> (exit code, stdout). A missing node, a timeout or any OS error is exit 1 with the message as stdout."""
    try:
        r = subprocess.run(["node", str(SCRIPT), *args], capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except (OSError, subprocess.SubprocessError) as e:
        return 1, str(e)


def status():
    """The script's `status --json` as a dict, or {'error': ...} when it did not answer with JSON."""
    code, out = run_script(["status", "--json"])
    try:
        return json.loads(out)
    except ValueError:
        return {"error": (out or "no output").strip()[:300], "exit": code}


def refusal(st, vm):
    """[reasons] why `on` would be refused with these status numbers; empty list = go."""
    if st.get("error"):
        return [f"status unreadable: {st['error']}"]
    if st.get("paused"):
        return ["already in forge mode"]
    return []


def start_background(args):
    threading.Thread(target=run_script, args=(args, 600), daemon=True).start()


def handle(method, body):
    """-> (payload dict, http status) for GET/POST /api/pipeline/forge-mode."""
    if method == "GET":
        st = status()
        return st, 200 if not st.get("error") else 502
    body = body if isinstance(body, dict) else {}
    if not body.get("on"):
        start_background(["off"])
        return {"started": True, "action": "off"}, 202
    vm = body.get("vm", "keep")
    if vm not in ("off", "keep"):
        return {"started": False, "reasons": ["vm must be 'off' or 'keep'"]}, 400
    st = status()
    reasons = refusal(st, vm)
    if reasons:
        return {"started": False, "reasons": reasons, "status": st}, 409
    start_background(["on", "--vm", vm])
    return {"started": True, "action": "on", "vm": vm}, 202


def view():
    from flask import jsonify, request
    payload, code = handle(request.method, request.get_json(silent=True))
    return jsonify(payload), code


def register(bp):
    bp.add_url_rule("/api/pipeline/forge-mode", "api_pipeline_forge_mode", view, methods=["GET", "POST"])
