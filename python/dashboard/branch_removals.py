"""Append-only record of WHY an agent/* branch stopped existing on origin.

Same file and line format as src/branch-removal-ledger.js (queue/branch-removals.jsonl, one JSON object per line:
branch, taskId, cause, detail, actor, at) -- read by src/task-disposition.js when task-log-reconcile finds a
branch gone. Why: 20 of 65 branch-producing tasks that never reached master were closed "abandoned: branch gone,
work lost" with no reason, because every in-app path that deletes a branch knew why and threw it away.

Best-effort on purpose: a failed write must never fail the merge/discard/requeue that is the real work.
"""
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

CAUSES = {"merged", "discarded", "superseded-by-requeue", "hub-retired", "housekeeping"}
LEDGER_NAME = "branch-removals.jsonl"


def record_branch_removal(queue_dir, branch, cause, *, task_id=None, detail="", actor="dashboard"):
    """Append one removal entry under `queue_dir`. Returns True when written, False when skipped or failed."""
    if not queue_dir or not branch or cause not in CAUSES:
        return False
    bare = str(branch)
    for prefix in ("refs/", "remotes/", "origin/"):
        if bare.startswith(prefix):
            bare = bare[len(prefix):]
    entry = {
        "branch": bare,
        "taskId": task_id,
        "cause": cause,
        "detail": str(detail)[:300],
        "actor": actor,
        "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    try:
        path = Path(queue_dir) / LEDGER_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
        return True
    except OSError as exc:
        logger.warning("Could not record removal of branch %r: %s", branch, exc)
        return False
