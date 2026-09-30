"""Verdicts for the Unmerged Branches tab: what was decided about a branch, and for which commit.

Why this exists: in the 2026-09-25 review, of 37 unmerged branches 4 were already on master under a
different SHA, 30+ were redundant agent/triage-queue-rescued-* snapshots, and only ~7 needed a real
decision -- and none of that was visible in the app. A verdict (merge / needs-work / discard) is recorded
per branch AND head SHA, so a verdict for an older commit reads back as stale instead of vouching for code
nobody looked at.

Standalone on purpose (same shape as branch_removals.py): app.py imports the route modules, so this file
must not `from app import ...` at top level. Everything it needs from app.py (the queue dir, a git runner,
the main-branch name) is passed in as a parameter.

A deterministic check NEVER produces "merge": green needs a real review (chat or manual).
"""
import json
import logging
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

VERDICTS = ("merge", "needs-work", "discard")
SOURCES = ("deterministic", "chat", "manual")
STORE_NAME = "branch-verdicts.json"
ROLLING_BRANCH = "agent/triage-queue"
STALE_NOTE = "verdict is for an older commit"
# Per branch, keep the newest few SHAs so the store cannot grow without bound.
_KEEP_SHAS = 5
# The queue dirs a task record can sit in and still be worth logging onto (same list as app.py QUEUE_STATES).
_TASK_DIRS = ("pending", "review", "approved", "blocked", "done", "needs-clarification", "awaiting-confirm", "coordinating", "adhoc")
# Same trailer app.py's _TASK_TRAILER_RE reads: apply-task.js stamps "Task: <id> (...)" on every commit it makes.
_TASK_TRAILER_RE = re.compile(r"^Task:\s*(\S+)", re.MULTILINE)
_CONFLICT_RE = re.compile(r"^CONFLICT \([^)]+\):.*\bin (.+)$", re.MULTILINE)


def _now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _store_path(queue_dir):
    return Path(queue_dir) / STORE_NAME


