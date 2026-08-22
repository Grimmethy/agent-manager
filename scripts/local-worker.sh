#!/usr/bin/env bash
# Ornith-worker daemon: claims drafts from pending/, invokes ornith-client to plan/implement, moves draft to drafting/. Port of src/orchid-worker.ps1.

set -u                                                                              # strict mode: catch unset var typos as failure (prevents silent "working on nothing" loop that PowerShell's lack-of-modes lets slide).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"                 # locate scripts/ dir so we can reference sibling files regardless of how this script was invoked by launch.sh / user.
readonly INSTANCE_ID="${1:-worker-0}"                                              # allow override via argv; default to 'worker-0' matching PowerShell's $env:INSTANCE_ID if undefined (same convention across all 4 daemons so operator can grep logs for specific loop instance).
export AGENT_MANAGER_INSTANCE_ID="$INSTANCE_ID"                                     # so ornith-client.js (invoked as a node child of this process) can stamp its in-flight lock records with who's holding them -- see model-inflight-lock.js; purely diagnostic, not required for the lock's own correctness.

# Parallel Claude worker lane (Brain Dump #67 follow-up, 2026-08-17; generalized from
# adhoc-only to a reasoning-tier concept for Brain Dump #77, 2026-08-17): any instance
# named worker-reasoning* claims ONLY pending tasks whose reasoning tier (model-provider.js's
# reasoningTierFor() -- the same function ornith-draft.js/review-task.js already call to
# pick a backend) resolves to 'high', and every OTHER worker-* instance skips them
# instead, leaving them for this lane. Originally this was hardcoded to "adhoc-shaped"
# tasks specifically (the ones whose implement pass is a real agentic Claude Code CLI
# call, adhoc-agentic-draft.js); it's now the general tier concept because a second kind
# of high-reasoning-only task exists (Brain Dump #77's automatic high-reasoning retry for
# a needs-clarification task whose first, low-reasoning attempt didn't resolve
# confidently) -- adhoc itself still resolves to 'high' via its own static registration in
# task-sources.js, so behavior for adhoc tasks is unchanged. Pure naming convention, no
# new env var/config -- restartTargetFor() (dead-process-check.js) already matches any
# instanceId.startsWith('worker-') generically via this same script, so a worker-reasoning
# instance is auto-restart-eligible for free. Motivation: Claude is cloud-based, no GPU
# contention with Ornith, but a single shared worker-1 claiming BOTH kinds serially means
# a multi-minute high-reasoning call blocks Ornith's own (otherwise much faster) throughput
# behind it for that whole time.
case "$INSTANCE_ID" in
  worker-reasoning*) IS_CLAUDE_LANE=true ;;
  *) IS_CLAUDE_LANE=false ;;
esac

source "${SCRIPT_DIR}/orc-common.sh"                                               # load-shared env, validate config — fail loudly here before doing any work so user sees clear error message vs daemon silently hanging on missing repo path.
# Note: this source is idempotent-safe because orc-common sets only unset vars (so subsequent sources don't override caller's environment).

# Every write_heartbeat_file call below used to hardcode "${LOCAL_MODEL:-}" as the
# reported model regardless of which lane was actually running -- confirmed live
# 2026-08-17: the dashboard's Workers tab showed worker-reasoning as running "ornith:35b"
# even though it only ever claims adhoc tasks and never calls Ornith at all. Same
# "claude:<model>" label format model-provider.js's own labelFor() already uses for the
# Models tab, so the two stay consistent.
#
# Re-run once per tick (not just once at startup, 2026-08-18: Workers tab per-instance
# model dropdown) -- exports LOCAL_MODEL/CLAUDE_MODEL for this tick from
# dashboard-settings.json's workerModelOverrides when the dashboard has set one for THIS
# instanceId, else leaves whatever agent-manager.env set at launch untouched. Every node
# call downstream this tick (ornith-draft.js, claude-client.js via the reasoning lane)
# inherits the exported value, so no other call site needs to change.
#
# The reasoning lane's override can name EITHER backend (2026-08-18 follow-up, Grimmethy:
# "reasoning is set to only show subscription models -- I need to be able to select from
# both subscription and local models") -- the dropdown prefixes its value with "claude:"
# or "ollama:" precisely so this can tell which one was picked (worker-1/reviewer's plain
# Ornith-only dropdown has no such ambiguity, so its override stays a bare model name).
# AGENT_MANAGER_FORCE_PROVIDER is model-provider.js's own hook for this -- see its header
# comment for why adhoc/research_task's agentic Claude calls are unaffected either way.
refresh_active_model() {
  local override
  override="$(get_model_override "$INSTANCE_ID")"
  if "$IS_CLAUDE_LANE"; then
    case "$override" in
      ollama:*)
        LOCAL_MODEL="${override#ollama:}"
        export LOCAL_MODEL AGENT_MANAGER_FORCE_PROVIDER=local
        HEARTBEAT_MODEL="$LOCAL_MODEL"
        ;;
      claude:*)
        CLAUDE_MODEL="${override#claude:}"
        export CLAUDE_MODEL AGENT_MANAGER_FORCE_PROVIDER=claude
        HEARTBEAT_MODEL="claude:${CLAUDE_MODEL}"
        ;;
      *)
        unset AGENT_MANAGER_FORCE_PROVIDER
        export CLAUDE_MODEL
        HEARTBEAT_MODEL="claude:${CLAUDE_MODEL:-sonnet}"
        ;;
    esac
  else
    unset AGENT_MANAGER_FORCE_PROVIDER
    [[ -n "$override" ]] && LOCAL_MODEL="$override"
    export LOCAL_MODEL
    HEARTBEAT_MODEL="${LOCAL_MODEL:-}"
  fi
}
refresh_active_model

