"""Append-only record of WHY an agent/* branch stopped existing on origin.

Same file and line format as src/branch-removal-ledger.js (queue/branch-removals.jsonl, one JSON object per line:
branch, taskId, cause, detail, actor, at) -- read by src/task-disposition.js when task-log-reconcile finds a
branch gone. Why: 20 of 65 branch-producing tasks that never reached master were closed "abandoned: branch gone,
work lost" with no reason, because every in-app path that deletes a branch knew why and threw it away.

Best-effort on purpose: a failed write must never fail the merge/discard/requeue that is the real work.

Optional richer fields (brain-dump #1740, 2026-10-03): a Discard or Merge of a rolling branch used to leave only
"discarded via the dashboard", so nobody could say afterwards WHICH candidates a rejected batch held or WHY it was
rejected (4 of the 5 agent/triage-queue batches discarded since 09-25 were unrecoverable). A row may now also carry
`reason`, `headSha`, `base`, `commitCount`, `commits`, `candidates` (+ `candidatesTotal` / `candidatesOmitted` when a list was
cut), `verdict` and `snapshotRef`, all optional and size-capped; every older row and every older caller keeps working unchanged. snapshot_branch() collects them.
"""
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

CAUSES = {"merged", "discarded", "superseded-by-requeue", "hub-retired", "housekeeping"}
LEDGER_NAME = "branch-removals.jsonl"

MAX_COMMITS = 20
MAX_CANDIDATES = 25
MAX_ROW_CHARS = 12000  # one appended line stays bounded; see _fit_row for what is trimmed first
_HEADING_RE = re.compile(r"^###\s*(AC-\d+)\s*(?:[\u00b7:\u2014-]\s*)?(.+?)\s*$")


def _clip(value, limit):
    return str(value if value is not None else "")[:limit]


def _sanitize_snapshot(snapshot):
    """Only the known snapshot keys, each coerced and capped; anything malformed is skipped, never raised."""
    out = {}
    if not isinstance(snapshot, dict):
        return out
    for key, limit in (("headSha", 64), ("base", 100), ("snapshotRef", 300)):
        if isinstance(snapshot.get(key), str) and snapshot[key]:
            out[key] = snapshot[key][:limit]
    for key in ("commitCount", "candidatesTotal"):  # candidatesTotal: how many headings the branch added BEFORE the list cap
        count = snapshot.get(key)
        if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
            out[key] = count
    commits = snapshot.get("commits")
    if isinstance(commits, list):
        out["commits"] = [
            {"sha": _clip(c.get("sha"), 12), "subject": _clip(c.get("subject"), 120)}
            for c in commits[:MAX_COMMITS] if isinstance(c, dict)
        ]
    candidates = snapshot.get("candidates")
    if isinstance(candidates, list):
        out["candidates"] = [
            {"id": _clip(c.get("id"), 20), "title": _clip(c.get("title"), 140), "files": _clip(c.get("files"), 160)}
            for c in candidates[:MAX_CANDIDATES] if isinstance(c, dict)
        ]
    verdict = snapshot.get("verdict")
    if isinstance(verdict, dict) and verdict.get("verdict"):
        reasons = verdict.get("reasons") if isinstance(verdict.get("reasons"), list) else []
        out["verdict"] = {
            "verdict": _clip(verdict.get("verdict"), 20),
            "reasons": [_clip(r, 200) for r in reasons[:5] if isinstance(r, str)],
            "source": _clip(verdict.get("source"), 20),
            "sha": _clip(verdict.get("sha"), 12),
        }
    return out


def _fit_row(entry):
    """Trim the optional lists until the serialized row fits MAX_ROW_CHARS. The commits go first (the least useful list),
    then candidates are cut from the tail one at a time -- never dropped wholesale, because what a rejected batch HELD is
    the point of the record -- and `candidatesOmitted` says how many were cut."""
    def too_big():
        return len(json.dumps(entry)) > MAX_ROW_CHARS
    for keep in (10, 5, 0):
        if not too_big():
            return entry
        if isinstance(entry.get("commits"), list):
            entry["commits"] = entry["commits"][:keep]
    total = len(entry.get("candidates") or [])
    while too_big() and entry.get("candidates"):
        entry["candidates"] = entry["candidates"][:-1]
    omitted = total - len(entry.get("candidates") or [])
    if omitted > 0:
        entry["candidatesOmitted"] = omitted
    return entry


def record_branch_removal(queue_dir, branch, cause, *, task_id=None, detail="", actor="dashboard", reason=None, snapshot=None):
    """Append one removal entry under `queue_dir`. Returns True when written, False when skipped or failed.

    `reason` and `snapshot` (see snapshot_branch) are optional; without them the row is exactly what it always was."""
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
    if reason:
        entry["reason"] = _clip(reason, 300)
    if snapshot:
        entry.update(_sanitize_snapshot(snapshot))
        _fit_row(entry)
    try:
        path = Path(queue_dir) / LEDGER_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
        return True
    except OSError as exc:
        logger.warning("Could not record removal of branch %r: %s", branch, exc)
        return False


