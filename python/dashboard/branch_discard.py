"""Discarding unmerged branches: the one implementation behind the single Discard button and the Discard-all batch (2026-10-31, owner request).

`discard_branch` is the effect of discarding ONE listed branch -- snapshot under refs/discarded/, delete the remote ref, ledger row, drop the local copy, archive
the owning task, refresh the cached list. The caller holds the apply lock. `api_git_discard_branch` (routes/pipeline_1_more.py) calls it for one branch;
`discard_batch` below calls it per item, so there is no second copy of the delete/snapshot/ledger logic to drift.

`discard_batch` is the gate side of the batch: nothing is deleted unless the verdict the owner SAW still stands (the card's current verdict is discard, at the head
sha the page listed), agent/triage-queue is left out unless asked for, and the apply lock is taken once for the whole batch (busy -> nothing is touched).
"""
import json
from datetime import datetime, timezone
from pathlib import Path

TRIAGE_BRANCH = "agent/triage-queue"
MAX_BATCH = 200


def discard_branch(branch, match, repo_root, scope, reason=None):
    """Discard one listed branch. Caller holds the apply lock. Returns the payload the single route answers with; raises RuntimeError when git fails."""
    from app import _archive_task_file, _delete_local_branch, _invalidate_branch_cache, _run_git, logger, queue_dir, read_json_safe
    import branch_projects
    qdir_for = (lambda: scope["qdir"]) if scope else queue_dir
    repo_root = Path(repo_root)
    local_branch = {"deleted": False, "reason": "not attempted"}

    # Brain-dump #1740: capture WHAT this branch holds (commits, the candidate headings it added, the verdict recorded on its card) and
    # pin its head under refs/discarded/ BEFORE the remote delete below, so a discarded batch is no longer just "discarded via the
    # dashboard" and stays recoverable once both the remote and local branch are gone. Best-effort: nothing in this block may stop the discard.
    snapshot = {}
    reason = str(reason or "").strip()
    try:
        from branch_removals import snapshot_branch
        snapshot = snapshot_branch(_run_git, repo_root, match.get("mainBranch") or "main", branch, match.get("headSha"), qdir_for(), keep_ref=True)
        if not reason:
            default_reasons = (snapshot.get("verdict") or {}).get("reasons") or []
            reason = str(default_reasons[0]) if default_reasons else ""
    except Exception as exc:  # noqa: BLE001
        logger.warning("Non-fatal: could not snapshot %r before discarding it: %s", branch, exc)

    try:
        _run_git(["push", "origin", "--delete", branch], repo_root)
    except RuntimeError as e:
        # A delete failing because the ref is already gone (deleted by hand, or a duplicate click) means the actual goal -- this branch not existing on
        # origin -- is already achieved; only a REAL git failure (auth, network, etc.) should surface as an error.
        if "remote ref does not exist" not in str(e) and "unable to delete" not in str(e).lower():
            raise
    from branch_removals import record_branch_removal
    record_branch_removal(qdir_for(), branch, "discarded", task_id=branch.removeprefix("agent/"),
                          detail="discarded via the dashboard Unmerged Branches tab", actor="dashboard-discard",
                          reason=reason or None, snapshot=snapshot or None)
    # Also drop the LOCAL copy (only reached when the remote delete succeeded or the ref was already gone) -- see _delete_local_branch for why.
    local_branch = _delete_local_branch(repo_root, branch)

    # Archive the matching task record. Best-effort: no task record found is not an error; already-archived is a silent no-op.
    task_archived = False
    qdir = qdir_for()
    if qdir:
        task_id = branch.removeprefix("agent/")
        done_path = qdir / "done" / f"{task_id}.json"
        archived_path = qdir / "done" / "_archived_no_action" / f"{task_id}.json"
        if done_path.is_file():
            data = read_json_safe(done_path)
            if data is not None:
                now_iso = datetime.now(timezone.utc).isoformat()
                if data.get("terminalDisposition") != "dismissed":
                    hist = data.get("history")
                    if not isinstance(hist, list):
                        hist = data["history"] = []
                    hist.append({
                        "stage": "dismissed",
                        "at": now_iso,
                        "detail": f"branch {branch} discarded via the dashboard Unmerged Branches tab -- not merging this",
                    })
                    data["terminalDisposition"] = "dismissed"
                try:
                    done_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
                except OSError as exc:
                    logger.error("Failed to persist dismissed-state for branch %r to %s: %s", branch, done_path, exc)
                    raise
            try:
                _archive_task_file(qdir, done_path)
                task_archived = True
            except FileExistsError:
                pass
        elif archived_path.is_file():
            task_archived = True  # already archived (e.g. by hand) -- nothing more to do

    if scope:
        branch_projects.after_action(scope)
    else:
        _invalidate_branch_cache(drop_branch=branch)
    return {"succeeded": True, "branch": branch, "taskArchived": task_archived, "localBranch": local_branch,
            "snapshotRef": (snapshot or {}).get("snapshotRef")}