# Refuse to start if a live process already holds this instanceId (agent-manager-common.sh's
# check_instance_liveness, see its own comment) -- the exact duplicate-instance race a manual
# restart racing queue-watchdog's automatic one produces, confirmed live this session (an
# EPIPE crash auto-restarted worker-1 while a second worker-1 was also started manually,
# both racing to claim from the same drafting/worker-1/ folder).
check_instance_liveness "$INSTANCE_ID" || exit 1

# Graceful stop: bash defers a trapped signal until the current foreground command
# (e.g. the node ornith-draft.js call below) returns control to the shell, so this exits
# right after finishing whatever draft is in flight rather than mid-call -- no orphaned
# node child, no half-written task file. stop.sh's SIGTERM-then-grace-period-then-SIGKILL
# handles the case where a single call runs long enough that this isn't fast enough.
trap 'printf "[worker-%s] SIGTERM/SIGINT received -- exiting after current tick.\n" "$INSTANCE_ID" >&2; exit 0' TERM INT

HOME_LOGS="${HOME_LOGS:-$LOG_DIR}"                                                  # HOME_LOGS where we drop per-instance log files; same idea as PowerShell's $env:LocalStatePath/log/$env:InstanceID pattern so multiple runs don't clobber each other.
LOG_FILE="${HOME_LOGS}/ornith-worker-${INSTANCE_ID}.log"          # per-instance log file for daemon status; keeps logs grouped by worker so user can grep / watch progress of specific loop instance without wading through others' output (same pattern as PowerShell's `Start-Transcript -Path $logFile` per-job pattern).

# Infinite polling loop mimicking PowerShell's `while ($true) { ... Start-Sleep -Seconds 60 }` block structure exactly — same design philosophy: simple poll-and-do is easier to debug than event-driven alternatives for file-based state (which agent-manager uses exclusively, not databases or message queues that would benefit from true push mechanisms).
STARTED_AT="$(date -u '+%FT%T.%NZ' 2>/dev/null)"

