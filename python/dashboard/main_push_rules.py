"""The rules of the Python main-push gate (HUB0364): a write to the main branch is allowed only when the exact commit has a READY record.

Mirrors `assertMainPushReady` in src/lib/main-push-policy.js rule for rule and message for message (test_main_push_gate.py runs both on the same fixtures). The merge-route hook that applies these rules lives in main_push_gate.py.
READY record = a `merge` verdict from a human source (chat or manual) for exactly this (branch, head sha) in <queue dir>/branch-verdicts.json
(branch_verdicts.py). Every refusal appends one JSON line to <queue dir>/main-push-ledger.jsonl and raises MainPushNotReady, a PermissionError, so the
merge routes answer 409. The only bypass is AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true (a warning, no ledger row). Optional:
AGENT_MANAGER_MAIN_PUSH_READY_MAX_AGE_HOURS (a positive number) also refuses a record older than that; unset means no age limit.
"""
import json
import logging
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import branch_verdicts
import main_push_safe_class

logger = logging.getLogger(__name__)

LEDGER_FILE = "main-push-ledger.jsonl"


class MainPushNotReady(PermissionError):
    """A main write was refused: no READY record for the exact head sha."""

    code = "MAIN_PUSH_NOT_READY"


def _parse_time(text):
    """Seconds since the epoch for an ISO-8601 time (a trailing Z and any fraction accepted), or None."""
    if not isinstance(text, str):
        return None
    t = re.sub(r"(\.\d{6})\d+", r"\1", text.strip())
    t = t[:-1] + "+00:00" if t.endswith("Z") else t
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def not_ready_reason(store, branch, head_sha, now, diff_facts_loader=None):
    """Why this (branch, head sha) is not READY, or None when it is. `now` is a datetime. `diff_facts_loader` (optional, called only for the checker worker's own merge) returns the diff facts of main_push_safe_class.read_diff_facts: with it, a worker merge for a safe diff class is READY."""
    record = ((store or {}).get(branch) or {}).get(head_sha)
    if not isinstance(record, dict):
        return f"no verdict recorded for {branch} at {head_sha}"
    if record.get("verdict") != "merge":
        return f"the verdict for {branch} at {head_sha} is '{record.get('verdict')}', not 'merge'"
    if record.get("source") not in branch_verdicts.HUMAN_SOURCES:
        not_human = f"the merge verdict for {branch} at {head_sha} comes from '{record.get('source')}', not a human source (chat or manual)"
        if not main_push_safe_class.worker_class_applies(record, diff_facts_loader):
            return not_human
        unsafe, _facts = main_push_safe_class.unsafe_reason(diff_facts_loader)
        if unsafe:
            return f"{not_human}; {unsafe}"
    at = _parse_time(record.get("verifiedAt"))
    if at is None:
        return f"the merge verdict for {branch} at {head_sha} has no valid verifiedAt timestamp"
    try:
        max_hours = float(os.environ.get("AGENT_MANAGER_MAIN_PUSH_READY_MAX_AGE_HOURS", ""))
    except ValueError:
        max_hours = 0
    if max_hours > 0 and now.timestamp() - at > max_hours * 3600:
        return f"the merge verdict for {branch} at {head_sha} is older than {max_hours:g} hour(s)"
    return None


def _append_ledger(queue_dir, entry):
    try:
        path = Path(queue_dir) / LEDGER_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except OSError as exc:
        logger.warning("could not write the main-push ledger row for %s: %s", entry.get("branch"), exc)


def assert_main_push_ready(queue_dir, branch, head_sha, caller=None, task_id=None, now=None, diff_facts_loader=None):
    """Raise MainPushNotReady unless `branch` at exactly `head_sha` has a READY record in `queue_dir`'s verdict store. Returns {"allowed": True, "bypass": bool}, plus "viaClass" when a checker worker's merge passed on a safe diff class (one `allowed-worker-class` ledger row is written)."""
    if os.environ.get("AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH") == "true":
        logger.warning("AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true: allowing a main write for %s@%s without a READY record (caller: %s)", branch, head_sha, caller or "unknown")
        return {"allowed": True, "bypass": True}
    now = now or datetime.now(timezone.utc)
    seen = []  # the diff facts, when the loader was used: a pass with them is a worker merge cleared by its safe diff class

    def loader():
        seen.append(diff_facts_loader())
        return seen[-1]

    reason = "branch and headSha are both required" if not branch or not head_sha else not_ready_reason(branch_verdicts.load_verdicts(queue_dir), branch, head_sha, now, loader if diff_facts_loader else None)
    stamp = now.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if reason is None and seen:
        _append_ledger(queue_dir, {"at": stamp, "outcome": "allowed-worker-class", "branch": branch, "headSha": head_sha, "caller": caller, "taskId": task_id, "class": seen[-1]["class"], "files": seen[-1]["files"]})
        return {"allowed": True, "bypass": False, "viaClass": seen[-1]["class"]}
    if reason is None:
        return {"allowed": True, "bypass": False}
    _append_ledger(queue_dir, {"at": stamp, "outcome": "refused", "branch": branch or None, "headSha": head_sha or None, "caller": caller, "taskId": task_id, "reason": reason})
    raise MainPushNotReady(
        f"main write refused: {reason}. A main write needs a READY record (a chat or manual merge verdict) for the exact head sha; "
        "set AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true only to bypass on purpose."
    )
