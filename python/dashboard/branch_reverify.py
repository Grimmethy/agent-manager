"""'Needs re-verify' for the Unmerged Branches tab (owner 2026-11-18). A 'merge' verdict that cannot be trusted NOW (conflicts, far behind, unfinished hub piece) leaves the
Ready to merge bucket; a newly conflicting one is demoted to a deterministic needs-work so the Needs-Work worker re-queues it; duplicates and the verdict age are annotated.
Doc: docs/agents/branch-verdicts.md. Called from branch_verdicts.enrich_branches_with_verdicts. Pure helpers over the branch dicts the list build already has.

Layout note: scripts/size-ratchet-check.js measures a top-level python def to the end of the FILE and a method to the end of its CLASS, so helpers live in small classes
and the two top-level entry points come last.
"""
import os
from datetime import datetime, timezone

MAX_BEHIND_ENV = "AGENT_MANAGER_VERDICT_REVERIFY_MAX_BEHIND"
MAX_AGE_HOURS_ENV = "AGENT_MANAGER_VERDICT_REVERIFY_MAX_AGE_HOURS"
DEMOTE_ENV = "AGENT_MANAGER_VERDICT_DEMOTE_ON_CONFLICT"
DEFAULT_MAX_BEHIND = 100
DEFAULT_MAX_AGE_HOURS = 24.0
HUB_FINISHED_STATES = ("done", "retired")


class Limits:
    @staticmethod
    def positive(raw, default):
        try:
            value = float(str(raw).strip())
        except (TypeError, ValueError):
            return default
        return value if value > 0 and value != float("inf") else default

    @staticmethod
    def reverify(env=None):
        """(max_behind commits, max_age_hours); a missing or non-positive value gives the default."""
        env = os.environ if env is None else env
        return int(Limits.positive(env.get(MAX_BEHIND_ENV), DEFAULT_MAX_BEHIND)), Limits.positive(env.get(MAX_AGE_HOURS_ENV), DEFAULT_MAX_AGE_HOURS)

    @staticmethod
    def demote_enabled(env=None):
        env = os.environ if env is None else env
        return str(env.get(DEMOTE_ENV, "")).strip().lower() not in ("0", "false", "off", "no")


class Age:
    @staticmethod
    def hours(verified_at, now=None):
        """Hours since `verified_at` (ISO), None when missing or unreadable, never negative."""
        if not isinstance(verified_at, str) or not verified_at:
            return None
        try:
            when = datetime.fromisoformat(verified_at.replace("Z", "+00:00"))
        except ValueError:
            return None
        when = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
        return max(0.0, ((now or datetime.now(timezone.utc)) - when).total_seconds() / 3600.0)

    @staticmethod
    def text(hours):
        if hours is None:
            return "unknown age"
        return "under an hour" if hours < 1 else (f"{int(hours)} h" if hours < 48 else f"{int(hours // 24)} days")


class Reasons:
    @staticmethod
    def of(b, now=None, env=None):
        """Why this branch's 'merge' verdict is not trustworthy now, as card reasons; [] for a fresh mergeable one or any non-merge verdict."""
        if not isinstance(b, dict) or b.get("verdict") != "merge" or b.get("stale"):
            return []
        main, (max_behind, max_hours), reasons = b.get("mainBranch") or "master", Limits.reverify(env), []
        if b.get("willConflict") is True:
            reasons.append(f"conflicts with {main} now")
        behind, age = b.get("behind"), Age.hours(b.get("verifiedAt"), now)
        if isinstance(behind, int) and (behind > max_behind or (behind >= 1 and age is not None and age > max_hours)):
            reasons.append(f"verified {Age.text(age)} ago, {behind} commits behind {main}")
        hub = b.get("hub")
        if isinstance(hub, dict) and hub.get("state") and hub.get("state") not in HUB_FINISHED_STATES:
            # A hub that is fully built stays `coordinating` until its merge
            # lands, so `state not in HUB_FINISHED_STATES` alone would always
            # attach the reason for a ready hub. `readyToMerge` is the only
            # signal that clears before the merge it blocks.
            if not hub.get("readyToMerge"):
                reasons.append("hub piece: an earlier piece or the hub is unfinished")
        return reasons


