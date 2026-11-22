"""Pipeline-start pre-flight: report and snapshot uncommitted tracked changes (never block).

Why (2026-10-14/15): starting or switching the pipeline against a repo whose checkout holds
uncommitted tracked edits is risky -- the apply stage's self-heal rescues/resets dirt in the project
checkout (PR #467, #474), and forge work was lost into a rescue branch once. Nothing warned the operator.

This module only READS git (status, diff, rev-parse, rev-list). It never adds, commits, stashes,
resets or checks anything out, and every public function swallows its own errors and returns a
'skipped' / 'error' shape instead of raising, so it can never stop a pipeline start.

Disable with AGENT_MANAGER_PREFLIGHT=off.
"""
import datetime
import hashlib
import os
import subprocess
from pathlib import Path

GIT_TIMEOUT_S = 15


def enabled() -> bool:
    return os.environ.get("AGENT_MANAGER_PREFLIGHT", "").strip().lower() != "off"


def default_state_dir() -> Path:
    override = os.environ.get("AGENT_MANAGER_PREFLIGHT_DIR")
    if override:
        return Path(override)
    return Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/preflight-snapshots"


def _git(args, cwd):
    """Returns (returncode, stdout). Raises only subprocess/OS errors, which callers catch."""
    r = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=GIT_TIMEOUT_S)
    return r.returncode, r.stdout


def check_repo(path) -> dict:
    """{path, git, dirty, files, branch, ahead} for a git work tree, else {path, skipped, reason}."""
    p = str(path or "")
    try:
        if not p or not Path(p).is_dir():
            return {"path": p, "skipped": True, "reason": "not a directory"}
        rc, out = _git(["rev-parse", "--is-inside-work-tree"], p)
        if rc != 0 or out.strip() != "true":
            return {"path": p, "skipped": True, "reason": "not a git work tree"}
        # --untracked-files=no: only tracked files (modified, staged, deleted). Ignored files never appear.
        rc, out = _git(["status", "--porcelain", "--untracked-files=no"], p)
        if rc != 0:
            return {"path": p, "skipped": True, "reason": "git status failed"}
        files = [line[3:].strip() for line in out.splitlines() if line.strip()]
        rc, branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], p)
        rc2, ahead = _git(["rev-list", "--count", "@{u}..HEAD"], p)
        return {
            "path": p, "git": True, "dirty": bool(files), "files": files,
            "branch": branch.strip() if rc == 0 else None,
            "ahead": int(ahead.strip()) if rc2 == 0 and ahead.strip().isdigit() else None,
        }
    except Exception as exc:  # noqa: BLE001 -- must never raise into a pipeline start
        return {"path": p, "skipped": True, "reason": f"error: {exc}"}


def snapshot_dirty(path, state_dir=None):
    """Write `git diff HEAD` (tracked changes, staged + unstaged) to a dated patch file; return its
    path, or None when there is nothing to write. An identical diff for the same repo is not written
    twice (a Job List toggle restart re-runs the check). Never touches the working tree."""
    try:
        rc, diff = _git(["diff", "HEAD"], path)
        if rc != 0 or not diff.strip():
            return None
        digest = hashlib.sha1(diff.encode("utf-8", "replace")).hexdigest()[:8]
        out_dir = Path(state_dir) if state_dir else default_state_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        base = Path(path).resolve().name or "repo"
        existing = sorted(out_dir.glob(f"{base}-*-{digest}.patch"))
        if existing:
            return str(existing[-1])
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = out_dir / f"{base}-{stamp}-{digest}.patch"
        target.write_text(diff, encoding="utf-8")
        return str(target)
    except Exception:  # noqa: BLE001
        return None


def run(paths, state_dir=None) -> dict:
    """Check every distinct path (the repo being entered first, then the one being left), snapshot the
    dirty ones. {enabled, dirty, files, snapshot, repos:[...]}; never raises."""
    if not enabled():
        return {"enabled": False}
    try:
        seen, repos = set(), []
        for p in paths:
            if not p:
                continue
            key = os.path.normpath(str(p))
            if key in seen:
                continue
            seen.add(key)
            info = check_repo(p)
            if info.get("dirty"):
                info["snapshot"] = snapshot_dirty(p, state_dir)
            repos.append(info)
        dirty_repos = [r for r in repos if r.get("dirty")]
        return {
            "enabled": True,
            "dirty": bool(dirty_repos),
            "files": [f"{r['path']}: {f}" for r in dirty_repos for f in r["files"]],
            "snapshot": next((r["snapshot"] for r in dirty_repos if r.get("snapshot")), None),
            "repos": repos,
        }
    except Exception as exc:  # noqa: BLE001
        return {"enabled": True, "error": str(exc)}
