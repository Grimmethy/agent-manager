"""Unmerged-branch helpers: merge and sibling conflict checks, change descriptions, hub summaries, the apply lock and commit-log separators.

Moved verbatim out of app.py (2026-10-01 breakdown). app.py re-exports every name below, so `from app import X` and `app.X` keep working."""

import os
import re
import subprocess


def _detect_main_branch(repo_root):
    """Same candidate order as src/git-runner.js's detectDefaultBranch() -- kept in sync
    by hand (same convention as the task-source-catalog duplication elsewhere in this
    file), since a Python dashboard route and a Node apply step both need to agree on
    which branch 'main' means for the same repo."""
    override = os.environ.get("AGENT_MANAGER_MAIN_BRANCH")
    candidates = [c for c in [override, "main", "master"] if c]
    for candidate in candidates:
        check = subprocess.run(
            ["git", "show-ref", "--verify", "--quiet", f"refs/remotes/origin/{candidate}"],
            cwd=str(repo_root), capture_output=True, timeout=10,
        )
        if check.returncode == 0:
            return candidate
    return "main"


# Regex, not exact string matching -- git's own conflict-line wording varies by conflict
# TYPE ("Merge conflict in X" for content conflicts, "Merge conflict in X" for add/add
# too, but the parenthesized kind before it differs: "(content)", "(add/add)", "(rename)",
# etc.) -- only the trailing file path after 'in ' is what callers need, so match loosely
# on that structural shape rather than hardcoding one conflict-type's exact wording.
_CONFLICT_LINE_RE = re.compile(r"^CONFLICT \([^)]+\):.*\bin (.+)$", re.MULTILINE)


def _check_merge_conflict(repo_root, main_branch, branch):
    """Cheap, side-effect-free conflict preview: git merge-tree (2.38+) computes a real
    3-way merge entirely against the object database -- no working tree or index touched,
    nothing to clean up regardless of outcome -- and reports whether it WOULD conflict
    without actually attempting one. Added after a real near-miss (2026-08-18): two
    pushed-but-unmerged branches both independently created the same new file, and the
    only way that surfaced was an opaque git error AFTER a merge was already attempted --
    exactly the kind of surprise a 'one button' merge shouldn't produce. Best-effort: any
    unexpected error here is reported as 'unknown', not 'safe' -- a staleness/conflict
    check that silently says 'no conflict' on its own failure would be worse than no
    check at all.
    """
    result = subprocess.run(
        ["git", "merge-tree", "--write-tree", f"origin/{main_branch}", f"origin/{branch}"],
        cwd=str(repo_root), capture_output=True, text=True, timeout=30,
    )
    if result.returncode == 0:
        return {"willConflict": False, "conflictFiles": [], "checked": True}
    if result.returncode == 1:
        files = _CONFLICT_LINE_RE.findall(result.stdout)
        return {"willConflict": True, "conflictFiles": files, "checked": True}
    # returncode > 1: merge-tree itself errored (not a conflict verdict) -- report
    # "unknown" rather than guessing either way.
    return {"willConflict": None, "conflictFiles": [], "checked": False}


def _check_sibling_conflict(repo_root, branch_a, branch_b):
    """Same idea as _check_merge_conflict, but between two SIBLING unmerged branches
    instead of one branch against main (2026-09-16, root-caused live: a coordinator hub
    decomposed one feature into 4 sub-tasks that all edit the same file -- local-
    tool-client.js -- but the model never declared `after` links between them, so each
    was independently branched straight off the same main commit. Every branch's own
    willConflict (checked only against main) correctly said False; the real collision
    was invisible until a human/agent merged them one at a time and hit a real conflict
    on the 2nd branch. willConflict has never checked a branch against a SIBLING still
    sitting unmerged in the same hub -- this closes that blind spot).

    Uses the two branches' own merge-base as the 3-way base (not main_branch): they
    usually branch directly off main, in which case this is equivalent, but it stays
    correct even when one is stacked on top of the other.
    """
    base = subprocess.run(
        ["git", "merge-base", f"origin/{branch_a}", f"origin/{branch_b}"],
        cwd=str(repo_root), capture_output=True, text=True, timeout=10,
    )
    if base.returncode != 0:
        return {"willConflict": None, "conflictFiles": [], "checked": False}
    base_sha = base.stdout.strip()
    if not base_sha:
        return {"willConflict": None, "conflictFiles": [], "checked": False}
    # --write-tree's own 2-branch form always computes the merge-base itself; overriding
    # it takes the separate --merge-base=<commit> OPTION, not a 3rd positional argument
    # (that positional form only exists for the older, write-tree-less --trivial-merge
    # mode) -- confirmed live the hard way: the naive 3-positional-arg form used here
    # first always errored with git's own usage text (exit 129), which this function's
    # broad "non-conflict, non-zero code" branch silently swallowed as checked:False,
    # meaning the sibling-conflict check would have silently never fired for ANY pair.
    result = subprocess.run(
        ["git", "merge-tree", "--write-tree", f"--merge-base={base_sha}", f"origin/{branch_a}", f"origin/{branch_b}"],
        cwd=str(repo_root), capture_output=True, text=True, timeout=30,
    )
    if result.returncode == 0:
        return {"willConflict": False, "conflictFiles": [], "checked": True}
    if result.returncode == 1:
        files = _CONFLICT_LINE_RE.findall(result.stdout)
        return {"willConflict": True, "conflictFiles": files, "checked": True}
    return {"willConflict": None, "conflictFiles": [], "checked": False}