def refusal(match, sha, include_triage, branch):
    """Why this listed branch must NOT be discarded in a batch, or None. Pure: the row is the freshly recomputed list row."""
    if branch == TRIAGE_BRANCH and not include_triage:
        return "excluded: agent/triage-queue is the rolling candidate-doc branch (opt in to include it)"
    if not sha:
        return "refused: no head sha was sent, so the verdict the owner saw cannot be confirmed"
    if match.get("headSha") != sha:
        return "refused: the branch head moved since the list was shown (re-verify it)"
    if match.get("stale") or match.get("verdict") != "discard":
        return "refused: the branch's current verdict is not discard at this commit"
    return None


def discard_batch(items, include_triage=False):
    """Discard every item that still carries a current discard verdict. Returns (http_status, payload).

    items: [{"branch", "project", "sha"}]. 409 for the whole batch (nothing touched) when the apply lock is busy. Items are handled one at a time; one failure
    does not stop the rest. Per-item results: {branch, project, succeeded, reason?, ...}."""
    from app import _acquire_apply_lock, _release_apply_lock, get_active_repo_root, list_unmerged_branches, logger
    import branch_projects
    active = get_active_repo_root()
    if not active:
        return 404, {"succeeded": False, "reason": "no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable"}
    if not isinstance(items, list) or not items:
        return 400, {"succeeded": False, "reason": "branches must be a non-empty list"}
    if len(items) > MAX_BATCH:
        return 400, {"succeeded": False, "reason": f"at most {MAX_BATCH} branches per batch"}
    clean = []
    for it in items:
        if not isinstance(it, dict) or not isinstance(it.get("branch"), str) or not it["branch"].startswith("agent/"):
            return 400, {"succeeded": False, "reason": "every item needs a branch name starting with agent/"}
        clean.append({"branch": it["branch"], "project": str(it.get("project") or ""), "sha": str(it.get("sha") or "")})

    try:
        lock_fd = _acquire_apply_lock()
    except RuntimeError:
        return 409, {"succeeded": False, "reason": "the pipeline is mid-apply right now -- nothing was discarded, try again in a few seconds"}

    results = []
    lists = {}  # project root -> (scope, repo_root, rows): each project's list is recomputed once, under the lock
    try:
        for it in clean:
            res = {"branch": it["branch"], "project": it["project"], "succeeded": False}
            results.append(res)
            try:
                key = it["project"]
                if key not in lists:
                    scope = branch_projects.resolve_scope(key or None, str(active))
                    if scope:
                        lists[key] = (scope, scope["repoPath"], branch_projects.refresh_branches(scope))
                    else:
                        lists[key] = (None, Path(active), list_unmerged_branches(force=True))
                scope, repo_root, rows = lists[key]
            except LookupError as e:
                res["reason"] = str(e)
                continue
            except Exception as e:  # noqa: BLE001 -- a project whose list cannot be built is refused, not allowed to stop the batch
                res["reason"] = f"could not list that project's branches: {e}"
                continue
            match = next((b for b in rows if b["branch"] == it["branch"]), None)
            if not match:
                res["reason"] = "refused: not a currently-listed, pushed-but-unmerged agent/* branch"
                continue
            why = refusal(match, it["sha"], include_triage, it["branch"])
            if why:
                res["reason"] = why
                continue
            try:
                out = discard_branch(it["branch"], match, repo_root, scope)
                res.update({"succeeded": True, "taskArchived": out["taskArchived"], "snapshotRef": out["snapshotRef"]})
            except Exception as e:  # noqa: BLE001
                logger.warning("Batch discard of %r failed (the rest continue): %s", it["branch"], e)
                res["reason"] = str(e)
    finally:
        _release_apply_lock(lock_fd)
    done = sum(1 for r in results if r["succeeded"])
    return 200, {"succeeded": done == len(results), "discarded": done, "failed": len(results) - done, "results": results}