def load_verdicts(queue_dir):
    """{branch: {sha: record}}. A missing or unreadable store is an empty one, never an error."""
    if not queue_dir:
        return {}
    try:
        data = json.loads(_store_path(queue_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


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


def save_verdicts(queue_dir, verdicts):
    _atomic_write_json(_store_path(queue_dir), verdicts)


def validate_verdict_body(verdict, reasons, source):
    """Returns an error string, or None when the body is acceptable."""
    if verdict not in VERDICTS:
        return f"verdict must be one of {', '.join(VERDICTS)}"
    if source not in SOURCES:
        return f"source must be one of {', '.join(SOURCES)}"
    if not isinstance(reasons, list) or not all(isinstance(r, str) for r in reasons):
        return "reasons must be a list of strings"
    return None


def record_verdict(queue_dir, branch, sha, verdict, reasons, source):
    """Persist a verdict for (branch, sha). Returns (record, written).

    A deterministic verdict never replaces a chat/manual one for the same SHA -- returns the existing
    record with written=False. Raises ValueError on a bad body.
    """
    err = validate_verdict_body(verdict, reasons, source)
    if err:
        raise ValueError(err)
    if not sha:
        raise ValueError("sha is required")
    verdicts = load_verdicts(queue_dir)
    per_branch = verdicts.setdefault(branch, {})
    existing = per_branch.get(sha)
    if existing and source == "deterministic" and existing.get("source") != "deterministic":
        return existing, False
    record = {"verdict": verdict, "reasons": list(reasons), "source": source, "verifiedAt": _now_iso()}
    per_branch[sha] = record
    if len(per_branch) > _KEEP_SHAS:
        for old in sorted(per_branch, key=lambda s: per_branch[s].get("verifiedAt", ""))[:-_KEEP_SHAS]:
            del per_branch[old]
    save_verdicts(queue_dir, verdicts)
    return record, True


def clear_verdict(queue_dir, branch, sha):
    """Drop a DETERMINISTIC record whose finding no longer holds. Never removes a chat/manual one."""
    verdicts = load_verdicts(queue_dir)
    rec = (verdicts.get(branch) or {}).get(sha)
    if rec and rec.get("source") == "deterministic":
        del verdicts[branch][sha]
        if not verdicts[branch]:
            del verdicts[branch]
        save_verdicts(queue_dir, verdicts)
        return True
    return False


def get_verdict(queue_dir, branch, head_sha, verdicts=None):
    """The card-facing view: {verdict, reasons, source, verifiedAt, stale}.

    No verdict at all -> verdict None. Only a verdict for an OLDER sha -> verdict None, stale True,
    reasons carries STALE_NOTE (the card shows it as unverified).
    """
    per_branch = (verdicts if verdicts is not None else load_verdicts(queue_dir)).get(branch) or {}
    rec = per_branch.get(head_sha)
    if rec:
        return {"verdict": rec.get("verdict"), "reasons": rec.get("reasons") or [], "source": rec.get("source"),
                "verifiedAt": rec.get("verifiedAt"), "stale": False}
    if per_branch:
        newest = max(per_branch.values(), key=lambda r: r.get("verifiedAt", ""))
        return {"verdict": None, "reasons": [STALE_NOTE], "source": newest.get("source"),
                "verifiedAt": newest.get("verifiedAt"), "stale": True}
    return {"verdict": None, "reasons": [], "source": None, "verifiedAt": None, "stale": False}


def _git_out(run_git, args, cwd):
    """(ok, stdout). run_git is app.py's _run_git, which raises RuntimeError on a nonzero exit."""
    try:
        return True, run_git(args, cwd)
    except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)


def _check_already_on_main(run_git, repo_root, main_branch, branch):
    ok, out = _git_out(run_git, ["cherry", f"origin/{main_branch}", f"origin/{branch}"], repo_root)
    lines = [ln for ln in out.splitlines() if ln.strip()] if ok else []
    if not lines or not all(ln.startswith("-") for ln in lines):
        return None
    reasons = ["already on master (patch-id match)"]
    # Cheap sanity check: reverse-applying the branch's own diff to origin/main's tree should succeed if
    # main really contains the change. Done in a throwaway detached worktree, removed straight after.
    ok, diff = _git_out(run_git, ["diff", f"origin/{main_branch}...origin/{branch}"], repo_root)
    if ok and diff.strip():
        ok_rev, detail = _reverse_applies(run_git, repo_root, main_branch, diff)
        if not ok_rev:
            reasons.append("hunks did not reverse-apply (master may have moved on): " + detail)
    return ("discard", reasons)


def _reverse_applies(run_git, repo_root, main_branch, diff_text):
    """Reverse-apply the branch's diff in a temporary detached worktree of origin/<main>. (ok, first line of git's complaint)."""
    with tempfile.TemporaryDirectory() as tmp:
        wt = str(Path(tmp) / "wt")
        try:
            run_git(["worktree", "add", "--detach", wt, f"origin/{main_branch}"], repo_root)
        except RuntimeError as exc:
            return False, f"check could not run ({str(exc)[:80]})"
        try:
            proc = subprocess.run(["git", "apply", "--reverse", "--check", "-"], cwd=wt, input=diff_text,
                                  capture_output=True, text=True, timeout=30)
        except (subprocess.SubprocessError, OSError) as exc:
            return False, f"check could not run ({type(exc).__name__})"
        finally:
            try:
                run_git(["worktree", "remove", "--force", wt], repo_root)
            except RuntimeError:
                pass
        if proc.returncode == 0:
            return True, ""
        lines = (proc.stderr or proc.stdout or "").strip().splitlines()
        return False, lines[0][:200] if lines else "unknown"


def _added_lines(run_git, repo_root, base, branch):
    ok, out = _git_out(run_git, ["diff", "--unified=0", f"{base}...{branch}"], repo_root)
    if not ok:
        return None
    return {ln[1:] for ln in out.splitlines() if ln.startswith("+") and not ln.startswith("+++") and ln[1:].strip()}


def _check_redundant_snapshot(run_git, repo_root, main_branch, branch):
    if "-rescued-" not in branch or branch == ROLLING_BRANCH:
        return None
    ok, _ = _git_out(run_git, ["rev-parse", "--verify", "--quiet", f"origin/{ROLLING_BRANCH}"], repo_root)
    if not ok:
        return None
    mine = _added_lines(run_git, repo_root, f"origin/{main_branch}", f"origin/{branch}")
    theirs = _added_lines(run_git, repo_root, f"origin/{main_branch}", f"origin/{ROLLING_BRANCH}")
    if mine is None or theirs is None or not mine <= theirs:
        return None
    return ("discard", [f"snapshot of {ROLLING_BRANCH}, zero unique lines"])


def _check_conflicts(run_git, repo_root, main_branch, branch):
    # `merge-tree --write-tree` exits 1 on conflicts, which _run_git raises on -- the detail carries the output.
    ok, out = _git_out(run_git, ["merge-tree", "--write-tree", "--name-only", f"origin/{main_branch}", f"origin/{branch}"], repo_root)
    if ok:
        return None
    files = sorted(set(_CONFLICT_RE.findall(out)))
    if not files and "CONFLICT" not in out:
        return None  # the check itself failed (not a real conflict) -- never report that as one
    return ("needs-work", ["conflicts with " + main_branch + " on: " + (", ".join(files) if files else "unknown files")])


def run_deterministic_checks(repo_root, main_branch, branch, run_git, extra_reasons=()):
    """(verdict|None, reasons). Never returns "merge". None means nothing decisive found (stays grey).

    Order matters: a branch already on master or a pure snapshot is a discard even if it would also conflict.
    `extra_reasons` are warnings the caller already computed (stale-vs-master, sibling conflicts); they turn a
    quiet branch yellow but never override a discard.
    """
    for check in (_check_already_on_main, _check_redundant_snapshot):
        hit = check(run_git, repo_root, main_branch, branch)
        if hit:
            return hit
    import branch_redundancy  # lazy: standalone sibling module, same convention as app.py's own lazy imports
    dupes = branch_redundancy.check_duplicate_candidates(run_git, repo_root, main_branch, branch)
    if dupes and dupes[0] == "discard":
        return dupes  # every candidate is a recurring duplicate: nothing here is worth keeping
    reasons = list(dupes[1]) if dupes else []
    conflict = _check_conflicts(run_git, repo_root, main_branch, branch)
    if conflict:
        reasons.extend(conflict[1])
    reasons.extend(r for r in extra_reasons if r)
    if reasons:
        return ("needs-work", reasons)
    return (None, [])


def _task_file(queue_dir, task_id):
    for d in _TASK_DIRS:
        p = Path(queue_dir) / d / f"{task_id}.json"
        if p.is_file():
            return p
    return None


def resolve_owner(repo_root, main_branch, branch, run_git, queue_dir=None, hub_lookup=None, fallback_task_id=None):
    """(task_ids, hub_id) for the task(s) and coordinator hub that own this branch.

    The join the branch detail view uses (routes/pipeline_1_more.py api_git_branch_commits): the `Task: <id>`
    trailer on each of the branch's commits names the owning task, and hub_lookup(queue_dir, branch, task_ids)
    (app.py's hub_for_branch, via get_hub_data_provider) names the hub. The branch NAME is not that id for
    hub sub-task branches (agent/decompose-function-length-fix-ac-12 carries task HUB0063-02-...), so it is
    only the last-resort fallback. Best-effort: any failure yields fewer ids, never an exception.
    """
    task_ids = []
    ok, out = _git_out(run_git, ["log", f"origin/{main_branch}..origin/{branch}", "--format=%b"], repo_root)
    if ok:
        for tid in _TASK_TRAILER_RE.findall(out):
            if tid not in task_ids:
                task_ids.append(tid)
    if fallback_task_id and fallback_task_id not in task_ids:
        task_ids.append(fallback_task_id)
    hub_id = None
    if hub_lookup:
        try:
            hub = hub_lookup(Path(queue_dir) if queue_dir else None, branch, task_ids)
            hub_id = (hub or {}).get("id")
        except Exception as exc:  # a hub-provider failure must never block recording a verdict
            logger.warning("Hub lookup failed for %s (non-fatal): %s", branch, exc)
    return task_ids, hub_id


def write_task_log(queue_dir, task_ids, hub_id, branch, verdict, reasons, source):
    """Append a history event to each owning task and to its hub, shaped like src/task-history.js's
    appendHistoryEvent ({stage, at, detail}). `task_ids` is one id or a list (see resolve_owner). Silent
    no-op for an id with no task file. Returns the count of records written."""
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
            _atomic_write_json(path, rec)
            written += 1
        except (OSError, ValueError) as exc:
            logger.warning("Could not log verdict for %s onto task %s: %s", branch, tid, exc)
    return written


def enrich_branches_with_verdicts(queue_dir, repo_root, branches, run_git, hub_lookup=None):
    """Mutates `branches` in place: adds verdict/reasons/source/verifiedAt/stale/headSha to each.

    Runs the deterministic checks only when this head SHA has no verdict yet (a chat/manual one is never
    replaced, and an existing deterministic one is reused, not recomputed on every list build). Best-effort:
    a failure on one branch leaves it grey and never breaks the list.
    """
    if not queue_dir:
        return branches
    verdicts = load_verdicts(queue_dir)
    # Cross-branch pass (needs the whole list): open rivals from different hubs that cannot both merge.
    import branch_redundancy
    try:
        alternatives = branch_redundancy.find_alternatives(branches, repo_root, (branches[0].get("mainBranch") if branches else None) or "master", run_git)
    except Exception as exc:  # noqa: BLE001 -- best-effort; a failure here must never break the branch list
        logger.warning("Alternative-branch check failed (non-fatal): %s", exc)
        alternatives = {}
    for b in branches:
        branch = b["branch"]
        ok, sha = _git_out(run_git, ["rev-parse", f"origin/{branch}"], repo_root)
        sha = sha.strip() if ok else ""
        b["headSha"] = sha
        try:
            existing = (verdicts.get(branch) or {}).get(sha)
            # A chat/manual verdict for this exact SHA is final. A deterministic one is recomputed each build
            # (master may have moved: a conflict can clear, a branch can become already-on-master) but only
            # rewritten/logged when it actually changed.
            if sha and (existing is None or existing.get("source") == "deterministic"):
                extra = []
                if b.get("hubSiblingConflicts"):
                    extra.append("would conflict with unmerged hub sibling(s): " + ", ".join(b["hubSiblingConflicts"]))
                if isinstance(b.get("behind"), int) and b["behind"] > 50:
                    extra.append(f"stale vs {b.get('mainBranch', 'master')}: {b['behind']} commits behind")
                verdict, reasons = branch_redundancy.merge_results(
                    run_deterministic_checks(repo_root, b.get("mainBranch") or "master", branch, run_git, extra), alternatives.get(branch))
                if verdict:
                    unchanged = existing and existing.get("verdict") == verdict and existing.get("reasons") == reasons
                    if not unchanged:
                        record, written = record_verdict(queue_dir, branch, sha, verdict, reasons, "deterministic")
                        if written:
                            task_ids, hub_id = resolve_owner(repo_root, b.get("mainBranch") or "master", branch, run_git,
                                                             queue_dir, hub_lookup, b.get("taskId"))
                            write_task_log(queue_dir, task_ids, hub_id or (b.get("hub") or {}).get("id"), branch, verdict, reasons, "deterministic")
                        verdicts = load_verdicts(queue_dir)
                elif existing is not None:
                    clear_verdict(queue_dir, branch, sha)
                    verdicts = load_verdicts(queue_dir)
        except (ValueError, OSError, RuntimeError) as exc:
            logger.warning("Deterministic verdict check failed for %s (non-fatal): %s", branch, exc)
        b.update(get_verdict(queue_dir, branch, sha, verdicts))
    return branches
