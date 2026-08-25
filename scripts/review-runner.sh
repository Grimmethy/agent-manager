#!/usr/bin/env bash
# Review-daemon: scans queue/review/*.json (tasks local-worker.sh's draft pass has finished, status "needs-review"), invokes review-task.js's Ornith majority-vote gate to approve or block each one. Port of src/review-runner.ps1's 'ornith' review-provider path.

set -u                                                                              # strict mode: catch unset var typos before they surface as confusing errors deep inside daemon logic (PowerShell doesn't have equivalent by default but this is bash best practice).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"                 # locate scripts/ dir so we can reference sibling files regardless of where script was invoked from.

source "${SCRIPT_DIR}/orc-common.sh"                                                  # load shared env loader and config — required first step before any daemon logic since everything depends on AGENT_MANAGER_REPO_ROOT being set correctly (which the .env file provides).
readonly INSTANCE_ID="${1:-review-0}"                                              # default instance id for this review-daemon; same convention as PowerShell's `$env:InstanceID -or 'default'` pattern so logs can be grouped per-review-job.
export AGENT_MANAGER_INSTANCE_ID="$INSTANCE_ID"                                     # so local-client.js (invoked as a node child of this process) can stamp its in-flight lock records with who's holding them -- see model-inflight-lock.js; purely diagnostic, not required for the lock's own correctness.

# Refuse to start if a live process already holds this instanceId -- see local-worker.sh's
# identical call and agent-manager-common.sh's check_instance_liveness for the full rationale.
check_instance_liveness "$INSTANCE_ID" || exit 1

# Claim-the-heartbeat-immediately fix (2026-08-25) -- same race, same fix, as
# local-worker.sh's identical write_heartbeat_file call added right after its own
# check_instance_liveness (see that file's own comment for the full incident: a
# stale pre-restart heartbeat left uncorrected long enough for queue-watchdog's
# dead-process-check to spawn a duplicate instance believing this one was dead).
# This script's own gap before its first heartbeat write (previously at the top of the
# main loop) is smaller than local-worker.sh's, but not zero -- write it here too rather
# than rely on that margin staying small.
write_heartbeat_file "$INSTANCE_ID" "starting" "${LOCAL_MODEL:-}" "" "" "$(date -u '+%FT%T.%NZ' 2>/dev/null)"

# Graceful stop: same reasoning as local-worker.sh's trap -- deferred until the current
# foreground review call returns, so this exits between items rather than mid-vote.
trap 'printf "[review-%s] SIGTERM/SIGINT received -- exiting after current tick.\n" "$INSTANCE_ID" >&2; exit 0' TERM INT

HOME_LOGS="${HOME_LOGS:-$LOG_DIR}"                                                  # HOME_LOGS where we drop per-instance log files (so each daemon writes to its own file in a common folder rather than clobbering one another). Same idea as PowerShell's $env:LocalStatePath/log/$env:InstanceID pattern.
LOG_FILE="${HOME_LOGS}/review-runner-${INSTANCE_ID}.log"          # per-instance log file — keeps reviewer status separate from worker (so operator can grep one without seeing other loops' output mixed in). Same pattern as PowerShell's `Start-Transcript -Path $jobLog` which each daemon script opens for its own status tracking.

mkdir -p "$HOME_LOGS" 2>/dev/null                                                      # ensure logs directory exists before writing to it; bash won't auto-create parent dirs on file write redirects (equivalent of PowerShell's `New-Item -ItemType Directory -Force $logDir` that always runs even if folder already exists — simpler one-liner than Test-Path check first).
LOG_DIR="${LOG_DIR:-$HOME_LOGS}"                                                     # LOG_DIR for script-local use; same fallback pattern as other daemons.

# Infinite polling loop same structure as all daemon scripts: bash 'while : do ... sleep' pattern matches what PowerShell does via while(true){ ... Start-Sleep -Seconds TICK } form in each .ps1 file.
STARTED_AT="$(date -u '+%FT%T.%NZ' 2>/dev/null)"

