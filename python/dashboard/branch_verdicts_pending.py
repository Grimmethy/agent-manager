"""Pending verdicts for held hub branches (branches not yet in the listing).

When a user votes on a branch that exists on origin but hasn't been fetched into the
unmerged list yet (listing lags by a minute or two), we store the verdict in a pending
file. When the listing refreshes and the branch appears with a matching head SHA, the
verdict is applied and the pending file removed. If the listed head SHA differs from the
parked head SHA, the pending file is kept (never applied to a different head) and a
`sha_mismatch_kept` event is logged.

This module is standalone (same pattern as branch_verdicts.py): it must not import
from app at top level to avoid circular imports. Everything it needs is passed in.
"""
import json
import logging
import os
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

PENDING_DIR = "pending_verdicts"


def _pending_path(qdir, branch):
    """Return the path for a branch's pending verdict file.

    Sanitizes the branch name by replacing '/' with '_' to avoid path traversal.
    """
    safe_name = branch.replace("/", "_")
    return Path(qdir) / PENDING_DIR / f"{safe_name}.json"


def store_pending_verdict(qdir, branch, head_sha, verdict, reasons, source):
    """Atomically write a pending verdict for a branch.

    Creates {qdir}/pending_verdicts/{branch}.json with the verdict data.
    Uses atomic write (temp file + os.replace) to avoid corruption.
    """
    pending_path = _pending_path(qdir, branch)
    pending_path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "branch": branch,
        "headSha": head_sha,
        "verdict": verdict,
        "reasons": list(reasons),
        "source": source,
    }
    fd, tmp = tempfile.mkstemp(dir=str(pending_path.parent), prefix="pending.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, pending_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get_pending_verdict(qdir, branch):
    """Read and parse a pending verdict file, or None if not found."""
    pending_path = _pending_path(qdir, branch)
    if not pending_path.exists():
        return None
    try:
        data = json.loads(pending_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        return data
    except (OSError, ValueError):
        return None


def remove_pending_verdict(qdir, branch):
    """Delete a pending verdict file if it exists."""
    pending_path = _pending_path(qdir, branch)
    if pending_path.exists():
        try:
            pending_path.unlink()
            return True
        except OSError:
            return False
    return False


def list_pending_verdicts(qdir):
    """List all pending verdicts as a list of dicts."""
    pending_dir = Path(qdir) / PENDING_DIR
    if not pending_dir.is_dir():
        return []
    result = []
    for json_file in sorted(pending_dir.glob("*.json")):
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                result.append(data)
        except (OSError, ValueError):
            continue
    return result


def apply_pending_verdicts(qdir, repo_root, list_unmerged_branches, _run_git, bv):
    """Apply pending verdicts for branches that are now in the listing.

    For each pending verdict:
    - Check if the branch is in the current listing; if it is missing, do one forced
      refresh of the listing (at most once per call) and check again
    - If the branch is still not listed, keep the pending file
    - If the listed headSha is missing, keep the pending file (outcome kept_no_listed_sha)
    - If the listed headSha differs from the parked headSha, keep the pending file and
      log sha_mismatch_kept; the verdict is not applied
    - If the SHAs match, apply the verdict; the pending file is removed only after
      record_verdict succeeds. If it raises, the file is kept (record_failed_kept)
    """
    pending_list = list_pending_verdicts(qdir)
    if not pending_list:
        return

    branches = list_unmerged_branches(force=False) or []
    refreshed = False

    for pending in pending_list:
        branch = pending.get("branch")
        parked_sha = pending.get("headSha")
        if not branch or not parked_sha:
            # Malformed pending file: nothing can be applied from it
            if branch:
                remove_pending_verdict(qdir, branch)
            continue

        match = next((b for b in branches if b.get("branch") == branch), None)
        if match is None and not refreshed:
            refreshed = True
            branches = list_unmerged_branches(force=True) or []
            match = next((b for b in branches if b.get("branch") == branch), None)
        if match is None:
            # Branch still not listed, keep pending
            continue

        listed_sha = match.get("headSha")
        if not listed_sha:
            logger.info(
                f"Pending verdict for {branch} kept: parked_sha={parked_sha} "
                f"listed_sha=None outcome=kept_no_listed_sha"
            )
            continue

        if listed_sha != parked_sha:
            logger.info(
                f"Pending verdict for {branch} kept: parked_sha={parked_sha} "
                f"listed_sha={listed_sha} outcome=sha_mismatch_kept"
            )
            continue

        try:
            bv.record_verdict(
                qdir, branch, listed_sha,
                pending["verdict"], pending["reasons"], pending["source"]
            )
        except Exception as exc:
            logger.warning(
                f"Pending verdict for {branch} kept: parked_sha={parked_sha} "
                f"listed_sha={listed_sha} outcome=record_failed_kept: {exc}"
            )
            continue

        remove_pending_verdict(qdir, branch)
        logger.info(
            f"Applied pending verdict for {branch}: parked_sha={parked_sha} "
            f"listed_sha={listed_sha} outcome=applied"
        )