def _annotate_hub_sibling_conflicts(repo_root, branches):
    """Mutates `branches` in place, adding `hubSiblingConflicts: [branch, ...]` to any
    branch whose coordinator hub has another still-unmerged sibling it would conflict
    with. O(members^2) merge-tree calls per hub -- hubs are small (2-4 real sub-tasks in
    every one seen so far), so this stays cheap. Best-effort: a git failure on any one
    pairwise check leaves that pair unflagged rather than raising (matches _check_merge_
    conflict's own "unknown, not a false 'safe'" doctrine for a checked=False result, but
    an unflagged pair here just means a human sees one fewer warning, not a false
    all-clear on the branch's own primary willConflict field).
    """
    by_hub = {}
    for b in branches:
        hub = b.get("hub")
        hub_id = hub.get("id") if hub else None
        if hub_id:
            by_hub.setdefault(hub_id, []).append(b)
            # Always present (never a missing key) for any branch with a hub, even when
            # it's the only one of that hub still unmerged -- a consumer should never
            # need to distinguish "no conflicts" from "field not computed yet".
            b["hubSiblingConflicts"] = []
    for siblings in by_hub.values():
        if len(siblings) < 2:
            continue
        for i, b in enumerate(siblings):
            conflicts_with = []
            for j, other in enumerate(siblings):
                if i == j:
                    continue
                try:
                    sib = _check_sibling_conflict(repo_root, b["branch"], other["branch"])
                except (subprocess.SubprocessError, OSError):
                    continue
                if sib["willConflict"]:
                    conflicts_with.append(other["branch"])
            b["hubSiblingConflicts"] = conflicts_with


_RESOLUTION_LINE_RE = re.compile(r"RESOLUTION:\s*(?:implemented|no-changes-needed|decompose)\b", re.IGNORECASE)


_CANDIDATE_METADATA_LINE_RE = re.compile(r"^(?:###.*|Strength:.*|Files?:.*|Source:.*)$", re.MULTILINE)


_DESCRIPTION_MAX_CHARS = 600


