#!/usr/bin/env bash
# worker-review-stage.sh — HUB0168 · 1/4 · Extract review stage into a sourced helper module.
#
# Self-contained, SOURCEABLE shell helper that implements ONE review tick: claim an item
# from queue/review/ (the same atomic mkdir-claim protocol review-runner.sh uses, so a
# still-running reviewer daemon and a lane worker can't double-review the same file), hold
# the endpoint-keyed single-flight GPU lock (localOllamaLockKey -- the ONE key definition
# in src/lib/ollama-lock-key.js, the same key src/gpu-arbiter.js keys its tickets/flock by,
# so this serializes against every other local-model caller on the same Ollama endpoint),
# invoke the fresh-vote-context path in src/review-task.js (its `node review-task.js
# <review.json>` CLI, the Ornith majority-vote gate), and write the approve/block move +
# bounded-retry history entries.
#
# Written as a fresh module rather than an in-place edit of local-worker.sh so it can be
# landed and reviewed independently: sibling task HUB0168 · 2/4 wires it into the worker
# tick loop with exactly
#
#     source scripts/worker-review-stage.sh
#     worker_review_stage || true
#
# and nothing else.
#
# Return codes (one call == one tick; the caller decides when to invoke it):
#   0  processed/reviewed an item this tick (approve, block, forge-pause hold, or a
#      bounded-retry outcome) -- the caller should re-check promptly (review-runner.sh
#      sleeps 1s after a productive tick for the same reason)
#   1  nothing reviewable in queue/review/ this tick (empty or missing dir)
#   2  yielding this tick: PromptForge holds the GPU (comfyui-lease) or host RAM pressure
#
# Top level contains ONLY this header comment, one variable assignment (double-source
# guard), and the single function definition below -- no side effects on source, so it is
# safe to source once at worker startup and call on every tick. All daemon env (QUEUE_DIR,
# INSTANCES_DIR, PACKAGE_SRC_DIR, the single-flight lock + heartbeat helpers) comes from
# orc-common.sh, which this file sources lazily INSIDE the function the first time, so a
# worker that has already sourced orc-common.sh (local-worker.sh does) does not pay for it
# twice and a standalone test harness can source this file bare.
_WRST_SOURCED=1

