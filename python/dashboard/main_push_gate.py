"""The edge of the Python main-push gate (HUB0364): every dashboard route that can write to main is checked before its own code runs.

The rules (what counts as a READY record, the ledger, the bypass) are in main_push_rules.py and mirror src/lib/main-push-policy.js. This module finds the
exact head sha of the branch a merge request names and applies them; routes/branch_verdicts.py attaches it as a before_app_request hook.
"""
import logging
import os
import re
import subprocess
from pathlib import Path

from main_push_rules import LEDGER_FILE, MainPushNotReady, assert_main_push_ready, not_ready_reason  # noqa: F401 -- re-exported for callers and tests

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------------------------------------------------------------------------
# The edge of the dashboard: every route that can write to main is checked BEFORE its own code runs (routes/branch_verdicts.py registers this as a
# before_app_request hook). The routes are the regular merge (POST /api/git/branches/<branch>/merge) and the held-hub early merge (POST
# /api/git/held-hub-branches/<branch>/merge-early). `force` does not skip it; only the environment variable does.
# Residual window: the head sha is read from a fetch made here, and the route fetches again when its own list is older than a few seconds; a branch
# pushed in between would be merged at its new head. The verdicts are keyed by sha, so a reviewer-recorded head is what this checks.
# ---------------------------------------------------------------------------------------------------------------------------------------------
_MERGE_PATH = re.compile(r"^/api/git/(?:branches/(?P<regular>.+)/merge|held-hub-branches/(?P<early>.+)/merge-early)$")


def guard_merge_request(request):
    """None to let the request through, or a (json response, status) pair to refuse it. Fails closed on an unexpected error."""
    if request.method != "POST":
        return None
    found = _MERGE_PATH.match(request.path)
    if not found:
        return None
    from flask import jsonify
    branch = found.group("regular") or found.group("early")
    if os.environ.get("AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH") == "true":
        logger.warning("AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true: letting %s through without a READY record", request.path)
        return None  # the bypass needs no git work at all
    try:
        from app import _run_git, get_active_repo_root, queue_dir
        import branch_projects
        active = get_active_repo_root()
        if not active:
            return None  # the route answers 404 itself
        body = request.get_json(silent=True) or {}
        scope = branch_projects.resolve_scope(request.args.get("project") or body.get("project"), str(active))
        repo_root, qdir = (scope["repoPath"], scope["qdir"]) if scope else (Path(active), queue_dir())
        try:
            _run_git(["fetch", "origin", branch], repo_root, timeout=60)
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            pass  # a failed fetch is not a reason to refuse; the last known origin ref is still checked below
        try:
            head_sha = _run_git(["rev-parse", f"origin/{branch}"], repo_root).strip()
        except (RuntimeError, OSError):
            return None  # no such branch (or no such repository): the route answers for itself
        assert_main_push_ready(qdir, branch, head_sha, caller="dashboard-merge-early" if found.group("early") else "dashboard-merge", task_id=branch.removeprefix("agent/"))
        return None
    except LookupError:
        return None  # an unknown project: the route answers 404 itself
    except MainPushNotReady as exc:
        return jsonify({"succeeded": False, "reason": str(exc), "code": MainPushNotReady.code}), 409
    except Exception as exc:  # noqa: BLE001 -- a gate that cannot run must not wave a main write through
        logger.exception("main-push gate could not check %s", request.path)
        return jsonify({"succeeded": False, "reason": f"main write refused: the main-push gate could not run ({exc})"}), 500


def attach(blueprint):
    """Register the gate as a before-request hook for the whole app through an existing blueprint (routes/branch_verdicts.py); returns the blueprint."""
    from flask import request
    blueprint.before_app_request(lambda: guard_merge_request(request))
    return blueprint