class Dupes:
    @staticmethod
    def find(branches):
        """{branch: [other branch names]} for open branches (not discard) that name the same non-empty taskId, newest pushed first."""
        groups = {}
        for b in branches:
            if b.get("taskId") and b.get("verdict") != "discard":
                groups.setdefault(b["taskId"], []).append(b)
        return {b["branch"]: [o["branch"] for o in sorted((o for o in m if o is not b), key=lambda o: o.get("pushedAt") or "", reverse=True)]
                for m in groups.values() if len(m) > 1 for b in m}


class Demotion:
    @staticmethod
    def demote(queue_dir, branch, sha, existing, b):
        """A 'merge' verdict (any source) on a branch that now conflicts becomes a deterministic needs-work; the replaced record is kept under 'supersedes'.
        The verdict_recorded journal event is what the Needs-Work worker reacts to. Returns the new record."""
        import branch_verdicts as bv
        main, files = b.get("mainBranch") or "master", [f for f in (b.get("conflictFiles") or []) if f]
        reasons = ["conflicts with " + main + (" on: " + ", ".join(files) if files else ""),
                   f"the earlier {existing.get('source') or 'unknown'} merge verdict ({existing.get('verifiedAt') or 'unknown time'}) no longer applies: {main} moved"]
        verdicts = bv.load_verdicts(queue_dir)
        record = {"verdict": "needs-work", "reasons": reasons, "source": "deterministic", "verifiedAt": bv._now_iso(), "supersedes": dict(existing)}
        verdicts.setdefault(branch, {})[sha] = record
        bv.save_verdicts(queue_dir, verdicts)
        bv._emit_verdict_event(queue_dir, branch, sha, "needs-work", "deterministic")
        return record

    @staticmethod
    def restore(queue_dir, branch, sha, existing):
        """The conflict is gone: put the superseded 'merge' record back. Returns it, or None when there is nothing to restore."""
        import branch_verdicts as bv
        old = existing.get("supersedes")
        if not isinstance(old, dict) or old.get("verdict") != "merge":
            return None
        verdicts = bv.load_verdicts(queue_dir)
        verdicts.setdefault(branch, {})[sha] = dict(old)
        bv.save_verdicts(queue_dir, verdicts)
        bv._emit_verdict_event(queue_dir, branch, sha, "merge", old.get("source") or "unknown")
        return old


def demote_or_restore(queue_dir, repo_root, branch, sha, existing, b, run_git, hub_lookup):
    """True when the stored verdict was demoted, restored or left as a demoted one (the caller then skips the deterministic recompute). willConflict None changes nothing."""
    import branch_verdicts as bv
    if not Limits.demote_enabled():
        return False
    if existing.get("verdict") == "merge" and b.get("willConflict") is True:
        record = Demotion.demote(queue_dir, branch, sha, existing, b)
        task_ids, hub_id = bv.resolve_owner(repo_root, b.get("mainBranch") or "master", branch, run_git, queue_dir, hub_lookup, b.get("taskId"))
        bv.write_task_log(queue_dir, task_ids, hub_id or (b.get("hub") or {}).get("id"), branch, "needs-work", record["reasons"], "deterministic", sha)
        return True
    if isinstance(existing.get("supersedes"), dict):
        if b.get("willConflict") is False:
            Demotion.restore(queue_dir, branch, sha, existing)
        return True
    return False


def annotate_reverify(branches, now=None, env=None):
    """Mutates `branches`: verdictAgeHours (when verifiedAt is known), reverify {reasons, verdictAgeHours} for a 'merge' branch with reasons, duplicateOf."""
    dupes = Dupes.find(branches)
    for b in branches:
        age = Age.hours(b.get("verifiedAt"), now)
        if age is not None:
            b["verdictAgeHours"] = round(age, 2)
        reasons = Reasons.of(b, now, env)
        b.pop("reverify", None)
        if reasons:
            b["reverify"] = {"reasons": reasons, "verdictAgeHours": b.get("verdictAgeHours")}
        b.pop("duplicateOf", None)
        if b.get("branch") in dupes:
            b["duplicateOf"] = dupes[b["branch"]]
    return branches