worker_review_stage() {
  # --- lazy env load: everything below needs orc-common.sh (and thus
  # agent-manager-common.sh's acquire/release_single_flight_lock, write_heartbeat_file,
  # comfyui_lease_held, mem_pressure_high). Already-loaded -> no-op.
  if ! declare -F acquire_single_flight_lock >/dev/null 2>&1 || [[ -z "${QUEUE_DIR:-}" ]]; then
    _WRST_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck disable=SC1091
    source "${_WRST_SCRIPT_DIR}/orc-common.sh"
  fi

  # Per-instance identity + log file: the CALLING worker's own INSTANCE_ID (local-worker.sh
  # sets both INSTANCE_ID and AGENT_MANAGER_INSTANCE_ID), with a stable fallback if this is
  # invoked outside a worker loop (e.g. a test harness). Same per-instance log convention
  # review-runner.sh uses (one file per instance under HOME_LOGS).
  local instance_id log_file
  instance_id="${AGENT_MANAGER_INSTANCE_ID:-${INSTANCE_ID:-worker-review}}"
  export AGENT_MANAGER_INSTANCE_ID="$instance_id"
  log_file="${HOME_LOGS:-${LOG_DIR}}/worker-review-stage-${instance_id}.log"
  mkdir -p "${HOME_LOGS:-$LOG_DIR}" 2>/dev/null

  # --- tick guards: yield (return 2) while PromptForge holds the GPU (comfyui-lease) or
  # host RAM is exhausted -- the SAME two yields review-runner.sh performs at the top of
  # its tick, so a worker review tick never contends with a Forge session it would just
  # be paused for anyway. GPU headroom check is best-effort, never blocks the tick.
  if comfyui_lease_held "${OLLAMA_URL:-http://localhost:11434}"; then
    printf '[worker-%s] review stage: yielding -- PromptForge holds the GPU (comfyui-lease).\n' "$instance_id" >&2
    return 2
  fi
  if mem_pressure_high; then
    printf '[worker-%s] review stage: yielding -- host RAM pressure.\n' "$instance_id" >&2
    return 2
  fi
  node "${PACKAGE_SRC_DIR}/gpu-guard.js" >>"$log_file" 2>&1 || true

  # --- claim: oldest-by-mtime item in queue/review/ (same ls -1tr ordering review-runner.sh
  # and local-worker.sh use; mtime, not lexical, so mixed-source backlogs drain oldest-first).
  local review_dir name file
  review_dir="${QUEUE_DIR}/review"
  [[ -d "$review_dir" && -r "$review_dir" ]] || return 1
  name="$(ls -1tr "$review_dir" 2>/dev/null | grep -E '\.json$' | head -n1)"
  [[ -n "$name" ]] || return 1
  file="${review_dir}/${name}"
  [[ -f "$file" && -s "$file" ]] || return 1   # empty == likely mid-write by another process

  # Atomic per-item claim under the instances dir (verbatim protocol from review-runner.sh's
  # claim_review_item, 2026-10-18): a live owner pid OR a claim younger than 3 h wins;
  # otherwise the claim is stale and taken over. Held until the function returns -- the
  # approve/block move below completes before release, so there is no re-review window.
  local claim_dir claim d owner_pid age
  claim_dir="${INSTANCES_DIR}/review-claims"
  claim="${claim_dir}/${name}.d"
  d="${claim}"
  mkdir -p "$claim_dir" 2>/dev/null
  if ! mkdir "$d" 2>/dev/null; then
    owner_pid="$(awk '{print $1}' "${d}/owner" 2>/dev/null)"
    age=$(( $(date +%s) - $(stat -c %Y "$d" 2>/dev/null || echo 0) ))
    if [[ -n "$owner_pid" ]] && kill -0 "$owner_pid" 2>/dev/null && (( age < 10800 )); then
      printf '[worker-%s] review stage: %s is claimed by a live lane -- skipping this tick\n' "$instance_id" "$name" >&2
      return 1
    fi
    rm -rf "$d"
    mkdir "$d" 2>/dev/null || { printf '[worker-%s] review stage: lost the claim race for %s\n' "$instance_id" "$name" >&2; return 1; }
  fi
  printf '%s %s\n' "$$" "$instance_id" > "${d}/owner"
  # Guarantee the claim goes away even on an early error path below (the caller's own
  # shell may have its own EXIT trap; this one is scoped to THIS function's subshell-free
  # path via an explicit release at every return that matters -- the moves complete before
  # the releases at the bottom, same order review-runner.sh's trap+release_current_claim use).
  local _wrst_claim_released=false
  _wrst_release_claim() {
    [[ "$_wrst_claim_released" == true ]] && return 0
    _wrst_claim_released=true
    rm -rf "$claim" 2>/dev/null
  }
  trap '_wrst_release_claim' RETURN 2>/dev/null || true

  [[ -f "$file" && -s "$file" ]] || { _wrst_release_claim; return 1; }   # it moved between listing and claim

  local task_id
  task_id="$(node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(o.id||"")}catch(e){}' "$file" 2>/dev/null)"

  printf '[worker-%s] reviewing %s\n' "$instance_id" "$name" >&2
  # "queued" until the single-flight lock is actually held, then "working" -- same two-phase
  # heartbeat local-worker.sh's process_drafting_file uses (2026-08-19).
  write_heartbeat_file "$instance_id" "queued" "${LOCAL_MODEL:-}" "$task_id" "review" "$(date -u '+%FT%T.%NZ' 2>/dev/null)"

  # --- lock: the endpoint-keyed single-flight lock (review-runner.sh's review_lock_key,
  # 2026-10-21): localOllamaLockKey() from src/lib/ollama-lock-key.js -- the ONE definition
  # src/gpu-arbiter.js's tickets/flock also key by, so this review serializes against every
  # other local-model call (worker drafts, chat) on the same Ollama endpoint. Fall back to
  # the model-name key only if node cannot run the helper, so a failure here never blocks.
  local lock_key review_result review_succeeded review_verdict
  lock_key="$(node -e 'process.stdout.write(require(process.argv[1]).localOllamaLockKey())' "${PACKAGE_SRC_DIR}/lib/ollama-lock-key.js" 2>/dev/null)"
  lock_key="${lock_key:-${LOCAL_MODEL:-}}"

  # Bounded-wait acquire (agent-manager-common.sh's own timeout); on timeout synthesize the
  # SAME "timed out" infra-failure result review-runner.sh does, so it takes the identical
  # bounded requeue-round path below instead of hanging.
  if acquire_single_flight_lock "$lock_key"; then
    write_heartbeat_file "$instance_id" "working" "${LOCAL_MODEL:-}" "$task_id" "review" "$(date -u '+%FT%T.%NZ' 2>/dev/null)"
    review_result="$(node "${PACKAGE_SRC_DIR}/review-task.js" "$file" 2>>"$log_file")"
    release_single_flight_lock
  else
    printf '[worker-%s] single-flight lock timed out for %s -- treating as an infra failure instead of hanging further.\n' "$instance_id" "$task_id" >&2
    review_result="lock acquisition timed out waiting for the single-flight lock"
  fi

  # --- verdict: review-task.js's single-line JSON contract ({succeeded, verdict, ...}).
  review_succeeded="$(echo "$review_result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.succeeded?"true":"false")}catch(e){console.log("false")}')"
  review_verdict="$(echo "$review_result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.verdict||"")}catch(e){console.log("")}')"

  if [[ "$review_succeeded" == "true" && "$review_verdict" == "approved" ]]; then
    mkdir -p "${QUEUE_DIR}/approved" >/dev/null 2>&1
    mv -n "$file" "${QUEUE_DIR}/approved/${name}"
    printf '[worker-%s] approved %s -- queued for apply-task.sh\n' "$instance_id" "$task_id"
  elif [[ "$review_succeeded" == "true" && "$review_verdict" == "blocked" ]]; then
    mkdir -p "${QUEUE_DIR}/blocked" >/dev/null 2>&1
    mv -n "$file" "${QUEUE_DIR}/blocked/${name}"
    printf '[worker-%s] blocked %s: %s\n' "$instance_id" "$task_id" "$review_result" >&2
  elif grep -qE "the Forge family holds the GPU" <<< "$review_result"; then
    # Forge GPU session (2026-10-14): deliberate open-ended pause -- NO failure count, NO
    # requeue round, NO block; the item stays in review/ and is picked up once the lease
    # clears (mirrors review-runner.sh's identical branch; the pattern is FORGE_PAUSE_MESSAGE).
    printf '[worker-%s] review paused for a Forge GPU session -- not counted as a failure; %s stays in review/\n' "$instance_id" "$task_id" >&2
  else
    # Review call itself failed (unknown domain, Ollama unreachable, etc.) -- leave the file
    # in review/ with the SAME bounded retry-then-give-up + history-entry logic
    # review-runner.sh added 2026-08-23/26/09-05 (verbatim node body, kept in sync):
    # REVIEW_FAILURE_RETRY_LIMIT consecutive failures, then either an infra-outage requeue
    # round (bounded by REVIEW_INFRA_REQUEUE_LIMIT, counter reset, "requeued" history entry,
    # item stays in review/) or a final "blocked" history entry + move to queue/blocked/.
    local review_failure_count action
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
        // Kept in sync with local-worker.sh / review-runner.sh own identical copies --
        // the 2026-08-26 zero-output-is-infra rule and the 2026-09-05 model-404 pattern
        // apply identically to a review call from the worker lane.
        const INFRA_FAILURE_PATTERN = /timed out|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|econnreset|socket hang up|bad gateway|service unavailable|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|model \x27[^\x27]*\x27 not found|\b50[0-9]\b/i;
        let o;
        try { o = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { console.log("block"); process.exit(0); }
        const isInfra = INFRA_FAILURE_PATTERN.test(reviewResult || "") || !(reviewResult || "").trim();
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
        printf '[worker-%s] giving up on %s after %s failed review attempts -- moved to blocked/\n' "$instance_id" "$task_id" "$review_failure_count" >&2
      fi
      # action == "continue": stays in review/, counter reset -- the worker's next review
      # stage invocation already picks it up again, nothing more to do here.
    fi
  fi

  write_heartbeat_file "$instance_id" "idle" "${LOCAL_MODEL:-}" "" "" "$(date -u '+%FT%T.%NZ' 2>/dev/null)"
  _wrst_release_claim
  return 0
}
