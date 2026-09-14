from flask import Blueprint, abort, jsonify, request

import os
import re
import json
import subprocess

# The app.py helpers these views call (CLAUDE_EFFORT_CHOICES, CLAUDE_MODEL_CHOICES, ENV_FILE_PATH, PACKAGE_ROOT, _pipeline_running, _restart_pipeline, claude_defaults, is_claude_token_configured, write_dashboard_settings, write_env_value) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

claude_settings_bp = Blueprint("claude-settings-bp", __name__)

@claude_settings_bp.route("/api/settings/claude", methods=["GET"])
def api_get_claude_settings():
    from app import CLAUDE_EFFORT_CHOICES, CLAUDE_MODEL_CHOICES, claude_defaults, is_claude_token_configured
    return jsonify({
        **claude_defaults(),
        "modelChoices": CLAUDE_MODEL_CHOICES,
        "effortChoices": CLAUDE_EFFORT_CHOICES,
        "tokenConfigured": is_claude_token_configured(),
    })


@claude_settings_bp.route("/api/settings/claude-token", methods=["POST"])
def api_set_claude_token():
    """Write-only, deliberately -- CLAUDE_CODE_OAUTH_TOKEN is a real, ~1-year-lived
    credential for the user's own Claude subscription (see claude-client.js's own header
    for the billing-safety reasoning it exists for). This endpoint accepts it and never
    echoes it back in any response; api_get_claude_settings above reports only whether
    one is configured, never its value. Same "loopback-only dashboard, plaintext POST is
    fine" trust boundary as every other write endpoint here (app.run(host="127.0.0.1")).

    Writes to agent-manager.env (same helper /api/pipeline/start already uses for
    AGENT_MANAGER_REPO_ROOT) so it survives every future restart, not just this one --
    then mutates os.environ so THIS dashboard process's own env reflects it immediately
    (same reasoning _start_pipeline's own os.environ mutation comment gives for
    AGENT_MANAGER_REPO_ROOT), and restarts the pipeline if one is currently configured
    so the change takes effect right away instead of silently waiting for some future
    manual restart the user has no reason to think is still needed."""
    from app import ENV_FILE_PATH, _pipeline_running, _restart_pipeline, write_env_value
    body = request.get_json(silent=True) or {}
    raw_token = body.get("token") or ""
    # Strip ALL whitespace, not just leading/trailing -- a real token
    # (sk-ant-oat01-...) never legitimately contains any. Confirmed live 2026-08-16: a
    # token pasted from a terminal that had wrapped it across two lines picked up an
    # extra space or two at the wrap point, producing a value that looked plausible
    # (right length, right prefix) but failed Claude's own auth check with a 401 "OAuth
    # access token is invalid" -- silent and confusing from the user's side, since
    # nothing here validated the shape before saving it. Removing internal whitespace
    # rather than rejecting it: the corruption is common enough (long tokens + wrapped
    # terminals) that silently fixing it is more useful than making the user notice,
    # copy again, and hope it doesn't wrap the same way a second time.
    token = re.sub(r"\s+", "", raw_token)
    if not token:
        abort(400, description="token is required")
    if not token.startswith("sk-ant-oat"):
        abort(400, description="that doesn't look like a Claude Code OAuth token (expected it to start with \"sk-ant-oat\") -- double check what was pasted")
    write_env_value(ENV_FILE_PATH, "CLAUDE_CODE_OAUTH_TOKEN", token)
    os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = token
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True
    return jsonify({"saved": True, "restarted": restarted})


@claude_settings_bp.route("/api/settings/claude-token", methods=["DELETE"])
def api_clear_claude_token():
    """Removes the token from agent-manager.env and this process's own env -- e.g. to
    revoke a compromised token or switch to a different subscription account. Does NOT
    restart the pipeline: an already-running claude-client.js call in flight should be
    allowed to finish rather than be killed mid-call by a credential removal, and the
    next call after this will fail its own auth guard cleanly (see that module's header)
    rather than silently keep using a token that's supposed to be gone."""
    from app import ENV_FILE_PATH, write_env_value
    write_env_value(ENV_FILE_PATH, "CLAUDE_CODE_OAUTH_TOKEN", "")
    os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
    return jsonify({"cleared": True})


@claude_settings_bp.route("/api/settings/claude", methods=["POST"])
def api_set_claude_settings():
    from app import CLAUDE_EFFORT_CHOICES, CLAUDE_MODEL_CHOICES, claude_defaults, write_dashboard_settings
    body = request.get_json(silent=True) or {}
    patch = {}
    model = (body.get("model") or "").strip()
    effort = (body.get("effort") or "").strip()
    if model:
        if model not in CLAUDE_MODEL_CHOICES:
            abort(400, description=f"model must be one of {CLAUDE_MODEL_CHOICES}")
        patch["claudeDefaultModel"] = model
    if effort:
        if effort not in CLAUDE_EFFORT_CHOICES:
            abort(400, description=f"effort must be one of {CLAUDE_EFFORT_CHOICES}")
        patch["claudeDefaultEffort"] = effort
    if patch:
        write_dashboard_settings(patch)
    return jsonify(claude_defaults())


@claude_settings_bp.route("/api/claude-usage", methods=["GET"])
def api_claude_usage():
    """Wraps budget-monitor.js's isBudgetHealthy() -- see that module's own header for
    exactly what signal this is (and isn't): Claude Code itself only ever tells you a
    rate limit was hit, reactively, via an error event in its local session transcripts
    -- there's no live "you've used N% of your 5-hour window" API to poll. What this
    surfaces is real: the last actual rate-limit hit and its reset time (if any), token
    and call counts since the current window's real start (`sinceLastLimit` -- anchored to
    the last reset, not a generic trailing lookback) plus a 7d rolling volume trend, and
    (Brain Dump #89, 2026-08-18) an
    `estimate` object with a used/ceiling percentage and a projected time-to-cap -- see
    budget-monitor.js's own estimateBudgetCeiling()/estimateTimeToCap() for how that's
    derived ENTIRELY from real past rate-limit hits, never an invented number; `estimate`
    is null when no real hit has been observed yet in the lookback window. None of this is
    a precise live quota gauge. Scans ~/.claude/projects, so headless calls this pipeline
    makes via claude-client.js show up in the same rolling counts as any interactive
    `claude` session on this machine, since both write to the same transcript directory."""
    from app import PACKAGE_ROOT
    script_path = PACKAGE_ROOT / "budget-monitor.js"
    try:
        result = subprocess.run(["node", str(script_path)], capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return jsonify({"available": False, "reason": "budget-monitor.js timed out"}), 504
    if result.returncode != 0:
        return jsonify({"available": False, "reason": (result.stderr or "budget-monitor.js exited non-zero").strip()[:500]})
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return jsonify({"available": False, "reason": "budget-monitor.js returned non-JSON output"})
    return jsonify({"available": True, **data})


@claude_settings_bp.route("/api/claude-pause", methods=["POST"])
def api_set_claude_paused():
    from app import write_dashboard_settings
    body = request.get_json(silent=True) or {}
    paused = body.get("paused") is True
    write_dashboard_settings({"claudePaused": paused})
    return jsonify({"claudePaused": paused})
