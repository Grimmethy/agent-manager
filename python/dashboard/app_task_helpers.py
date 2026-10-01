"""Task and instance helpers: task summaries, heartbeat timestamps, completed-task scans, JSON-fence parsing, task input summaries, archive/requeue bookkeeping and the repeated-blocker matcher.

Moved verbatim out of app.py (2026-10-01 breakdown). app.py re-exports every name below, so `from app import X` and `app.X` keep working."""

import json
import os
import re
import shutil
from flask import abort
from app_settings_helpers import PACKAGE_ROOT


def task_summary(data: dict, filename: str) -> dict:
    """Deliberately excludes planResponse/implementResponse/promptContext -- those can
    carry tens of thousands of characters of embedded file content (arch_discovery
    especially) and would make the list view slow to load for no benefit; the detail
    endpoint returns the full task."""
    return {
        "id": data.get("id", filename),
        "title": data.get("title"),
        "domain": data.get("domain"),
        "source": data.get("source"),
        "status": data.get("status"),
        "blockedReason": data.get("blockedReason"),
        "blockedStage": data.get("blockedStage"),
        "branch": data.get("branch"),
        "compareUrl": data.get("compareUrl"),
        "doneMarker": data.get("doneMarker"),
        "createdAt": data.get("createdAt"),
        "reviewedAt": data.get("reviewedAt"),
        "appliedAt": data.get("appliedAt"),
        "localRejectCount": data.get("localRejectCount", data.get("ornithRejectCount")),
        # Small (a reason string + a handful of short candidate paths at most) -- nothing
        # like the promptContext/planResponse bulk excluded above, and the needs-
        # clarification row rendering needs it to show WHICH kind of hold this is without
        # a second round-trip per row.
        "needsClarification": data.get("needsClarification"),
        # Small {reason,disposition,confidence,evidence[],flaggedAt} object stamped by
        # adhoc-staleness-flag.js / staleness-auto-archive.js -- the row shows a chip +
        # Archive/Keep buttons so a human can retire a dead adhoc task without opening it.
        "stalenessFlag": data.get("stalenessFlag"),
        # True when this task was blocked at the review stage with its draft intact -- the row then offers
        # Re-review (send the SAME draft back to review, no redraft; src/rereview-task.js). Mirrors that
        # module's isRereviewable().
        "rereviewable": data.get("blockedStage") == "review" and bool((data.get("implementResponse") or "").strip()),
        # Same shape/purpose as stalenessFlag above but for context-trim-sweep.js: the
        # task's file-content anchoring went stale and re-anchoring never resolved it.
        "contextTrimFlag": data.get("contextTrimFlag"),
        # Coordinator (decomposed parent) checklist -- a small [{id,title,status}] list plus
        # a {done,total} rollup, stamped by coordinator-sweep.js. The Coordinating list row
        # shows the "N of M" from `progress` without a per-row round-trip.
        "subTasks": data.get("subTasks"),
        "progress": data.get("progress"),
        # For the Hub Tasks row's "ready to merge" (needs the stacked-hub integration gate's status as well as the piece counts).
        "integrationGate": data.get("integrationGate"),
        "hubSerial": data.get("hubSerial"),
        "hubLabel": data.get("hubLabel"),
        # Operator-set integer on a coordinating hub (LOWER = more urgent), stamped by
        # POST /api/task-anywhere/<id>/hub-priority. Drives the Hub Tasks tab's default
        # sort AND the worker claim order for that hub's children (src/hub-priority.js).
        "hubPriority": data.get("hubPriority"),
        # coordinator-sweep.js stamps this on a hub whose remaining sub-tasks can't proceed
        # (a child stuck in needs-clarification/blocked, or a sibling waiting on one). The
        # Coordinating row shows ⛔ + the reason instead of the plain progress count.
        "coordinatorBlocked": data.get("coordinatorBlocked"),
        # Owning hub, when this hub itself was spawned from an existing hub's child (see
        # decompose-loop-autoroute.js / apply-task.js's recordApplyOutcome). api_queue_state
        # uses this to build the Hub Tasks tab's real family-tree order + hubDepth.
        "parentHub": data.get("parentHub"),
    }


_LANE_IDS_CACHE: dict = {"at": 0.0, "ids": []}


