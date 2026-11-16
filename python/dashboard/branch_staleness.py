"""Pure branch-staleness classifier.

No I/O and no app-module imports: callers pass rows and lookup callables in.
The needs-work verdict string and the human source values mirror
python/dashboard/branch_verdicts.py (VERDICTS and HUMAN_SOURCES).
"""
from typing import Any, Callable, Dict, List, Optional

ENV_VAR = "AGENT_MANAGER_STALE_BRANCH_BEHIND"
DEFAULT_THRESHOLD = 100
NEEDS_WORK = "needs-work"
HUMAN_SOURCES = ("chat", "manual")


def stale_threshold(env) -> int:
    """Read the behind-count threshold from env; default 100 on absent, non-integer or <=0."""
    raw = env.get(ENV_VAR) if env is not None else None
    if raw is None:
        return DEFAULT_THRESHOLD
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return DEFAULT_THRESHOLD
    return value if value > 0 else DEFAULT_THRESHOLD


def classify_row(row, threshold) -> Optional[str]:
    """Return the first exclusion reason for a row, or None if it is a candidate."""
    if row.get("ahead") == 1:
        return "ahead"
    if row.get("hub") is None:
        return "hub"
    behind = row.get("behind")
    if behind is None:
        return "behind-unknown"
    if behind < threshold:
        return "not-far-behind"
    if row.get("verdict") == NEEDS_WORK:
        return "verdict"
    if row.get("source") in HUMAN_SOURCES:
        return "human-source"
    return None


def _lookup(fn: Optional[Callable[[Any], Any]], key, state: Dict[str, int]):
    """Call one lookup; on exception return None and count it in state['errors']."""
    if fn is None or key is None:
        return None
    try:
        return fn(key)
    except Exception:
        state["errors"] += 1
        return None


def stale_candidates(rows, threshold, find_by_id, find_by_sha) -> Dict[str, Any]:
    """Classify rows into stale candidates and exclusions.

    refile (assumed default, not in the contract): find_by_id(taskId), falling
    back to find_by_sha(headSha) when that returns None. Only candidate rows
    are looked up. Lookup exceptions yield None and bump lookupErrors.
    """
    candidates: List[Dict[str, Any]] = []
    excluded: Dict[str, int] = {}
    excludedOwner: List[Dict[str, Any]] = []
    state = {"errors": 0}

    for row in rows:
        project = (row.get("project") or {}).get("label")
        branch = row.get("branch")
        reason = classify_row(row, threshold)
        if reason is not None:
            excluded[reason] = excluded.get(reason, 0) + 1
            if reason == "human-source":
                excludedOwner.append({"project": project, "branch": branch, "source": row.get("source")})
            continue

        task_id = row.get("taskId")
        head_sha = row.get("headSha")
        refile = _lookup(find_by_id, task_id, state)
        if refile is None:
            refile = _lookup(find_by_sha, head_sha, state)

        candidates.append({
            "project": project,
            "branch": branch,
            "headSha": head_sha,
            "behind": row.get("behind"),
            "taskId": task_id,
            "subject": row.get("subject"),
            "refile": refile,
        })

    return {
        "candidates": candidates,
        "excluded": excluded,
        "excludedOwner": excludedOwner,
        "threshold": threshold,
        "lookupErrors": state["errors"],
    }