def _git(run_git, args, cwd):
    """(ok, stdout). run_git is app.py's _run_git, which raises RuntimeError on a nonzero exit."""
    try:
        return True, str(run_git(args, cwd))
    except Exception:  # noqa: BLE001 -- a snapshot is best-effort, whatever git or the runner throws
        return False, ""


def parse_added_candidates(diff_text):
    """The `### AC-N <title>` candidates a unified diff ADDS ('+' lines only), each with the first `Files:` line that follows it in the same file.
    Pure. Shared by snapshot_branch (the removal ledger) and count_added_candidates (the Unmerged Branches title)."""
    candidates, current = [], None
    for line in str(diff_text or "").splitlines():
        if line.startswith("+++"):
            current = None  # a new file: a Files: line must not attach across files
            continue
        if not line.startswith("+"):
            continue
        body = line[1:]
        m = _HEADING_RE.match(body)
        if m:
            current = {"id": m.group(1), "title": m.group(2), "files": ""}
            candidates.append(current)
        elif current is not None and not current["files"] and body.startswith("Files:"):
            current["files"] = body[len("Files:"):].strip()
    return candidates


def count_added_candidates(run_git, repo_root, main_branch, head):
    """How many candidates the branch tip `head` adds against origin/<main_branch> (the same range snapshot_branch and the card's `ahead` use).
    One `git diff`; None when git fails. Never raises."""
    try:
        out = str(run_git(["diff", "--unified=0", f"origin/{main_branch}...{head}", "--", "*.md"], repo_root))
        return len(parse_added_candidates(out))
    except Exception:  # noqa: BLE001 -- a title decoration must never break the branch listing
        return None


def snapshot_branch(run_git, repo_root, main_branch, branch, head_sha, queue_dir, keep_ref=False):
    """What a branch holds, for the removal ledger. NEVER raises; returns whatever it managed to collect.

    Range is origin/<main_branch>..<head>, the same one list_unmerged_branches uses for `ahead`, so the numbers match
    the card. `head_sha` None -> `git rev-parse origin/<branch>`. With keep_ref=True the head commit is also pinned under
    refs/discarded/<branch>/<UTC timestamp> (local only, never pushed) so a discarded batch stays recoverable after the
    remote and local branches are gone; only that ref name is returned as snapshotRef.
    """
    snap = {}
    try:
        head = (head_sha or "").strip()
        if not head:
            ok, out = _git(run_git, ["rev-parse", "--verify", "--quiet", f"origin/{branch}"], repo_root)
            head = out.strip() if ok else ""
        if not head:
            return snap
        base = f"origin/{main_branch}"
        snap["headSha"] = head
        snap["base"] = base

        ok, out = _git(run_git, ["rev-list", "--count", f"{base}..{head}"], repo_root)
        if ok and out.strip().isdigit():
            snap["commitCount"] = int(out.strip())

        ok, out = _git(run_git, ["log", "-n", str(MAX_COMMITS), "--format=%H%x1f%s", f"{base}..{head}"], repo_root)
        if ok:
            commits = []
            for line in out.splitlines():
                sha, _, subject = line.partition("\x1f")
                if sha.strip():
                    commits.append({"sha": sha.strip()[:12], "subject": subject.strip()[:120]})
            snap["commits"] = commits

        ok, out = _git(run_git, ["diff", "--unified=0", f"{base}...{head}", "--", "*.md"], repo_root)
        if ok:
            candidates = parse_added_candidates(out)
            snap["candidatesTotal"] = len(candidates)
            snap["candidates"] = candidates[:MAX_CANDIDATES]

        try:
            import branch_verdicts as bv
            v = bv.get_verdict(queue_dir, branch, head) if queue_dir else None
            if v and v.get("verdict") and not v.get("stale"):
                snap["verdict"] = {"verdict": v["verdict"], "reasons": list(v.get("reasons") or [])[:5],
                                   "source": v.get("source"), "sha": head[:12]}
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not read the verdict for %r while snapshotting: %s", branch, exc)

        if keep_ref:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            safe = re.sub(r"[^A-Za-z0-9._/-]", "_", str(branch)).strip("/")
            ref = f"refs/discarded/{safe}/{stamp}"
            ok, _ = _git(run_git, ["update-ref", ref, head], repo_root)
            if ok:
                snap["snapshotRef"] = ref
    except Exception as exc:  # noqa: BLE001 -- never let a snapshot break the discard/merge it describes
        logger.warning("snapshot_branch(%r) failed part-way: %s", branch, exc)
    return snap
