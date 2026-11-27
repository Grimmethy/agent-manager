"""Task-side logging for branch verdicts: stamps a recorded verdict onto the owning TASK and hub records.

Split out of branch_verdicts.py. Standalone on purpose: this module never imports branch_verdicts (that would be a
circular import). The few helpers it needs are copied here verbatim.
"""
import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# Same as branch_verdicts.HUMAN_SOURCES (copied to avoid a circular import).
HUMAN_SOURCES = ("chat", "manual")
# The queue dirs a task record can sit in and still be worth logging onto (same list as app.py QUEUE_STATES).
_TASK_DIRS = ("pending", "review", "approved", "blocked", "done", "needs-clarification", "awaiting-confirm", "coordinating", "adhoc")


def _now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# A chat/manual needs-work verdict is the one thing a redraft should be told about, so it is also stamped onto
# the owning TASK's promptContext (which both requeue paths carry over verbatim). Caps keep a long verdict from
# swamping the prompt; src/lib/prompt-blocks.js priorVerdictBlock applies its own total cap on top.
_PRIOR_VERDICT_MAX_REASONS = 8
# 1500 = priorVerdictBlock's own total cap: the actionable part of a reason is usually at its END (the real
# arch-review-ac-50 verdict was 887 chars and named the fix last), so a tighter per-entry cut would drop it.
_PRIOR_VERDICT_REASON_CHARS = 1500


def apply_prior_verdict(rec, branch, verdict, reasons, source, sha=None):
    """Mutates a TASK record's promptContext.priorVerdict from a recorded verdict; returns True if it changed.

    chat/manual/worker + needs-work sets it (latest wins); chat/manual/worker + merge clears it (the redraft was accepted);
    every other combination -- deterministic checks, discard (its reasons are about redundancy, not a defect in
    the change), hold (nothing to redraft: the piece is waiting, not defective) -- leaves it alone. Never called for a hub record. A record whose promptContext is not a dict
    is skipped rather than overwritten."""
    if source not in HUMAN_SOURCES + ("worker",):
        return False
    ctx = rec.get("promptContext")
    if not isinstance(ctx, dict):
        return False
    if verdict == "needs-work":
        ctx["priorVerdict"] = {
            "verdict": verdict,
            "reasons": [str(r)[:_PRIOR_VERDICT_REASON_CHARS] for r in list(reasons or [])[:_PRIOR_VERDICT_MAX_REASONS]],
            "sha": sha,
            "at": _now_iso(),
            "source": source,
            "branch": branch,
        }
        return True
    if verdict == "merge" and "priorVerdict" in ctx:
        del ctx["priorVerdict"]
        return True
    return False


def _task_file(queue_dir, task_id):
    for d in _TASK_DIRS:
        p = Path(queue_dir) / d / f"{task_id}.json"
        if p.is_file():
            return p
    return None


def write_task_log(queue_dir, task_ids, hub_id, branch, verdict, reasons, source, sha=None, failed=None):
    """Append a history event to each owning task and to its hub, shaped like src/task-history.js's
    appendHistoryEvent ({stage, at, detail}). `task_ids` is one id or a list (see resolve_owner). Silent
    no-op for an id with no task file. Returns the count of records written.

    Also stamps promptContext.priorVerdict on each owning TASK (never the hub) -- see apply_prior_verdict.

    On OSError or ValueError during write, appends the task_id to `failed` (if provided) and logs a warning."""
    if not queue_dir:
        return 0
    if isinstance(task_ids, str):
        task_ids = [task_ids]
    detail = f"branch verdict: {verdict} ({source}) -- " + "; ".join(reasons)[:400]
    written = 0
    seen = set()
    for tid in [t for t in list(task_ids or []) + [hub_id] if t]:
        if tid in seen:
            continue
        seen.add(tid)
        path = _task_file(queue_dir, tid)
        if not path:
            continue
        try:
            rec = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(rec, dict):
                continue
            history = rec.get("history") if isinstance(rec.get("history"), list) else []
            history.append({"stage": "branch-verdict", "at": _now_iso(), "detail": detail})
            rec["history"] = history
            if tid != hub_id:
                apply_prior_verdict(rec, branch, verdict, reasons, source, sha)
            _atomic_write_json(path, rec)
            written += 1
        except (OSError, ValueError) as exc:
            if failed is not None:
                failed.append(tid)
            logger.warning("Could not log verdict for %s onto task %s: %s", branch, tid, exc)
    return written