def _describe_change(data: dict) -> str | None:
    """Best-effort plain-English description of what a branch's task actually changed
    (Grimmethy, 2026-08-20: "I'd also like the unmerged branch reports to include a plain
    english description of the fix or change"). Tries strategies in order of how likely
    they are to already BE real prose written for exactly this purpose, rather than
    parsing a diff or guessing:

    1. adhoc's real agentic Claude pass always ends its own final message with a short
       plain-English summary right after its own RESOLUTION: sentinel line
       (adhoc-agentic-draft.js's prompt asks for this explicitly) -- use it verbatim.
    2. A candidate-fulfillment task (arch_review/observability_fix/performance_fix/etc.,
       via nextCandidateFulfillmentTask) carries the ORIGINAL candidate's own
       Problem/Solution/Benefits write-up in promptContext.body -- real prose written for
       a human, unlike implementResponse itself for this task shape (raw Group-B JSON
       diff instructions, no natural language at all).
    3. A verdict-only source (observability_review/performance_review triage after their
       2026-08-20 redirect, arch_discovery's own candidate write-up, etc.) already has
       plain-prose implementResponse -- use it directly if it doesn't look like JSON,
       stripping the same AC-NNN/Strength/Files header lines if it's in candidate format
       (a genuine verdict IS a candidate write-up now, not just fulfillment tasks).
    4. Fall back to planResponse (still real prose, just less specific).
    """
    def strip_candidate_metadata(text: str) -> str:
        cleaned = _CANDIDATE_METADATA_LINE_RE.sub("", text).strip()
        return re.sub(r"\n{3,}", "\n\n", cleaned).strip()

    # 2026-08-26, Grimmethy: "Does the record in the dashboard properly reflect all the
    # information about this entry?" -- caught live on arch-review-ac-4: a split-resolution
    # task (implementResponse is raw {"mode":"split",...} JSON, no RESOLUTION line, no
    # plain-prose implement) fell all the way through to strategy 2 below and showed the
    # ORIGINAL candidate's problem/solution write-up as the branch's description -- reading
    # exactly like a completed refactor (title unchanged too) even though the branch
    # contains ZERO code changes, only two new sub-candidates appended to the doc. Checked
    # FIRST, ahead of every other strategy: candidateSplitProposals is set exclusively by
    # this exact outcome (see apply-task.js's applyCandidateSplit / local-draft.js's
    # parseCandidateSplit) and is unambiguous where implementResponse's shape is not.
    split_proposals = data.get("candidateSplitProposals")
    if split_proposals:
        titles = [p.get("title") for p in split_proposals if isinstance(p, dict) and p.get("title")]
        titles_text = "; ".join(titles) if titles else f"{len(split_proposals)} sub-candidates"
        if data.get("candidateSplitRoute") == "hub":
            return (
                f"Too large for one pass -- split into {len(split_proposals)} chained piece(s) that become a coordinator hub "
                f"when applied (no code on this branch): {titles_text}"
            )[:_DESCRIPTION_MAX_CHARS]
        return (
            f"Split into {len(split_proposals)} sub-candidate(s), not yet implemented: "
            f"{titles_text}"
        )[:_DESCRIPTION_MAX_CHARS]

    # agentic-draft-common.js appends the raw diff after a `=== DIFF ===` marker
    # (`${summary}\n\n=== DIFF ===\n${task.rawDiff}`). Strip it before any strategy below
    # touches the text -- otherwise a short plain-English summary right before the marker
    # (e.g. "RESOLUTION: implemented\ndone" with nothing else) lets the 600-char slice run
    # straight into the diff itself, showing raw `diff --git ...` hunks as the "What this
    # changes" description instead of prose.
    implement = (data.get("implementResponse") or "").split("=== DIFF ===")[0].strip()

    m = _RESOLUTION_LINE_RE.search(implement)
    if m:
        after = implement[m.end():].strip()
        if after:
            return after[:_DESCRIPTION_MAX_CHARS]

    prompt_context = data.get("promptContext") or {}
    body = (prompt_context.get("body") or "").strip()
    if body:
        cleaned = strip_candidate_metadata(body)
        if cleaned:
            return cleaned[:_DESCRIPTION_MAX_CHARS]

    if implement and not implement.startswith(("{", "[")):
        text = strip_candidate_metadata(implement) if implement.startswith("###") else implement
        if text:
            return text[:_DESCRIPTION_MAX_CHARS]

    plan = (data.get("planResponse") or "").strip()
    if plan:
        return plan[:_DESCRIPTION_MAX_CHARS]

    return None


# Every apply-task.js commit body carries a `Task: <id> (<domain>/<source>)` trailer (see
# its commitMessage). That id is the join key back to the task's real pipeline log.
_TASK_TRAILER_RE = re.compile(r"^Task:\s*(\S+)", re.MULTILINE)


def _is_real_ship(rec):
    """Whether a done-queue task REALLY shipped code (2026-08-25, "24 of 25 'shipped'
    tasks produced zero code" -- 24 ended with 'no candidates in implement response --
    nothing to apply', closed by deterministic-empty-approve or a 3/3 vote on a 0-char
    draft). True only when the record's own terminalDisposition is 'merged' AND its
    history has an 'applied' stage whose detail is non-empty and is not a no-op marker;
    anything else is a no-op and must not count toward the shipped headline, or every
    dashboard/SLO reading queue/done/ as 'shipped' over-reports by ~24x."""
    if not isinstance(rec, dict) or rec.get("terminalDisposition") != "merged":
        return False
    noop_markers = ("nothing to apply", "no candidates", "noop")
    for h in rec.get("history") or []:
        if not isinstance(h, dict) or h.get("stage") != "applied":
            continue
        detail = (h.get("detail") or "").strip()
        if not detail:
            return False
        if any(marker in detail.lower() for marker in noop_markers):
            return False
        return True
    return False


_HUB_TITLE_LABEL_RE = re.compile(r"^(HUB\d{4,})(?:-\d+)?\b")