# Runs the plan -> implement -> critique -> (revision) passes (ornith-draft.js) against a
# task JSON already sitting in queue/drafting/${INSTANCE_ID}/, then files the result into
# queue/review/ or queue/blocked/. Shared by both the freshly-claimed path below and the
# leftover-drafting-file resume pass at the top of each tick -- factored out so a task
# left behind by an interrupted previous run (this worker killed/restarted mid-draft-call,
# which happened repeatedly during 2026-08-14 development) gets processed the exact same
# way a brand-new claim does, not a second, drifted copy of this logic.
process_drafting_file() {
  local wpath="$1"
  local name task_id draft_result draft_succeeded draft_blocked draft_display_model
  name="$(basename "$wpath")"
  task_id="$(node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(o.id||"")}catch(e){}' "$wpath" 2>/dev/null)"

  # Heartbeat's OWN displayed model -- deliberately NOT the same value as draft_label
  # above. Grimmethy, 2026-08-22, after being surprised Claude was rate-limited despite
  # every lane's dashboard override showing a local model: "How is claude getting rate
  # limited? It's not selected as a model to be used at all?" ... "If claude is being used
  # in the background we need to be able to see that." draft_label (labelFor() alone) is
  # right for the LOCK decision (reflects the PLAN pass, the part that can genuinely
  # contend for the local GPU) but WRONG for what a human should see here: an adhoc/
  # research task's real, expensive IMPLEMENT call always goes through Claude regardless
  # of any local-model override (local-draft.js's resolveSourceName()==='adhoc'/domain
  # 'research' bypass -- see that file's own comment), and that's exactly the spend this
  # heartbeat needs to surface, not the override that only ever governed the cheaper plan
  # pass. Recomputed fresh (not derived from draft_label) so it can never silently drift
  # from what draftAdhocImplement/draftResearchImplement will actually do.
  draft_display_model="$(node -e '
    try {
      require(process.argv[1]);
      const { resolveSourceName } = require(process.argv[2]);
      const { labelFor } = require(process.argv[3]);
      const t = JSON.parse(require("fs").readFileSync(process.argv[4], "utf8"));
      const alwaysClaude = resolveSourceName(t) === "adhoc" || t.domain === "research";
      console.log(alwaysClaude ? `claude:${process.env.CLAUDE_MODEL || "sonnet"}` : labelFor(t));
    } catch (e) { /* leave stdout empty -- the bash fallback just below covers this */ }
  ' "${PACKAGE_SRC_DIR}/task-sources.js" "${PACKAGE_SRC_DIR}/task-source-registry.js" "${PACKAGE_SRC_DIR}/model-provider.js" "$wpath" 2>/dev/null)"
  [[ -n "$draft_display_model" ]] || draft_display_model="$HEARTBEAT_MODEL"

  # No bash-level single-flight lock around this call anymore (2026-08-22, Grimmethy:
  # "build [a real plan/implement lock split] now") -- local-draft.js's draftTask() now
  # acquires/releases the SAME real lock itself, per real local-model call, via
  # src/single-flight-lock.js (a Node-native flock fully interoperable with this script's
  # own acquire_single_flight_lock/release_single_flight_lock -- see that module's header
  # for how, and confirmed live via cross-process tests). This is not optional: if bash
  # ALSO held the lock here while the node child tries to acquire the SAME lock itself,
  # the child would deadlock waiting on a lock its own parent holds and won't release
  # until the child exits. Locking now happens ONLY inside JS, scoped to exactly the real
  # local-model calls (plan/implement/critique/revision individually) instead of the
  # whole draft call -- which is what actually fixes the original bug (an adhoc/research
  # task's long real Claude implement call no longer holds this lock at all, since only
  # its plan pass ever touches local Ornith).
  #
  # This does mean the "queued" (waiting on the lock) vs "working" (actively computing)
  # heartbeat distinction added 2026-08-19 is coarser now for this call specifically --
  # bash itself no longer blocks on anything before starting the node process, so real
  # lock-wait time now happens INSIDE the "working" state instead of a separate "queued"
  # one. Accepted tradeoff: the actual wait is now much shorter and more targeted (only
  # around the one real local sub-call that needs it, not the whole draft), so precisely
  # distinguishing it matters less than it did when the whole call used to sit behind it.
  write_heartbeat_file "$INSTANCE_ID" "working" "$draft_display_model" "$task_id" "draft" "$STARTED_AT"
  draft_result="$(node "${PACKAGE_SRC_DIR}/local-draft.js" "$wpath" 2>>"$LOG_FILE")"
  draft_succeeded="$(echo "$draft_result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.succeeded?"true":"false")}catch(e){console.log("false")}')"
  draft_blocked="$(echo "$draft_result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.blocked?"true":"false")}catch(e){console.log("false")}')"

  if [[ "$draft_succeeded" == "true" && "$draft_blocked" == "true" ]]; then
    mkdir -p "${QUEUE_DIR}/blocked" >/dev/null 2>&1
    mv -n "$wpath" "${QUEUE_DIR}/blocked/${name}"
    printf '[worker-%s] blocked %s: %s\n' "$INSTANCE_ID" "$task_id" "$draft_result" >&2
  elif [[ "$draft_succeeded" == "true" ]]; then
    mkdir -p "${QUEUE_DIR}/review" >/dev/null 2>&1
    mv -n "$wpath" "${QUEUE_DIR}/review/${name}"
    printf '[worker-%s] ready for review: %s\n' "$INSTANCE_ID" "$task_id"
  else
    # Draft call itself failed (e.g. Ollama unreachable, or a real generation call timing
    # out under GPU contention) -- retry via the leftover-drafting resume pass at the top
    # of the NEXT tick, but NOT forever: bounded by DRAFT_FAILURE_RETRY_LIMIT, same
    # "bounded retries, then hold for a human" shape reject-retry-check.js's own
    # MaxOrnithRejectRetries already uses for review-stage rejections. Confirmed live
    # 2026-08-20: a single candidate stuck on repeated 240s Ollama timeouts retried every
    # tick for hours with no cap -- and because task-sources.js's hasDraftingWork counts
    # ANY file sitting in drafting/ as backlog regardless of why it's stuck there, this
    # one persistently-failing task silently starved this entire lane's future task
    # generation (including pipeline_self_audit, which only runs when this lane has
    # nothing else to do) the whole time, with no error anywhere that looked like the
    # real cause.
    printf '[worker-%s] draft call failed for %s: %s\n' "$INSTANCE_ID" "$task_id" "$draft_result" >&2
    failure_count="$(node -e '
      const fs = require("fs");
      const p = process.argv[1];
      try {
        const o = JSON.parse(fs.readFileSync(p, "utf8"));
        o.draftFailureCount = (o.draftFailureCount || 0) + 1;
        fs.writeFileSync(p, JSON.stringify(o, null, 2));
        console.log(o.draftFailureCount);
      } catch (e) { console.log(1); }
    ' "$wpath")"
    if [[ "${failure_count:-1}" -ge "${DRAFT_FAILURE_RETRY_LIMIT:-5}" ]]; then
      reason="draft call failed ${failure_count} times in a row (most recent: ${draft_result}) -- giving up rather than retrying every tick forever and starving this lane"
      node -e '
        const fs = require("fs");
        const p = process.argv[1];
        const reason = process.argv[2];
        try {
          const o = JSON.parse(fs.readFileSync(p, "utf8"));
          o.blockedStage = "draft";
          o.blockedReason = reason;
          o.history = o.history || [];
          o.history.push({ stage: "blocked", at: new Date().toISOString(), detail: reason });
          fs.writeFileSync(p, JSON.stringify(o, null, 2));
        } catch (e) { /* best-effort -- the mv below still frees the lane either way */ }
      ' "$wpath" "$reason"
      mkdir -p "${QUEUE_DIR}/blocked" >/dev/null 2>&1
      mv -n "$wpath" "${QUEUE_DIR}/blocked/${name}"
      printf '[worker-%s] giving up on %s after %s failed draft attempts -- moved to blocked/\n' "$INSTANCE_ID" "$task_id" "$failure_count" >&2
    fi
  fi
  write_heartbeat_file "$INSTANCE_ID" "idle" "$HEARTBEAT_MODEL" "" "" "$STARTED_AT"
}

