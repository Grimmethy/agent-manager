"""Discard support for a HIDDEN stale agent/* branch (2026-11-21).

The Unmerged Branches scan (app.py _list_unmerged_branches_uncached) hides a branch whose commits
are already on main by ancestry (ahead == 0), or whose changed files are byte-identical on
origin/<main> (_branch_content_state). The discard route only accepts LISTED branches, so such a
stale remote ref could never be removed. find_hidden_stale_branch() answers for exactly that case
and returns a minimal row that branch_discard.discard_branch accepts. Anything else returns None,
and the route then answers its usual 404.

Every outcome is counted in COUNTS (in-process counter), so a hidden-branch discard and each
rejection can be read back.
"""
import subprocess

COUNTS = {}


def _count(outcome):
    COUNTS[outcome] = COUNTS.get(outcome, 0) + 1
    return None


def find_hidden_stale_branch(branch, repo_root):
    from app import _branch_content_state, _detect_main_branch, _run_git

    if not isinstance(branch, str) or not branch.startswith("agent/") or ".." in branch or branch.startswith("/"):
        return _count("rejected-name")
    full_ref = f"refs/remotes/origin/{branch}"
    try:
        head_sha = _run_git(["rev-parse", "--verify", "--quiet", full_ref], repo_root).strip()
    except (RuntimeError, subprocess.SubprocessError, OSError):
        return _count("rejected-no-ref")
    if not head_sha:
        return _count("rejected-no-ref")
    main_branch = _detect_main_branch(repo_root)
    try:
        ahead = int(_run_git(["rev-list", "--count", f"origin/{main_branch}..{full_ref}"], repo_root).strip() or "0")
    except (RuntimeError, ValueError, subprocess.SubprocessError, OSError):
        return _count("rejected-git-error")
    hidden = ahead == 0 or _branch_content_state(repo_root, main_branch, full_ref) is True
    if not hidden:
        return _count("rejected-not-hidden")
    _count("hidden-match")
    return {"branch": branch, "headSha": head_sha, "mainBranch": main_branch, "ahead": ahead,
            "stale": True, "verdict": None, "hiddenStale": True}