# Re-read a dashboard model-override for THIS instanceId once per tick (Workers tab
# dropdown, 2026-08-18) -- exports LOCAL_MODEL for this tick so every write_heartbeat_file
# and review-task.js call below picks it up automatically; no per-call-site change needed.
# Reviewer is always Ornith (never Claude), unlike local-worker.sh's two lanes, so this is
# the simpler single-model version of that script's refresh_active_model.
refresh_active_model() {
  local override
  override="$(get_model_override "$INSTANCE_ID")"
  [[ -n "$override" ]] && LOCAL_MODEL="$override"
  export LOCAL_MODEL
}

while :; do                                                                     # infinite iteration until script exits (or is SIGTERM'd by system). Bash doesn't have Python-style 'while True:' so uses ':' no-op as condition which always returns 0=success so loop body executes forever; same semantic effect of PowerShell's `$true` boolean we use above.
  refresh_active_model                                                          # pick up a dashboard model-override change (or its removal) before this tick does any real work.
  printf '[review-%s] tick: scanning queue/review/ for items to review...\n' "$INSTANCE_ID"    # status message echoing what the loop is doing — same info PowerShell logs via `Write-Verbose "Scanning $draftingPath..."`. Using printf not echo so format strings like '%d' don't get interpreted as %d literally (bash's echo sometimes enables escape sequences depending on shell; more portable via printf).
  write_heartbeat_file "$INSTANCE_ID" "idle" "${LOCAL_MODEL:-}" "" "" "$STARTED_AT"   # previously never called anywhere in this script -- the dashboard's Workers tab had no way to know this instance existed even while it was (uselessly) spinning at ~100% CPU.

  review_dir="${QUEUE_DIR}/review"                          # queue/review/ -- the real stage name from task-sources.js's QUEUE_STATES, and where local-worker.sh's own draft pass now files a task once it's ready (status "needs-review"). Was previously scanning queue/drafting/<instance>/ for a needs-review flag local-worker.sh never actually set there -- see git history for that dead end.

  [[ -d "$review_dir" && -r "$review_dir" ]]                                    || { sleep "${ORC_TICK_SECS:-30}"; continue; }    # skip tick if review/ doesn't exist or isn't readable yet (e.g. no draft has ever reached review/) — same defensive early-exit as PowerShell's `if (-not (Test-Path $Drafts) ) { continue }` pattern. Sleep first so this path can't busy-spin.

  # Model-swap-thrashing guard (agent-manager-common.sh's should_yield_for_model_swap) --
  # same guard local-worker.sh's worker-1 lane uses, tier='low' for the same reason: this
  # daemon's own Ornith calls only ever review low-tier items (a high-tier item's vote
  # routes straight to Claude inside review-task.js's own providerFor(task) call,
  # independent of LOCAL_MODEL). No-op when reviewer already shares worker-1's model, the
  # default and common case.
  yield_verdict="$(should_yield_for_model_swap "${LOCAL_MODEL:-}" "low")"
  if [[ "$yield_verdict" == "yield" ]]; then
    printf '[review-%s] yielding this tick -- resident model still has pending work in the other tier.\n' "$INSTANCE_ID" >&2
    sleep "${ORC_TICK_SECS:-30}"
    continue
  fi
  record_active_model "$INSTANCE_ID" "${LOCAL_MODEL:-}" "low"

  # GPU headroom check -- review's own majorityVote call spends real Ollama calls too
  # (n=3 votes per item), same starvation risk local-worker.sh's tick guards against;
  # see gpu-guard.js's header for the live incident this responds to. Best-effort, never
  # blocks the tick.
  node "${PACKAGE_SRC_DIR}/gpu-guard.js" >>"$LOG_FILE" 2>&1 || true

  did_work=false                                                                 # tracks whether this tick actually reviewed anything -- drives the idle-only backoff at the bottom of the loop (see its own comment).
  items=()
  while IFS= read -r name; do
    [[ "$name" == *.json ]]                                                    || continue        # only process JSON files, same filter as local-worker.sh's own claim loop (and same class of bug fixed there: a bare `!` would silently skip every real task file).
    items+=("$name")
  done < <(ls -1tr "$review_dir" 2>/dev/null)   # -t: sort by mtime; -r: reverse (oldest first) -- see this loop's own comment below for why lexical order was wrong.

  # Iterate each item currently sitting in review/, oldest-first BY FILE MTIME (fixed
  # 2026-08-20, Grimmethy: "we need to build this sort of analysis into the daily report"
  # -- the new Queue Health section immediately caught 3 research_task items that had sat
  # in review/ untouched since 2026-08-17, three days, well after the reviewer-starvation
  # fix landed and was confirmed working. Root cause: this used to sort by plain `ls -1`
  # lexical filename order on the theory that "task ids embed a creation timestamp, so
  # lexical order is already chronological" -- true only WITHIN one source's own id
  # scheme, false across different source prefixes: "observability-*" sorts before
  # "research-*" alphabetically regardless of actual age, so a steady stream of newer
  # observability_review items (55 in the last 11h alone) perpetually pushed the 3 much
  # older research items to the back of every single tick's scan. mtime is a real,
  # source-agnostic ordering.) Same "drain the whole backlog before the next tick" choice
  # local-worker.sh's claim loop makes, rather than review-runner.ps1's one-per-invocation
  # pacing (that script relies on its OWN outer loop calling Invoke-ReviewPass again
  # immediately after an 'approved' result; this script's single `while :; do ... sleep
  # 30; done` loop has no equivalent fast-repeat path, so processing the whole snapshot
  # per tick is what keeps a backlog from taking N*30s longer than it needs to).
  for name in "${items[@]}"; do
    file="${review_dir}/${name}"
    [[ -f "$file" && -s "$file" ]]                                             || continue        # skip non-file / empty (likely mid-write by another process) — same safety check local-worker.sh's claim loop uses.

    task_id="$(node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(o.id||"")}catch(e){}' "$file" 2>/dev/null)"

    # Claude rate-limit gate (agent-manager-common.sh's check_budget_healthy). Unlike
    # local-worker.sh's lane-wide gate, this has to be per-item: review/ mixes drafts from
    # both lanes, and review-task.js's own majorityVote call routes through the SAME
    # per-task reasoningTierFor() tier local-draft.js used to draft it (model-provider.js's
    # providerFor()) -- a high-tier item lands here having been drafted by Claude, and its
    # review vote also calls Claude. Skip (don't consume) just this item and leave it in
    # review/ for a later tick if Claude's rate-limited; low-tier items keep reviewing
    # normally regardless, since they never touch Claude.
    # labelFor(), not reasoningTierFor() alone -- AGENT_MANAGER_FORCE_PROVIDER (this
    # script's own refresh_active_model dashboard-override hook) can force a high-tier
    # item onto local Ornith or a low-tier item onto Claude regardless of its registered
    # tier; only labelFor() accounts for that override, so it's the one accurate source
    # for both "will this touch Claude's budget" and "will this touch the local GPU"
    # below.
    resolved_label="$(node -e 'try{require(process.argv[2]);const {labelFor}=require(process.argv[3]);const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(labelFor(t))}catch(e){}' "$file" "${PACKAGE_SRC_DIR}/task-sources.js" "${PACKAGE_SRC_DIR}/model-provider.js" 2>/dev/null)"
    if [[ "$resolved_label" == claude:* ]]; then
      budget_reason="$(check_budget_healthy)"
      budget_rc=$?
      if [[ $budget_rc -ne 0 ]]; then
        printf '[review-%s] Claude budget not healthy: %s -- skipping %s this tick.\n' "$INSTANCE_ID" "$budget_reason" "$task_id" >&2
        continue
      fi
    fi

    printf '[review-%s] reviewing %s\n' "$INSTANCE_ID" "$name" >&2
    # "queued" until the single-flight lock is actually held, then "working" -- see
    # local-worker.sh's process_drafting_file for the full rationale (2026-08-19,
    # Grimmethy: "add the distinct queued status. The current is too unclear").
    write_heartbeat_file "$INSTANCE_ID" "queued" "${LOCAL_MODEL:-}" "$task_id" "review" "$STARTED_AT"

    # Single-flight lock (agent-manager-common.sh's acquire_single_flight_lock -- see its
    # own header) -- ONLY for a low-tier item, whose review vote calls local Ornith and
    # genuinely needs to serialize against every other local GPU call. A high-tier item's
    # review vote routes to Claude (the cloud, no local GPU contention at all) -- taking
    # this lock for it used to mean a Claude review vote sat waiting behind whatever local
    # Ornith call worker-1 happened to be running, and vice versa, purely because they
    # shared one lock with no regard for which physical resource each call actually used.
    # Grimmethy, 2026-08-22: "With the current setup worker-1 and reasoning are taking
    # turns... as is with local only we are losing priority" -- adhoc/high-tier work's
    # priority ranking governs which task a lane picks up, not whether it then has to wait
    # its turn behind unrelated local work once picked. $resolved_label is already
    # computed just above for the budget gate, so this costs nothing extra to check.
    #
    # Keyed by $resolved_label (2026-08-25, root-caused live: this used to acquire the
    # bare, unkeyed global lock while worker-1's OWN local calls (single-flight-lock.js)
    # already used a per-model-keyed one -- two different lockfiles guarding the SAME
    # physical model/GPU, so they never actually serialized against each other. Confirmed
    # live via Ollama's own log: repeated "timed out waiting for llama-server to start:
    # context canceled" -- concurrent load attempts colliding, not a rare/low-cost race
    # the old comment here assumed Ollama would absorb on its own). $resolved_label IS
    # the resolved local model name for a non-Claude item (labelFor()'s own contract),
    # identical in shape to the key local-draft.js's withLockFn already passes -- same
    # model name in, same sanitized lockfile out, on both sides.
    if [[ "$resolved_label" != claude:* ]]; then
      acquire_single_flight_lock "$resolved_label"
    fi
    write_heartbeat_file "$INSTANCE_ID" "working" "${LOCAL_MODEL:-}" "$task_id" "review" "$STARTED_AT"
    review_result="$(node "${PACKAGE_SRC_DIR}/review-task.js" "$file" 2>>"$LOG_FILE")"
    if [[ "$resolved_label" != claude:* ]]; then
      release_single_flight_lock
    fi
    review_succeeded="$(echo "$review_result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.succeeded?"true":"false")}catch(e){console.log("false")}')"
    review_verdict="$(echo "$review_result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.verdict||"")}catch(e){console.log("")}')"

    if [[ "$review_succeeded" == "true" && "$review_verdict" == "approved" ]]; then
      mkdir -p "${QUEUE_DIR}/approved" >/dev/null 2>&1
      mv -n "$file" "${QUEUE_DIR}/approved/${name}"
      printf '[review-%s] approved %s -- queued for apply-task.sh\n' "$INSTANCE_ID" "$task_id"
    elif [[ "$review_succeeded" == "true" && "$review_verdict" == "blocked" ]]; then
      mkdir -p "${QUEUE_DIR}/blocked" >/dev/null 2>&1
      mv -n "$file" "${QUEUE_DIR}/blocked/${name}"
      printf '[review-%s] blocked %s: %s\n' "$INSTANCE_ID" "$task_id" "$review_result" >&2
    else
      # Review call itself failed (unknown domain, Ollama unreachable, etc.) -- leave the
      # file in review/ rather than lose it; it's picked up again next tick. Matches
      # local-worker.sh's own "leave claimed work in place on an unhandled error" choice.
      printf '[review-%s] review call failed for %s: %s\n' "$INSTANCE_ID" "$task_id" "$review_result" >&2

      # 2026-08-23, Grimmethy: "build it" -- same gap local-worker.sh's own draft-call
      # path had before tonight's DRAFT_FAILURE_RETRY_LIMIT fix, just discovered live on
      # the review side: leaving a failed item in review/ forever (with no counter, no
      # bound) means a task whose review call genuinely never succeeds -- not just a
      # transient Ollama blip, but something pathological about THIS task's prompt --
      # retries every single tick, indefinitely, burning a real 3-vote majority attempt
      # each time with no eventual outcome and no visibility. The retry-in-place itself
      # is fine and stays (a transient Ollama timeout SHOULD just succeed on a later
      # tick) -- what was missing is a bound and an eventual give-up, mirroring the
      # draft-call fix's same infra-vs-not distinction and requeue-round budget.
      review_failure_count="$(node -e '
        const fs = require("fs");
        const p = process.argv[1];
        try {
          const o = JSON.parse(fs.readFileSync(p, "utf8"));
          o.reviewFailureCount = (o.reviewFailureCount || 0) + 1;
          fs.writeFileSync(p, JSON.stringify(o, null, 2));
          console.log(o.reviewFailureCount);
        } catch (e) { console.log(1); }
      ' "$file")"

      if [[ "${review_failure_count:-1}" -ge "${REVIEW_FAILURE_RETRY_LIMIT:-5}" ]]; then
        action="$(node -e '
          const fs = require("fs");
          const p = process.argv[1];
          const reviewResult = process.argv[2];
          const failureCount = process.argv[3];
          const infraRequeueLimit = parseInt(process.argv[4], 10) || 3;
          const INFRA_FAILURE_PATTERN = /timed out|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|econnreset|socket hang up|bad gateway|service unavailable|\b50[0-9]\b/i;
          let o;
          try { o = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { console.log("block"); process.exit(0); }
          const isInfra = INFRA_FAILURE_PATTERN.test(reviewResult || "");
          const infraRequeueCount = o.reviewInfraRequeueCount || 0;
          o.history = o.history || [];
          if (isInfra && infraRequeueCount < infraRequeueLimit) {
            o.reviewInfraRequeueCount = infraRequeueCount + 1;
            o.reviewFailureCount = 0;
            o.history.push({
              stage: "requeued",
              at: new Date().toISOString(),
              detail: `review call failed ${failureCount} times in a row on an apparent infra outage (most recent: ${reviewResult}) -- staying in review/ for another round (survived outage round ${o.reviewInfraRequeueCount}/${infraRequeueLimit}) instead of retrying forever unbounded`,
            });
            fs.writeFileSync(p, JSON.stringify(o, null, 2));
            console.log("continue");
          } else {
            const reason = isInfra
              ? `review call failed on an apparent infra outage that did not clear even after ${infraRequeueCount} requeue round(s) -- giving up rather than retrying forever (most recent: ${reviewResult})`
              : `review call failed ${failureCount} times in a row (most recent: ${reviewResult}) -- giving up rather than retrying every tick forever`;
            o.blockedStage = "review";
            o.blockedReason = reason;
            o.history.push({ stage: "blocked", at: new Date().toISOString(), detail: reason });
            fs.writeFileSync(p, JSON.stringify(o, null, 2));
            console.log("block");
          }
        ' "$file" "$review_result" "$review_failure_count" "${REVIEW_INFRA_REQUEUE_LIMIT:-3}")"

        if [[ "$action" == "block" ]]; then
          mkdir -p "${QUEUE_DIR}/blocked" >/dev/null 2>&1
          mv -n "$file" "${QUEUE_DIR}/blocked/${name}"
          printf '[review-%s] giving up on %s after %s failed review attempts -- moved to blocked/\n' "$INSTANCE_ID" "$task_id" "$review_failure_count" >&2
        fi
        # action == "continue": stays in review/, counter reset -- next tick's normal
        # retry-in-place already picks it up again, nothing more to do here.
      fi
    fi
    write_heartbeat_file "$INSTANCE_ID" "idle" "${LOCAL_MODEL:-}" "" "" "$STARTED_AT"
    did_work=true
  done

  # Idle-only backoff: only pay the full poll interval when this tick genuinely found
  # nothing to review. Previously slept the full ORC_TICK_SECS (30s) unconditionally at the
  # end of EVERY tick regardless of whether more items were sitting right there waiting --
  # same utilization problem local-worker.sh's claim loop had (confirmed live 2026-08-15:
  # under 50% uptime on a real backlog whose individual reviews finish well under 30s).
  if "$did_work"; then
    sleep 1
  else
    # Wait N seconds before next scan pass. THIS WAS PREVIOUSLY PLACED AFTER THE LOOP'S
    # CLOSING `done` (dead code, unreachable) -- the loop never paused between ticks and spun
    # at ~100% CPU continuously instead. Moved inside the loop body where it actually runs.
    sleep "${ORC_TICK_SECS:-30}"
  fi
done                                                                              # top-level infinite while-loop terminator — same structure each daemon script follows (infinite polling until SIGTERM / SIGINT interrupts) so all four loops behave consistently when user wants to stop them all at once via launch.sh.