while :; do                                                                     # `while :; do` is bash idiom for 'true/forever' loop — equivalent of PowerShell's `while ($true)` syntax we're matching here. Bash doesn't have boolean literals natively so ':' (the POSIX-no-op command that always returns 0=success) serves as the true condition in loops like this one; identical semantic meaning in practice to while-true block we use elsewhere.
  did_work=false                                                                 # tracks whether this tick actually processed anything -- drives the idle-only backoff at the bottom of the loop (see its own comment). Reset fresh every tick.
  refresh_active_model                                                          # pick up a dashboard model-override change (or its removal) before this tick does any real work -- see the function's own comment above the loop.
  printf '[worker-%s] tick at %s — searching for new drafts...\n' "$INSTANCE_ID" "$(date -u '+%FT%T.%NZ' 2>/dev/null)"    # status message at top of each iteration — same information PowerShell's Write-Verbose emits but using printf for format-safety (avoids issues if variable contents include '%' characters which would be interpreted as string-formatting directives by `echo -e` on some systems, breaking log output).
  write_heartbeat_file "$INSTANCE_ID" "idle" "$HEARTBEAT_MODEL" "" "" "$STARTED_AT"   # so the dashboard's Workers tab sees this instance exists even on a tick that claims nothing -- previously never called anywhere in this script, which is why no workers ever showed up regardless of whether the process was alive.

  mkdir -p "$HOME_LOGS" 2>/dev/null                                              # ensure base home logs dir exists — PowerShell's New-Item creates the folder automatically when it doesn't exist (we mirror that behavior explicitly here because bash's redirection won't auto-create parent dirs the way PS does).
  [[ -r "$HOME_LOGS" ]]                                                          || mkdir -p "$HOME_LOGS"                  # ensure log dir exists (might not have been created yet between launch.sh running and this script actually reaching this step). Same pattern as PowerShell's `$logFolder = if (-not (Test-Path $dir)) { New-Item ... } else { $dir }` conditional creation block which is what we're replacing with simpler shell here.

  # Claude rate-limit gate (agent-manager-common.sh's check_budget_healthy -- see its own
  # comment) -- only the Claude lane needs this: worker-reasoning* instances are the only
  # ones whose claimed/resumed tasks ever route to claude-client.js (the IS_CLAUDE_LANE
  # claim filter above already restricts this lane to high-reasoning-tier tasks, and
  # model-provider.js's providerFor() maps ONLY high-tier tasks to Claude). A low-tier
  # Ornith worker checking this too would wrongly stall local Ornith work every time
  # Claude's account-wide cap is hit, even though it never calls Claude at all -- that's
  # not the bug being fixed here. Gated once per tick, before the resume-drafting pass AND
  # the claim-from-pending loop, since both can reach a Claude call for this lane; skips
  # straight to the budget-gate sleep tier (matching review-runner.ps1/apply-runner.ps1's
  # own 10-minute 'budget' backoff) rather than the normal idle/busy tick interval, so a
  # known rate-limit window doesn't get hammered with a fresh attempt every 30-60s.
  if "$IS_CLAUDE_LANE"; then
    budget_reason="$(check_budget_healthy)"
    budget_rc=$?
    if [[ $budget_rc -ne 0 ]]; then
      printf '[worker-%s] Claude budget not healthy: %s -- skipping this tick.\n' "$INSTANCE_ID" "$budget_reason" >&2
      write_heartbeat_file "$INSTANCE_ID" "idle" "$HEARTBEAT_MODEL" "" "budget" "$STARTED_AT"
      sleep "${ORC_BUDGET_GATE_SECS:-600}"
      continue
    fi
  fi

  # Model-swap-thrashing guard (agent-manager-common.sh's should_yield_for_model_swap --
  # see its own header comment) -- only relevant when THIS tick's real work would call a
  # LOCAL model: always true for the non-reasoning lane (plain Ornith), and true for the
  # reasoning lane only when the dashboard override forced it onto a local model too
  # (AGENT_MANAGER_FORCE_PROVIDER=local, set by refresh_active_model above). A Claude-lane
  # tick calling real Claude never touches Ollama's resident slot, so it's exempt --
  # exactly like the budget gate above, this only matters once local-in-reasoning is
  # actually in use, and is a no-op (state file absent, or target already resident) in the
  # default all-Claude-reasoning config.
  active_locally="true"
  if "$IS_CLAUDE_LANE" && [[ "${AGENT_MANAGER_FORCE_PROVIDER:-}" != "local" ]]; then
    active_locally="false"
  fi
  if [[ "$active_locally" == "true" ]]; then
    target_tier="low"
    "$IS_CLAUDE_LANE" && target_tier="high"
    yield_verdict="$(should_yield_for_model_swap "$LOCAL_MODEL" "$target_tier")"
    if [[ "$yield_verdict" == "yield" ]]; then
      printf '[worker-%s] yielding this tick -- resident model still has pending work in the other tier (see should_yield_for_model_swap).\n' "$INSTANCE_ID" >&2
      sleep "${ORC_TICK_SECS:-30}"
      continue
    fi
    record_active_model "$INSTANCE_ID" "$LOCAL_MODEL" "$target_tier"
  fi

  # GPU headroom check -- before spending any real model call this tick, see whether the
  # GPU actually has room for it and, if not, ask TheAgent to stop a known idle app
  # (ComfyUI/n8n) sitting on VRAM this pipeline doesn't need but isn't using either. Best
  # effort and always exits 0 (see gpu-guard.js's own header) -- a check failing here must
  # never block the tick, same treatment task-sources.js's call below already gets.
  # Confirmed live 2026-08-16: ComfyUI, not run in hours, left 23013/24576MB VRAM used --
  # every ornithCall this tick would have timed out at 240s with no indication why.
  node "${PACKAGE_SRC_DIR}/gpu-guard.js" >>"$LOG_FILE" 2>&1 || true

  # Seed pending/ with a new task if the queue has room to generate one -- ornith-worker.ps1
  # calls this every tick (task-sources.js's own CLI header: "Safe to call on every worker
  # tick"). Previously never called anywhere in this bash port, so pending/ could never
  # receive work regardless of how correct the claim logic below was.
  # >>"$LOG_FILE" (not >/dev/null): this call does real side-effecting work on every tick
  # -- generating a new pending/ task AND deep_dive's lazy lead-onboarding (git clone +
  # build_graph.py against a newly-Strong project_search lead, see task-sources.js's
  # onboardLead()) -- and both can fail in ways worth seeing. Confirmed live 2026-08-14: an
  # onboarding clone failed (project_search wrote a lead with url "N/A", not a real repo)
  # and the real `deep_dive: failed to onboard "...": ...` error task-sources.js logs via
  # console.error was silently discarded here, with no trace anywhere that onboarding had
  # ever been attempted or why Scouted Repos stayed empty despite tasks completing.
  # Runs on BOTH lanes now, each scoped to its own reasoning tier via --tier (Brain Dump
  # #77 follow-up, 2026-08-17) -- previously skipped entirely on the Claude lane, with the
  # (at the time correct) reasoning that only one process should ever be generating new
  # pending/ tasks. That stopped holding once task generation itself became
  # priority-ordered across BOTH tiers in one shared list (path_prefetch_resolve's
  # automatic high-reasoning retry, priority 69, beats arch_discovery/arch_import at
  # 79/80): confirmed live -- worker-1's generation calls kept returning a high-tier retry
  # candidate every single tick (that source's own backlog dominating the priority
  # ladder), which worker-1 then correctly declined to CLAIM, but never got far enough
  # down the ladder to generate any work for ITSELF either, leaving it idle while
  # worker-reasoning did everything. --tier scopes getNextTask() (see its own comment) to
  # skip past a mismatched-tier candidate instead of stopping there, so each lane's own
  # generation call always reaches its own tier's real work if any exists, independent of
  # what the other tier's backlog looks like.
  node "${PACKAGE_SRC_DIR}/task-sources.js" --tier="$( "$IS_CLAUDE_LANE" && echo high || echo low )" >>"$LOG_FILE" 2>&1 || true

  # Resume any task already sitting in THIS instance's own drafting/ folder before claiming
  # anything new -- a claim only ever gets processed by whichever worker process happened
  # to be running at that moment; if that process was killed or crashed mid-draft-call
  # (confirmed live 2026-08-14: repeated worker restarts during that day's development left
  # 16+ tasks claimed but never drafted), nothing previously re-attempted them, since the
  # claim loop below only ever looks at pending/ for NEW work. Matches ornith-worker.ps1's
  # own "orphaned claim: recovered automatically at the next worker startup" behavior,
  # except run every tick (not just at startup) so it also self-heals from an interrupted
  # draft call without a full process restart being needed.
  drafting_instance_dir="${QUEUE_DIR}/drafting/${INSTANCE_ID}"
  if [[ -d "$drafting_instance_dir" ]]; then
    while IFS= read -r name; do
      [[ "$name" == *.json ]]                                                  || continue
      wpath="${drafting_instance_dir}/${name}"
      [[ -f "$wpath" && -s "$wpath" ]]                                        || continue
      printf '[worker-%s] resuming leftover drafting item: %s\n' "$INSTANCE_ID" "$name"
      process_drafting_file "$wpath"
      did_work=true
    done < <(ls -1 "$drafting_instance_dir" 2>/dev/null)
  fi

  # Read pending/ directory listing for work items to claim, PRIORITY-SORTED (fix,
  # 2026-08-22, Grimmethy: "I have it set to priority 65 [staleness_audit]... Staleness
  # audit should be running right now"): task-sources.js's `priority` value (whatever
  # registerTaskSource() was called with, including any AGENT_MANAGER_TASK_PRIORITIES
  # override) had ALWAYS only governed which next*Task() generator runs first when
  # producing a NEW pending/ task -- it had zero effect on the order this claim loop
  # consumes files ALREADY sitting in pending/, which used to be a plain `ls -1`
  # (alphabetical) listing. Normally invisible (pending/ usually holds ~1 item at a time,
  # generated one per tick), but confirmed live the moment pending/ actually held a real
  # backlog (22 tasks, from a bulk requeue): a priority-64 staleness_audit task sat dead
  # last behind priority-81 performance_review tasks purely because
  # "staleness-audit-..." alphabetically sorts after "performance-...". Sorted here by
  # each file's OWN task's resolved source priority (ascending -- lower number = higher
  # priority, same convention task-sources.js's own getRegisteredSources() sort already
  # uses), falling back to mtime (oldest first) to keep FIFO fairness within one priority
  # tier, and Infinity for any file whose task/source can't be resolved (parse failure,
  # unregistered source) -- unsortable is worst-case priority, not silently dropped.
  items=()                                                                      # no `local` here because we're at script scope (not function), so declare without keyword — PowerShell would use just `$items = @()` directly with no type keyword either.
  pdir="$QUEUE_DIR/pending"                                                    # compute pending dir once — matches task-sources.js's own writeTask() destination (queue/pending), not the old bare "pending/" this script used to read from (which task-sources.js never wrote to, so this claim loop always found nothing).

  if [[ -r "$pdir" ]]; then                                                     # check readability before attempting readdir (same safety pattern as PowerShell's Test-Path before foreach — user might have permissions-restricted dir that should be skipped not crash-the-loop).
    while IFS= read -r name; do
      [[ -n "$name" ]] && items+=("$name")
    done < <(node -e '
      try {
        require(process.argv[1]);
        const { getRegisteredSource, resolveSourceName } = require(process.argv[2]);
        const fs = require("fs");
        const path = require("path");
        const dir = process.argv[3];
        const names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
        const ranked = names.map((name) => {
          let priority = Infinity;
          let mtimeMs = 0;
          try {
            const full = path.join(dir, name);
            mtimeMs = fs.statSync(full).mtimeMs;
            const task = JSON.parse(fs.readFileSync(full, "utf8"));
            const source = getRegisteredSource(resolveSourceName(task));
            if (source && typeof source.priority === "number") priority = source.priority;
          } catch (e) { /* unresolvable -- Infinity priority, sorts last, still listed */ }
          return { name, priority, mtimeMs };
        });
        ranked.sort((a, b) => (a.priority - b.priority) || (a.mtimeMs - b.mtimeMs));
        ranked.forEach((r) => console.log(r.name));
      } catch (e) { /* fall through to empty listing -- caller already handles that safely */ }
    ' "${PACKAGE_SRC_DIR}/task-sources.js" "${PACKAGE_SRC_DIR}/task-source-registry.js" "$pdir" 2>/dev/null)

    # Iterate each pending draft, process if ready:
    for name in "${items[@]}"; do                                             # loop over collected filenames one at a time — bash array iteration via `${array[@]}` syntax (each element becomes separate word when quoted). Equivalent of PowerShell's `foreach ($item in $drafts)` which we're mirroring here since both languages use the same conceptual model for "do this to every X in collection".
      wpath="${pdir:?}/$name"                                                     # full path to file being processed — ${pdir?} forces pdir to be defined (prevents silently using empty var that would otherwise expand to /filename with leading slash). We're inside process substitution so pdir is available via outer-shell variable inheritance; bash doesn't strictly enforce this for local scopes but we use ? expansion for safety since typos in $pdir could write files to unexpected locations which would be confusing debugging story.

      if [[ ! -f "$wpath" || ! -s "$wpath" ]]; then                          # skip non-files / empty draft file (likely crashed during partial-write by some other loop; we don't want to process half-written state). PowerShell uses `-File` test operator plus `Test-Path` check for same condition — bash's [[ -f && -s ]] is equivalent shorter form.
        printf '[worker-%s] skipping non-file or empty: %s\n' "$INSTANCE_ID" "$name" >&2    # informational message on stderr since this isn't an actual failure (just a skipped item), but we want operator to see why certain files weren't processed without them thinking something's broken.
        continue;                                                               # next item in for loop; bash continues by default after any test block unless we break/return to exit the whole function — but 'continue' is the right one here since we want this worker-loop overall to keep running, just skip this iteration's work (same semantics of PowerShell's `continue` statement within its foreach which does identical skipping behavior at inner loop level).
      fi

      # Try to parse as JSON using node (we use Node CLI rather than jq because agent-manager's other CLIs run in Node already; keeping same runtime avoids adding system deps).
      task_id=""                                                                 # initialize each fetch attempt fresh — bash doesn't auto-reset variables inside loops so we must explicitly clear each iteration. Same pattern PowerShell uses: $id = ""; try { ... } catch {}; `if ($null -ne $id) {...}` would also work but this more direct form is what we pick here since both equivalent anyway.
      claim_succeeded=false                                                      # default to false until task_id successfully extracted — same design philosophy as PowerShell's `$success = ... ; if($success){...}; continue` flow where initial state starts in "didn't process anything yet" until proven otherwise.
      parsed_payload="$(cat "$wpath" 2>/dev/null)"                             # read file content into shell variable; bash $( command ) captures stdout of subcommand to assign to a var (we use it for small files < few KB which our drafts never exceed). 2>/dev/null redirects any read-error messages OUT of the captured output so operator doesn't see them in normal status log when some draft might be mid-write by another loop at same time.

      if [[ -n "${parsed_payload:-}" ]]; then                                   # check file had content (we don't want to process 0-byte drafts since they'd just run ornith-client on nothing — same safety check as PowerShell's `$content = $file.OpenText().ReadToEnd(); if ($content.Length -gt 0)` block inside foreach. Without this, one empty draft could cause `node: command not found` or similar cascading error message downstream that looks like an orchestrator bug but isn't.
        task_id="$(echo "$parsed_payload" | node -e 'try{var j=JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")); console.log(j.taskId||j.draftId||j.id)}catch(e){}' 2>/dev/null)"    # extract taskId (or fallback draftId, or fallback id -- task-sources.js's writeTask() writes the task's identifier under "id", never "taskId"/"draftId", so those two alone always came back empty) from parsed JSON with node CLI; bash captures stdout back into task_id (was overwriting parsed_payload instead, leaving task_id permanently "" so the -n check below could never pass regardless of what the JSON contained). JSON.parse's second arg was a reviver `(x)=>{throw x}` that unconditionally re-throws every value it's given, so parsing failed for every file regardless of content -- dropped it; JSON.parse needs no reviver here, we just want the plain parsed object. Same semantics as PowerShell's `var id = JSON.parse($json).taskId` except that one-line Node invocation gets redirected into a script context where the parsing logic has no top-level await so we wrap it in try-catch to swallow parse errors (which would otherwise crash this bash worker loop since the exit code non-zero terminates outer while).
        if [[ -n "$task_id" ]]; then                                            # guard: only mark success if some task id came back — same pattern as PowerShell's `$id = $result | ConvertTo-Json -Depth 3 | ... ; if ($null -ne $Id){...}; }'` conditional check that follows the data flow from parsing through to use.
          claim_succeeded=true                                                   # set to true only after successful extraction — mirrors what `try { $ok = true; ... } catch {}; if($ok)...` would do in PowerShell for same intent. We use explicit boolean assignment via string-true/strings-false rather than relying on exit codes being reliable because node's output can silently fail without non-zero exit code (e.g. malformed JSON that returns undefined taskId).
        fi
      fi

      # Parallel Claude worker lane filter (see IS_CLAUDE_LANE's own comment above) --
      # reasoningTierFor() is the SAME function ornith-draft.js/review-task.js already call
      # to pick a backend, so this lane split can never disagree with what actually happens
      # once a task is claimed. The Claude lane claims ONLY high-reasoning-tier tasks;
      # every other lane skips them, leaving them free for the Claude lane to pick up
      # instead of racing for them.
      if "$claim_succeeded"; then
        # reasoningTierFor() reads each source's static reasoningTier off the
        # task-source-registry.js registry (e.g. adhoc's) -- that registry is only
        # populated as a side effect of requiring task-sources.js (its registerTaskSource()
        # calls run at module load), so this MUST be required first in this fresh `node -e`
        # process, or every source would come back with no registered entry and silently
        # fall through to 'low'. Confirmed live 2026-08-17: requiring model-provider.js
        # alone here (mirroring the old resolveSourceName one-liner, which has no such
        # dependency) reported adhoc as 'low' every time.
        resolved_tier="$(echo "$parsed_payload" | node -e 'try{require(process.argv[1]);const {reasoningTierFor}=require(process.argv[2]);const t=JSON.parse(require("fs").readFileSync("/dev/stdin","utf8"));console.log(reasoningTierFor(t))}catch(e){}' "${PACKAGE_SRC_DIR}/task-sources.js" "${PACKAGE_SRC_DIR}/model-provider.js" 2>/dev/null)"
        if "$IS_CLAUDE_LANE"; then
          if [[ "$resolved_tier" != "high" ]]; then
            claim_succeeded=false
          fi
        else
          if [[ "$resolved_tier" == "high" ]]; then
            claim_succeeded=false
          fi
        fi
      fi

      if "$claim_succeeded"; then                                               # actual claim action: rename pending/$name -> drafting/${INSTANCE_ID}/$name (use mv because we don't want to COPY — mv is atomic on same filesystem which prevents race where another loop picks up the same draft after we 'claimed' it). Bash's `mv` works for this; equivalent of PowerShell's `Move-Item -Force` which would do identical work under its file-system abstraction but bash doesn't need `-Force`.
        printf '[worker-%s] claiming %s\n' "$INSTANCE_ID" "$name"               # log that we're about to attempt claim — same kind of status emit as PowerShell's `$null = Write-Host "Processing $draftName"` block which prints progress to operator console so they know daemon IS doing something (otherwise they'd wonder if it hung silently).
        write_heartbeat_file "$INSTANCE_ID" "working" "$HEARTBEAT_MODEL" "$task_id" "claim" "$STARTED_AT"

        mkdir -p "${QUEUE_DIR}/drafting/${INSTANCE_ID}" >/dev/null 2>&1 # ensure destination exists before moving into it — bash's mv doesn't auto-create parent dirs; if we didn't mkdir we'd get 'No such file or directory' error on first claim attempt which would look like daemon failed but actually just meant the folder wasn't created yet (same issue PowerShell hits too and they handle with pre-creation pattern via -Force flag on New-Item).

        orig_name="$name"                                                         # captures current value of $name variable which bash would overwrite on next loop iteration's assignment, same trick PowerShell uses when it stores off the original path in a separate variable before mutating the input.
        new_wpath="${QUEUE_DIR}/drafting/${INSTANCE_ID}/${orig_name}"     # destination file path (same name but moved to drafting/ folder under this instance, matching task-sources.js's own "queue/drafting/<InstanceId>/<id>.json" convention -- was previously "$AGENT_MANAGER_REPO_ROOT/drafting/..." with no queue/ prefix at all, a path nothing else in the system reads from).

        mv -n "$wpath" "$new_wpath"                                                # atomic move: -n flag prevents overwriting target if exists already (same behavior as PowerShell's `Move-Item -NoClobber` for same intent — don't clobber whatever's at destination because could be stale file from previous crashed run which operator would want to investigate before losing).
        printf '[worker-%s] claimed %s -> %s\n' "$INSTANCE_ID" "$wpath" "$new_wpath"     # log claim action with old+new paths — same information PowerShell's `$null = Write-Host "Claimed $src for $dest"` writes but using file redirection operator to send our printf output directly into stderr (which gets captured by launch.sh later via `nohup ... > /dev/null 2>&1 &` and tee'd into HOME_LOGS directory so user can review claim history later in log files even if their terminal is closed or busy).

        # Run the actual plan -> implement -> critique -> (revision) passes against Ornith,
        # via ornith-draft.js (a port of ornith-worker.ps1's equivalent sequence -- see that
        # file's header comment for scope: the 6 domains task-domains.json actually wires up
        # on Linux, not arch_discovery/arch_import's extra structural-check pass). Mutates
        # new_wpath's task JSON in place with pass results and status:"needs-review" on
        # success; leaves task JSON untouched on a thrown error so it isn't corrupted. If
        # THIS process gets killed/restarted before process_drafting_file returns, the
        # leftover-drafting resume pass at the top of the next tick (any instance's next
        # tick, not just this one's) picks the file back up automatically.
        process_drafting_file "$new_wpath"
        did_work=true
      fi

    done                                                                         # end per-filename loop within current tick — bash doesn't auto-close the `for name in "${items[@]}"` scope; 'done' keyword terminates it same way PowerShell closes each block with } or closing brace pattern (we use bash's explicit 'done' syntax which is required).
  fi                                                                            # close if -r "$pdir" conditional check block — same structure as PowerShell's `if (( Test-Path $pending )) { ... }` where body only runs test succeeds; we mirror that with [[ ]] && {} pattern using braces around body.

  # Idle-only backoff: only pay the full poll interval when this tick genuinely found
  # nothing to do. Previously slept the full ORC_TICK_SECS (30s) unconditionally at the
  # end of EVERY tick regardless of whether more work was sitting right there waiting --
  # confirmed live 2026-08-15: a real backlog with tasks completing in well under 30s each
  # still spent the majority of wall-clock time asleep between them, under 50% utilization.
  # A brief sleep even when work was done avoids a true zero-delay busy-loop hammering the
  # filesystem tick after tick when a large backlog is draining.
  if "$did_work"; then
    sleep 1
  else
    sleep "${ORC_TICK_SECS:-60}"                                                   # wait between polls (default: 60s) — same delay PowerShell uses via its `Start-Sleep -Seconds $env:TICK_INTERVAL` inside main daemon loop body (we read from ORC_TICK_SECS env var so user can customize per-instance without editing the script; bash ${VAR:-default} form is exactly that kind of fallback assignment which matches what PowerShell's `$interval = if ($null -ne $env:INTERVAL) { $env:INTERVAL } else { 60}` does for same purpose.
  fi
done                                                                             # end top-level 'while' loop here — bash `do...done` syntax pair; mirror of PowerShell's `while (...){ ... }` curly-brace structure we're replacing (bash has no native boolean true so ':' used as the always-true condition).