_LANE_IDS_TTL_S = 60.0


def _zero_stats_model_row(model: str) -> dict:
    """A placeholder row for a model api_models() knows is available but has never been
    called -- same field shape as a real row, with every stat null/zero rather than the
    row being absent entirely."""
    return {
        "model": model, "callCount": 0, "approved": 0, "rejected": 0, "approveRate": None,
        "avgLatencyMs": None, "avgTokensPerSec": None, "minTokensPerSec": None,
        "maxTokensPerSec": None, "degenerateCount": 0, "errorCount": 0, "totalCostUsd": None,
    }


def _recent_task_ids_for_instance(conn, instance_id, fetch_n):
    """task_ids most recently associated with instance_id in model_calls, regardless of
    that call's own outcome column. Deliberately drops the outcome='approved' filter the
    original query used (2026-09-08, Grimmethy: "Worker-1 and Worker-reasoning have the
    same problem. All task history information is stale.") -- root-caused live the same
    way as the reviewer branch above, but through a different mechanism: outcome/
    outcome_stage are ONLY populated on a call's row when review-task.js's
    recordModelOutcome actually runs against it, which happens for a reviewed
    approve/reject verdict -- a draft that resolves as a no-op/stale-task short-circuit,
    a needs-clarification block, or any other non-reviewed terminal path leaves those
    columns NULL forever on that call's row, even though the task itself did reach a
    real terminal state. Confirmed directly against the db: worker-1's last
    outcome='approved' row was from 00:50, but model_calls had real worker-reasoning
    activity on that same task_id at 05:15-05:16 with outcome IS NULL (its actual
    resolution was a stale-task no-op, not a review). instance_id itself IS reliable
    unconditionally -- every real call stamps it via AGENT_MANAGER_INSTANCE_ID at call
    time (model-stats-client.js:96) -- so it stays the attribution source of truth here;
    only the outcome/title/completedAt need to come from the task's own real record
    instead of this table's outcome columns (see the caller's lookup loop)."""
    rows = conn.execute("""
        SELECT task_id, MAX(started_at) AS at
        FROM model_calls
        WHERE instance_id = ?
        GROUP BY task_id
        ORDER BY at DESC
        LIMIT ?
    """, (instance_id, fetch_n)).fetchall()
    return [t for t, _ in rows]


PIPELINE_HISTORY_LOG_FILENAME = "pipeline-history.log"


def _read_pipeline_history_events(instances_d, event_type, instance_id=None, limit=200):
    """Reads <instancesDir>/pipeline-history.log (src/pipeline-history.js's unified
    NDJSON writer -- see that file's own header for why the previously-separate
    degenerate/hard-failure/context-budget/fact-check-block logs were consolidated into
    one stream discriminated by `type`) for events of one `type`, newest first.
    `instance_id`, when given, filters to that field -- added to hard-failure/degenerate
    entries 2026-09-08 specifically so a failed run can be attributed to the worker that
    produced it (see local-client.js's logHardFailureAudit/logDegenerateAudit wrapper
    comments)."""
    if not instances_d:
        return []
    path = instances_d / PIPELINE_HISTORY_LOG_FILENAME
    if not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    results = []
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") != event_type:
            continue
        if instance_id is not None and ev.get("instanceId") != instance_id:
            continue
        results.append(ev)
        if len(results) >= limit:
            break
    return results


