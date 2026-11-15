"""Forge mode in the dashboard (2026-11-12): GET/POST /api/pipeline/forge-mode over src/forge-mode.js.

Forge mode PAUSES the pipeline (marker file, GPU session, optional P40 VM shutdown) for an image run and puts everything back after; the script is src/forge-mode.js
(scripts/forge-mode.sh). This module only runs it: GET answers `status --json`; POST {on: true, vm: 'off'|'keep'} checks the status numbers synchronously (the same limits as the
script's own preflight) and answers 409 with them when they are not met, otherwise starts `on` in the background and answers 202 (it can take minutes with the VM shutdown);
POST {on: false} starts `off` in the background the same way. routes/pipeline_1_more.py registers the route with one line, register(bp): the file's functions are size-ratcheted, so no function is added there.
Standard library plus Flask (imported lazily in view()).
"""
import json
import subprocess
import threading
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "src" / "forge-mode.js"
MIN_AVAIL_MB = 10240   # same limits as src/forge-mode.js (MIN_AVAIL_MB, MAX_IO_SOME10); the script re-checks them itself
MAX_IO_SOME10 = 50
VM_FREES_MB = 4300     # what shutting the P40 VM down gives back (src/forge-mode.js FORGE_MODE_VM_MB default)


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
    reasons = []
    avail = st.get("memAvailMB")
    freed = VM_FREES_MB if vm == "off" and (st.get("vm") or {}).get("state") == "running" else 0
    if avail is None:
        reasons.append("MemAvailable is unreadable")
    elif avail + freed < MIN_AVAIL_MB:
        reasons.append(f"MemAvailable {avail} MB + {freed} MB freed by the plan is under the {MIN_AVAIL_MB} MB needed")
    io = st.get("ioSome10")
    if io is not None and io >= MAX_IO_SOME10:
        reasons.append(f"I/O pressure (some, 10 s) is {io}%, the limit is under {MAX_IO_SOME10}%")
    return reasons


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