def _norm_path(p) -> str:
    try:
        return os.path.realpath(str(p)) if p else ""
    except OSError:
        return os.path.normpath(str(p))


def _history_entry_detail_text(e):
    """The visible line under a history entry's stage label in the Unmerged Branches
    modal. Older/hand-written entries (the pre-task-history.js `{"status": "pending"}`
    shape api_task_requeue used to write, still the shape of a `requeued` event's own
    note today) carry their text in `note`, not `detail` -- confirmed live 2026-09-12:
    observability-fix-ac-158's requeue entry rendered as a bare 'pending' label with
    nothing beneath it, because this used to read ONLY `detail`. Also folds in the
    blockedReasonAtRequeue/priorRejectionFeedbackAtRequeue api_task_requeue now stamps on
    its own `requeued` entry (see that endpoint) -- without this, that data is captured in
    the JSON but still invisible at a click, same failure mode this whole mechanism exists
    to close."""
    parts = []
    if e.get("detail"):
        parts.append(str(e["detail"]))
    elif e.get("note"):
        parts.append(str(e["note"]))
    if e.get("blockedReasonAtRequeue"):
        parts.append(f"(blocked for: {e['blockedReasonAtRequeue']})")
    if e.get("priorRejectionFeedbackAtRequeue"):
        parts.append(f"(prior rejections: {e['priorRejectionFeedbackAtRequeue']})")
    return " ".join(parts) if parts else None


def _summarize_task_record(data, state):
    """Compact pipeline log for one task, for the Unmerged Branches detail modal: the
    full `history[]` (created -> plan -> implement tiers -> review votes -> applied ->
    disposition), plus the fields that say what it did and where it stands."""
    history = data.get("history") or []
    review_votes = None
    for e in reversed(history):
        if (e.get("stage") or e.get("status")) == "approved" and e.get("detail"):
            review_votes = e.get("detail")
            break
    return {
        "id": data.get("id"),
        "title": data.get("title"),
        "domain": data.get("domain"),
        "source": data.get("source"),
        "state": state,
        "terminalDisposition": data.get("terminalDisposition"),
        "adhocResolution": data.get("adhocResolution"),
        "description": _describe_change(data),
        "reviewVotes": review_votes,
        "decomposedFrom": (data.get("promptContext") or {}).get("decomposedFrom"),
        "history": [
            {"stage": e.get("stage") or e.get("status"), "at": e.get("at"), "detail": _history_entry_detail_text(e)}
            for e in history
        ],
    }


# Fallback ONLY for a hub record the coordinator has not re-swept since `subTasks[].phase` was introduced (it is rewritten every tick, so this
# is transient). The real definition is coordinator-sweep.js's childPhase(); the sets below mirror it for statuses that were already there.
_HUB_LEGACY_MERGED = {"done", "gone", "merged", "applied-direct", "filed", "dismissed", "noop", "abandoned", "superseded", "aged-out"}


def _hub_child_phase(st):
    phase = st.get("phase")
    if phase in ("merged", "built", "open"):
        return phase
    status = st.get("status")
    if status in _HUB_LEGACY_MERGED:
        return "merged"
    return "built" if status == "pending-merge" else "open"


def _summarize_hub(data, state):
    subs = [st for st in (data.get("subTasks") or []) if isinstance(st, dict)]
    phases = [_hub_child_phase(st) for st in subs]
    done_n = sum(1 for p in phases if p == "merged")
    built_n = sum(1 for p in phases if p in ("merged", "built"))
    gate = data.get("integrationGate") or {}
    all_children_built = len(subs) > 0 and built_n == len(subs)
    gate_clear = gate.get("status") in (None, "passed", "skipped")
    return {
        "id": data.get("id"),
        "title": data.get("title"),
        "mode": data.get("mode"),
        "branch": data.get("branch"),
        "state": state,
        # done = merged/closed; built = done + finished-but-awaiting-merge (see coordinator-sweep.js childPhase)
        "progress": {"done": done_n, "built": built_n, "total": len(subs)},
        "subTasks": [
            {"id": st.get("id"), "title": st.get("title"), "status": st.get("status"), "phase": phase}
            for st, phase in zip(subs, phases)
        ],
        "integrationGate": {"status": gate.get("status"), "checks": gate.get("checks")},
        "blockedReason": data.get("blockedReason"),
        # Ready to merge = every piece is BUILT (finished, committed, waiting on the merge -- not necessarily merged already) and the
        # integration gate has passed or was skipped. A hub already in done/ shipped.
        "readyToMerge": bool(state == "done" or (all_children_built and gate_clear)),
    }