# Per-instance model override for the Workers tab's dropdown (Grimmethy, 2026-08-18: "I
# need to be able to manually select which model to use for each worker type"). Lives in
# dashboard-settings.json alongside claudeDefaultModel/claudeDefaultEffort -- same "takes
# effect without a pipeline restart" shape those already have, since agent-manager.env's
# LOCAL_MODEL/CLAUDE_MODEL only apply at daemon launch. local-worker.sh/review-runner.sh
# re-read this file once per tick (get_model_override in agent-manager-common.sh) so a
# change here reaches a running worker within one tick, no restart needed. watchdog has no
# entry -- it never calls a model at all (queue-watcher.sh always heartbeats model="").
# Manual "pause Claude" kill switch (Grimmethy, 2026-08-25: "I need a way to pause the
# claude use... preserve the tokens since I know I'm very likely to hit my weekly
# limit"). Distinct from budget-monitor.js's own reactive rate-limit detection -- this is
# a deliberate, proactive stop a human can flip from the Workers tab before actually
# hitting the cap. Global (not per-instance): src/claude-pause.js's own header explains
# why -- adhoc's real Claude spend happens on whichever lane's task escalates there, not
# exclusively worker-reasoning, so a per-instance checkbox would leave a real spend path
# unprotected. Read via src/claude-pause.js (Node call sites) and
# agent-manager-common.sh's get_claude_paused (bash call sites) -- both read this exact
# same dashboard-settings.json field, no separate plumbing.
# Model benchmark panel (Models tab, 2026-08-19, Grimmethy: "benchmarking needs to be a
# part of the models tab UI... exhaustive... each benchmark test response should be saved
# in second brain and accessible to the user in app, same as reading any other task").
# This whole feature is a thin Python wrapper around src/reasoning-bench.js -- ALL grading/
# metrics/persistence logic lives there (see that file's own header), Python only launches
# it as a detached background process (same subprocess.Popen(..., start_new_session=True)
# pattern _start_pipeline() already uses for the daemons themselves) and polls a progress
# file, since a real multi-model, multi-run benchmark can take many minutes -- far too long
# to run inside a single Flask request/response cycle.
BENCHMARK_STATE_DIR = PACKAGE_ROOT / ".agent-manager-cache" / "benchmarks"


BENCHMARK_CURRENT_POINTER = BENCHMARK_STATE_DIR / "current-run-id.txt"


def _fetch_ollama_models() -> list:
    ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    try:
        import urllib.request
        with urllib.request.urlopen(f"{ollama_url}/api/tags", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return sorted(m["name"] for m in data.get("models", []))
    except Exception:
        return []


def _safe_run_id(run_id: str) -> str:
    """Both the state dir and the SecondBrain dir key off this value as a literal path
    segment -- reject anything that isn't the shape reasoning-bench.js's own runId slugging
    produces, rather than trust a client-supplied path segment outright (path traversal via
    '../' in a run_id query param)."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", run_id or ""):
        abort(400, description="invalid run id")
    return run_id


def _case_result_score(result: dict) -> float | None:
    """One response's score as a 0.0-1.0 float, regardless of grader shape: an objective
    grader's boolean pass becomes 1.0/0.0, a judge grader's own 0.0-1.0 score is used
    directly. None (not 0.0) for an ungraded/ambiguous response -- excluded from the
    average entirely rather than silently counted as a 0, which would wrongly punish a
    model for a judge call that failed (e.g. hit a Claude rate limit) rather than for
    actually answering wrong."""
    grade = result.get("grade") or {}
    if grade.get("score") is not None:
        return float(grade["score"])
    if grade.get("pass") is True:
        return 1.0
    if grade.get("pass") is False:
        return 0.0
    return None


_REPORT_PERIODS = ("hourly", "daily", "weekly")


# Task metadata (2026-08-26, Grimmethy: "At the top of every task I'd like to see a bit
# of meta data... a list of all the files it touched") -- a task's actual on-disk change
# is expressed in one of two shapes depending on which applier handles it (see
# apply-task.js's own dispatch): Group A/adhoc tasks carry a real unified diff in
# task.rawDiff (`diff --git a/X b/Y` headers); Group B tasks carry a JSON change object
# (or array of them) with a `file` field per change in task.implementResponse, same
# format apply-group-b.js itself parses. A task that never touches the filesystem at all
# (a verdict-only observability/performance audit, an arch_discovery/arch_review "split"
# proposal) legitimately has neither -- returns [] for those, not an error.
#
# Mirrors src/json-fence.js's fenced/balanced-JSON recovery (already proven live against
# real local-model drafts that wrap JSON in a code fence, or add prose before/after it)
# in Python rather than shelling out to node per task view -- keep the two in sync if
# either's recovery logic changes.
_DIFF_GIT_HEADER_RE = re.compile(r'^diff --git a/(.+?) b/(.+?)$', re.MULTILINE)


_FENCED_JSON_RE = re.compile(r'```(?:json)?\s*([\s\S]*?)```')


def _extract_balanced_json(text: str) -> str | None:
    m = re.search(r'[\[{]', text)
    if not m:
        return None
    start = m.start()
    open_ch = text[start]
    close_ch = '}' if open_ch == '{' else ']'
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == '\\':
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _parse_json_maybe_fenced(text: str | None):
    if not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    m = _FENCED_JSON_RE.search(text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    extracted = _extract_balanced_json(text)
    if extracted:
        try:
            return json.loads(extracted)
        except json.JSONDecodeError:
            pass
    return None


def _files_touched_for(task: dict) -> list[str]:
    raw_diff = task.get("rawDiff")
    if raw_diff:
        seen: set[str] = set()
        out: list[str] = []
        for a, b in _DIFF_GIT_HEADER_RE.findall(raw_diff):
            # `b` is /dev/null for a deletion (the new side doesn't exist) -- fall back to
            # `a` so a deleted file still shows up in the list instead of as "dev/null".
            f = b if b and b != "/dev/null" else a
            if f and f not in seen:
                seen.add(f)
                out.append(f)
        return out

    parsed = _parse_json_maybe_fenced(task.get("implementResponse"))
    if parsed is None:
        return []
    items = parsed if isinstance(parsed, list) else [parsed]
    seen = set()
    out = []
    for item in items:
        f = item.get("file") if isinstance(item, dict) else None
        if f and f not in seen:
            seen.add(f)
            out.append(f)
    return out


# The promptContext keys that carry a task's actual INPUT -- what the drafting model was
# asked to act on. Different sources stash it under different names, and only `rawText`
# was ever surfaced in the task-detail modal, so e.g. product_spec's whole request brief
# (promptContext.requestText, ~2KB) rendered nowhere and a blocked product_spec task gave
# "no indication of what actually happened" (2026-08-30). (label, candidate keys) -- first
# non-empty key per label wins; several labels can show at once (a scanner finding's
# `detail` + its `snippet`, say).
_TASK_INPUT_FIELDS = [
    ("Request", ("requestText", "rawText", "taskText", "reason")),
    ("Finding", ("detail",)),
    ("Code snippet", ("snippet",)),
    ("Candidate", ("body",)),
    ("Open questions", ("openQuestions",)),
]


def _task_input_summary(task: dict) -> list[dict]:
    pc = task.get("promptContext") or {}
    title = (task.get("title") or "").strip()
    out: list[dict] = []
    for label, keys in _TASK_INPUT_FIELDS:
        for k in keys:
            v = pc.get(k)
            if isinstance(v, str) and v.strip() and v.strip() != title:
                out.append({"label": label, "text": v})
                break
    if task.get("source") == "product_spec":
        rel = pc.get("specRelPath")
        if rel:
            note = "updating the existing spec" if pc.get("specExists") else "new file"
            out.append({"label": "Output", "text": f"{rel} ({note})"})
    elif task.get("source") == "product_spec_outline":
        out.append({"label": "Output", "text": "PRODUCT_SPEC_OUTLINE.md (AC-NNN section candidates) + a marker skeleton for the spec doc"})
    elif task.get("source") == "product_spec_section":
        rel = pc.get("specRelPath")
        if rel:
            out.append({"label": "Output", "text": f"{rel} (fills one section's placeholder block)"})
    elif task.get("source") == "pipeline_forensics":
        # Forensics promptContext keys (subjectKind/subjectKey/signature/triggerType) don't
        # match _TASK_INPUT_FIELDS, so without this the modal has no "what did this study
        # examine" line at all -- the reader lands in the report with no framing.
        kind = pc.get("subjectKind")
        key = pc.get("subjectKey") or pc.get("signature")
        trigger = pc.get("triggerType")
        if key:
            if kind and kind != "signature":
                text = f"{kind} {key}"
            else:
                text = f'signature "{key}"'
            if trigger:
                text += f" (trigger: {trigger})"
            out.append({"label": "Study", "text": text})
    return out


def _archive_task_file(qdir, src):
    """Moves a task file to queue/done/_archived_no_action/<id>.json -- not a new
    convention, the exact folder already used for every manual archive done by hand
    earlier in this project's history. Shared by api_task_archive (manual per-row button)
    and api_git_discard_branch (discarding a branch's own task) so both go through the
    exact same move logic rather than a second, possibly-inconsistent copy. Raises
    FileExistsError if an archived copy already exists at the destination -- callers
    decide how to surface that (api_task_archive 409s; api_git_discard_branch treats it
    as already-archived and moves on)."""
    dest_dir = qdir / "done" / "_archived_no_action"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    if dest.exists():
        raise FileExistsError(f"an archived copy of '{src.stem}' already exists")
    shutil.move(str(src), str(dest))
    return dest


# States whose archive means "we are giving up on this task" (as opposed to the Done tab's tidy-up of finished work).
_GIVE_UP_ARCHIVE_STATES = ("blocked", "needs-clarification", "awaiting-confirm")


# Repeated-blocker guard (2026-08-24, pipeline hardening, Grimmethy: "no 'repeated
# identical blocker' escalation"). Root-caused live: two real tasks each survived a full
# bulk-requeue pass ("get to 0 blocked", 2026-08-23) and immediately failed the exact
# same way again -- a blind requeue changes nothing about the task or its environment,
# so a genuinely structural failure just replays. blockedReason text is a much more
# reliable similarity signal than a task's title (concrete symbols/requirements repeat
# near-verbatim across attempts at the same root cause, e.g. "CLAUDE_MODEL_CHOICES"
# literally recurred across 3 of 6 real rejections for one task this session), so this
# compares the CURRENT blockedReason against every entry already accumulated in
# priorRejectionFeedback (reject-retry-check.js's automatic retries already append every
# rejection reason there) rather than trying to fingerprint task identity at all.
_STOPWORDS = {
    "a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with", "is", "are",
    "this", "that", "it", "be", "as", "at", "by", "from", "into", "not", "but", "its",
    "was", "were", "has", "have", "had", "do", "does", "did",
}


def _significant_words(text):
    return {w for w in re.findall(r"[a-z0-9_]+", (text or "").lower()) if len(w) > 2 and w not in _STOPWORDS}


def _jaccard(a, b):
    if not a or not b:
        return 0.0
    intersection = len(a & b)
    union = len(a | b)
    return (intersection / union) if union else 0.0


_QUOTED_SYMBOL_RE = re.compile(r"`([^`]{3,60})`")


_REPEATED_BLOCKER_THRESHOLD = 0.3


def _quoted_symbols(text):
    """Backtick-quoted spans (a code identifier, file path, or function name) -- review-
    task.js's own blockedReason prose consistently cites the specific symbol it's
    objecting to this way (confirmed against real data: `CLAUDE_MODEL_CHOICES` literally
    recurred, backtick-quoted, across 3 of 6 real rejections for one task this session).
    Far more precise than generic word overlap for THIS specific failure mode -- two
    fresh pieces of critique prose about the same missing symbol often share almost no
    other vocabulary at all."""
    return {m.strip() for m in _QUOTED_SYMBOL_RE.findall(text or "") if m.strip()}


def _repeated_blocker_match(task):
    """Returns the most similar prior rejection reason if the CURRENT blockedReason looks
    like the same underlying problem recurring, else None. Deliberately best-effort and
    approximate -- a missed match just means no warning shown (same as before this
    existed); a false-positive match costs one extra confirm click (force=true), never
    blocks a requeue outright."""
    current_reason = task.get("blockedReason") or ""
    if not current_reason:
        return None
    current_symbols = _quoted_symbols(current_reason)
    current_words = _significant_words(current_reason)
    best = None
    for prior in (task.get("priorRejectionFeedback") or []):
        prior = prior or ""
        # Primary, high-precision signal: the exact same quoted symbol named as the
        # problem in both this rejection and an earlier one -- a match here is decisive,
        # no need to also clear the (weaker) word-overlap bar below.
        if current_symbols & _quoted_symbols(prior):
            return prior
        # Fallback for rejections that don't happen to quote a symbol (e.g. "fails to
        # search ClinicalTrials.gov for a registration number") -- generic word overlap,
        # a weaker signal on its own so held to a slightly lower bar than the primary one.
        score = _jaccard(current_words, _significant_words(prior))
        if score >= _REPEATED_BLOCKER_THRESHOLD and (best is None or score > best[1]):
            best = (prior, score)
    return best[0] if best else None
