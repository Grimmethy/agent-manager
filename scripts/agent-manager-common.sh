#!/usr/bin/env bash
# Bash port of src/agent-manager-common.ps1 -- shared helpers sourced by local-worker.sh,
# review-runner.sh, and queue-watcher.sh (apply-task.sh intentionally does not use this --
# see its own header). A bug fix here applies everywhere at once instead of needing to be
# found and reapplied in each daemon separately, same reasoning the .ps1 version documents.
#
# Requires the caller to have already set PACKAGE_SRC_DIR, PIPELINE_DIR, TEMP_DIR, and
# INSTANCES_DIR before sourcing this file -- these functions read those from the caller's
# environment by design, exactly as the PS functions read them from the caller's scope.
# This file only defines functions; it has no side effects of its own when sourced.

# Best-effort DB mirror -- a CONSUMER-owned script (agent-task-db.js), not part of this
# package, living in the consumer's own pipeline dir. The filesystem queue is the working
# state; a DB row is only a durable record a dashboard might read -- a missing script or a
# DB failure must NEVER block or crash the queue loop, hence swallowing all errors here.
invoke_task_db() {
  local event="$1" task_path="$2" extra_json="${3:-}"
  local db_script="${PIPELINE_DIR}/agent-task-db.js"
  [[ -f "$db_script" ]] || return 0
  if [[ -n "$extra_json" ]]; then
    node "$db_script" "$event" "$task_path" "$extra_json" >/dev/null 2>&1 \
      || printf '[common] task-db %s exited non-zero (non-fatal)\n' "$event" >&2
  else
    node "$db_script" "$event" "$task_path" >/dev/null 2>&1 \
      || printf '[common] task-db %s exited non-zero (non-fatal)\n' "$event" >&2
  fi
  return 0
}

# Per-model-call stats DB (model-stats.db) -- ships with this package, unlike
# agent-task-db.js above, so not gated behind a file-exists check. Still non-fatal: a stats
# write must never block the queue loop. $payload_json is a JSON object as a string; written
# to a temp file since model-stats-db.js takes a file path argument, not stdin.
invoke_model_stats_db() {
  local event="$1" payload_json="$2"
  local payload_path
  payload_path="$(mktemp "${TEMP_DIR}/modelstats-XXXXXX.json")"
  printf '%s' "$payload_json" > "$payload_path"
  node "${PACKAGE_SRC_DIR}/model-stats-db.js" "$event" "$payload_path" >/dev/null 2>&1 \
    || printf '[common] model-stats-db %s exited non-zero (non-fatal)\n' "$event" >&2
  rm -f "$payload_path"
  return 0
}

# Reads this instance's model override from dashboard-settings.json's
# workerModelOverrides map -- the Workers tab dropdown (app.py's
# api_set_worker_model) writes there, same file claudeDefaultModel/
# claudeDefaultEffort already live in for the same "takes effect without a
# pipeline restart" reason. Called once per tick (not just at daemon startup)
# by local-worker.sh/review-runner.sh so a dashboard change reaches a running
# worker within one tick. Prints nothing (not even a newline) when unset --
# callers treat empty output as "use the agent-manager.env default".
get_model_override() {
  local instance_id="$1"
  local settings_path="${PACKAGE_SRC_DIR}/../dashboard-settings.json"
  [[ -f "$settings_path" ]] || return 0
  node -e '
    try {
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const v = (d.workerModelOverrides || {})[process.argv[2]];
      if (v) process.stdout.write(String(v));
    } catch (e) {}
  ' "$settings_path" "$instance_id"
}

# Manual "pause Claude" kill switch (2026-08-25 -- see src/claude-pause.js's own header
# for the full rationale: a checkbox in the Workers tab, distinct from budget-monitor.js's
# real rate-limit detection, so a human can proactively stop Claude spend before actually
# hitting their weekly cap). Prints "true" (and only "true") when paused; empty otherwise,
# same boolean-via-stdout convention get_model_override above already uses.
get_claude_paused() {
  local settings_path="${PACKAGE_SRC_DIR}/../dashboard-settings.json"
  [[ -f "$settings_path" ]] || return 0
  node -e '
    try {
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (d.claudePaused === true) process.stdout.write("true");
    } catch (e) {}
  ' "$settings_path"
}

# Single-flight / model-swap-thrashing guard (2026-08-18, Grimmethy: "make sure that all
# the tasks that the currently loaded model has available to them is completed before
# switching to the next model"; widened 2026-08-19, Grimmethy: "it's still running two
# jobs at once. We really need it to do one at a time"). Ollama keeps effectively one
# model resident on typical single-GPU hardware (OLLAMA_MAX_LOADED_MODELS effectively 1
# -- see local-worker.ps1's own comment) and serves it through one execution slot, so
# worker-1, worker-reasoning-when-forced-local, and reviewer are only ever really running
# ONE real call at a time regardless of how many of them THINK they're working. This
# guard makes that true operationally, not just at the Ollama layer: the in-flight-lock
# check below (model-inflight-lock.js) is a strict pipeline-wide mutex -- ANY held lock,
# same model or not, makes every other lane yield this tick -- with the older
# resident-model/pending-backlog heuristic underneath it as a secondary check for the
# gap between calls (the window where nothing is actually in-flight but the resident
# model hasn't finished its tier's backlog yet). Fully inert -- always returns "proceed"
# -- whenever nothing is in flight and either no .active-local-model.json state file
# exists yet, or the caller's own target model already matches whatever's resident.
#
# should_yield_for_model_swap <target_model> <target_tier>
# Echoes "yield" (skip real work this tick, let the resident model's backlog drain first)
# or "proceed". <target_tier> is the reasoningTierFor() tier this caller's OWN local calls
# serve -- 'low' for worker-1 and reviewer (reviewer's Ornith calls only ever review
# low-tier items; high-tier items route straight to Claude inside review-task.js
# regardless of this guard), 'high' for worker-reasoning when forced local.
should_yield_for_model_swap() {
  local target_model="$1" target_tier="$2"

  # REMOVED 2026-08-20 (Grimmethy: "I'm seeing 85 blocked tasks. This hasn't gone down...
  # Has the self audit task been working?"): the in-flight hard-yield gate that used to
  # live here -- "yield if ANY model-inflight-lock.js lock is held, same model or not" --
  # was starving the reviewer outright, not just avoiding GPU thrashing. review-runner.sh
  # calls this check BEFORE ever attempting to claim a review item, every ~30s tick; with
  # worker-1 continuously cycling through a real arch_import backlog (release one lock,
  # claim the next task, re-acquire almost immediately), reviewer's tick landed on "some
  # lock is held" essentially every single time, so it yielded forever -- confirmed live:
  # review-runner.log showed 30+ consecutive "yielding this tick" lines, reviewer sitting
  # idle while queue/review/ grew to 19 items, some multiple DAYS old, nothing ever
  # reaching blocked/done. This check was ALSO always redundant for actual correctness:
  # acquire_single_flight_lock (below) is a real kernel flock, called unconditionally
  # right after this function returns "proceed" in every caller -- it already guarantees
  # true mutual exclusion with no race window, blocking (not polling/yielding) until the
  # current holder releases, which is both correct AND fair (FIFO-ish waiter ordering),
  # unlike this peek-and-bail heuristic. Removing the in-flight gate costs at most a
  # little wasted claim/prep work on the rare tick where a caller ends up blocking on the
  # real lock moments later -- far cheaper than indefinite starvation. The softer
  # different-MODEL heuristic below (genuine VRAM-swap avoidance, not correctness) is
  # unaffected and stays.

  # Live-residency short-circuit (2026-08-23, Grimmethy: dashboard-settings.json's
  # workerModelOverrides let reviewer diverge onto a genuinely different, independently-
  # resident model (e.g. qwen2.5:1.5b) from worker-1/worker-reasoning's shared model --
  # this whole guard predates that per-instance-override feature and was only ever
  # designed for "one shared resident model" (see this function's own comment above: "No-
  # op when reviewer already shares worker-1's model, the default and common case").
  # Caught live: worker-1 and worker-reasoning both yielded to EACH OTHER every single
  # tick once reviewer's recorded model diverged, indefinitely -- because the guard below
  # only ever consults a STALE single-value state file, never asking Ollama whether a
  # swap would actually happen. Confirmed via `ollama ps` that both models were already
  # sitting resident simultaneously (17GB + 1.4GB, comfortably inside VRAM) -- no swap
  # was ever actually at risk, yet the guard kept yielding anyway. If target_model is
  # ALREADY resident right now, this call cannot possibly evict/starve anything by
  # proceeding -- skip the whole stale-state heuristic below and just go.
  local ollama_url="${OLLAMA_URL:-http://localhost:11434}"
  local already_resident
  already_resident="$(node -e '
    const http = require("http");
    const [url, model] = process.argv.slice(1);
    const req = http.get(`${url}/api/ps`, { timeout: 3000 }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const models = (JSON.parse(data).models || []);
          process.stdout.write(models.some((m) => m.name === model || m.model === model) ? "yes" : "no");
        } catch (e) { process.stdout.write("no"); }
      });
    });
    req.on("error", () => process.stdout.write("no"));
    req.on("timeout", () => { req.destroy(); process.stdout.write("no"); });
  ' "$ollama_url" "$target_model" 2>/dev/null)"
  if [[ "$already_resident" == "yes" ]]; then
    echo proceed
    return 0
  fi

  local state_path="${INSTANCES_DIR}/.active-local-model.json"
  [[ -f "$state_path" ]] || { echo proceed; return 0; }
  local resident_model resident_tier
  resident_model="$(node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(d.model||"")}catch(e){}' "$state_path")"
  if [[ -z "$resident_model" || "$resident_model" == "$target_model" ]]; then
    echo proceed
    return 0
  fi
  resident_tier="$(node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(d.tier||"")}catch(e){}' "$state_path")"
  if [[ -z "$resident_tier" ]]; then
    echo proceed
    return 0
  fi
  local counts_json pending_count
  counts_json="$(node "${PACKAGE_SRC_DIR}/task-sources.js" --pending-tier-counts 2>/dev/null)"
  pending_count="$(node -e 'try{const d=JSON.parse(process.argv[1]||"{}");process.stdout.write(String(d[process.argv[2]]||0))}catch(e){process.stdout.write("0")}' "$counts_json" "$resident_tier")"
  if [[ "${pending_count:-0}" -gt 0 ]]; then
    echo yield
  else
    echo proceed
  fi
}

# Pipeline-wide single-flight mutex (2026-08-19, Grimmethy: "it's still running two jobs
# at once. We really need it to do one at a time" -- reported AFTER should_yield_for_
# model_swap's in-flight check above was already widened to treat any held lock, same
# model or not, as a reason to yield). That widening closed the wrong gap: it's a
# check-then-act heuristic with its own race -- two lanes can both read "nothing locked
# yet" and both decide to proceed before either one's advisory lock file (model-
# inflight-lock.js) actually exists, since the check happens once per TICK and the real
# lock isn't written until deep inside the eventual Ollama call, several steps later.
# Confirmed live: two lanes still ended up genuinely concurrent despite the widened
# check. flock is different in kind, not just degree: it's a kernel-enforced exclusive
# lock with no such window -- acquire_single_flight_lock BLOCKS until it can actually
# hold the lock, so there is no gap between "I checked" and "I have it" for another
# process to slip through. Callers wrap ONLY the real model call (local-worker.sh's
# process_drafting_file / review-runner.sh's review-task.js invocation), not the whole
# tick -- claiming a task, GPU-guard, task-generation etc. are all still allowed to run
# concurrently across lanes; only the actual GPU-consuming call is serialized, which is
# the one thing "one job at a time" is actually about.
#
# fd 200 is reserved for this across all three daemons -- picked well above any fd bash
# itself or these scripts' own `node -e` pipelines would ever naturally allocate, and
# distinct from the per-item `{VAR}` auto-allocated fds some node subprocess pipes use
# elsewhere in these scripts, so there's no risk of collision.
SINGLE_FLIGHT_LOCK_FD=200

acquire_single_flight_lock() {
  # 2026-08-24 (Grimmethy: "move the user interaction to the highest priority possible...
  # no matter what other tasks may be in queue, if a user interaction shows up, it's
  # next"): caught live -- a Discuss session waiting on this exact lock lost race after
  # race against worker-1 continuously reclaiming it for its next queued task, and sat
  # for minutes before failing. A held flock genuinely can't be interrupted mid-call (and
  # shouldn't be -- killing a half-finished generation wastes real work), so this can't
  # give Discuss the CURRENT call; what it CAN do is stop this lane from immediately
  # racing to reclaim the lock for its NEXT task the instant the current holder releases.
  # .discuss-waiting/ (Python's single_flight_lock.py drops a per-waiter marker file in
  # here before blocking on its own flock, removes it the moment it actually acquires) is
  # a plain advisory directory, not itself a lock -- a worker/reviewer that sees it
  # non-empty just backs off a few seconds before attempting its own acquire, real
  # headroom for Discuss's already-parked blocking flock() call to win the wakeup race
  # once the current holder lets go. A directory of per-waiter files, not one shared
  # flag, so a second concurrent Discuss session's priority isn't silently cleared the
  # instant the first one gets the lock.
  #
  # Optional $1 key (2026-08-25, root-caused live): single-flight-lock.js's own
  # per-model locking (2026-08-25, same day) switched worker-1/worker-reasoning's real
  # Ollama calls to a MODEL-KEYED lockfile (.pipeline-single-flight.<model>.lock) but
  # this bash function stayed hardcoded to the old global, unkeyed one -- its own header
  # comment called the gap "a known, accepted, low-frequency risk" on the theory that
  # Ollama's own -np 1 slot would still serialize same-model requests as a fallback.
  # Confirmed live that assumption is wrong: reviewer and worker-1 hitting the SAME
  # default model through two DIFFERENT lockfiles produced a real, repeating "timed out
  # waiting for llama-server to start: context canceled" cycle in Ollama's own log --
  # concurrent LOAD attempts collide and cancel each other, not just generation slots,
  # so this was never actually rare or low-cost. Sanitization mirrors single-flight-
  # lock.js's lockFileName() exactly (same regex, same collapsing, same default-to-global
  # when no key given) so both sides compute the IDENTICAL path for the same model name --
  # that identity is the entire mechanism; a bash `sed` step that drifted from the JS
  # regex even slightly would silently recreate this exact bug.
  local key="${1:-}"
  local lockfile
  if [[ -n "$key" ]]; then
    local safe_key
    safe_key="$(printf '%s' "$key" | sed -E 's/[^A-Za-z0-9._-]+/_/g')"
    lockfile="${INSTANCES_DIR}/.pipeline-single-flight.${safe_key}.lock"
  else
    lockfile="${INSTANCES_DIR}/.pipeline-single-flight.lock"
  fi
  local priority_dir="${INSTANCES_DIR}/.discuss-waiting"
  local waited=0
  while [[ -n "$(ls -A "$priority_dir" 2>/dev/null)" && "$waited" -lt "${DISCUSS_PRIORITY_MAX_WAIT_SEC:-8}" ]]; do
    sleep 1
    waited=$((waited + 1))
  done
  eval "exec ${SINGLE_FLIGHT_LOCK_FD}>\"\$lockfile\""
  flock "$SINGLE_FLIGHT_LOCK_FD"   # blocking, exclusive -- waits for the current holder; no -n, no race window.
}

release_single_flight_lock() {
  eval "exec ${SINGLE_FLIGHT_LOCK_FD}>&-" 2>/dev/null || true
}

# record_active_model <instance_id> <model> <tier>
# Declares this instance's model as Ollama's resident one -- call once per tick right
# after should_yield_for_model_swap returns "proceed" and before this tick's real claim/
# draft work, not on a tick that's skipping work entirely, so a stale record can't claim
# residency for a model this process gave up pursuing ticks ago.
record_active_model() {
  local instance_id="$1" model="$2" tier="$3"
  local state_path="${INSTANCES_DIR}/.active-local-model.json"
  node -e '
    const fs = require("fs");
    const [statePath, instanceId, model, tier] = process.argv.slice(1);
    fs.writeFileSync(statePath, JSON.stringify({ instanceId, model, tier, updatedAt: new Date().toISOString() }, null, 2));
  ' "$state_path" "$instance_id" "$model" "$tier"
}

# Redacts likely-credential substrings from text before it's written to a shared log file
# (e.g. Ornith Live Log.md, which can live in a synced SecondBrain vault) -- deep_dive/
# project_search/arch_import embed real third-party content in prompts, and that content
# can legitimately contain a real leaked credential. Pattern list ported verbatim from
# agent-manager-common.ps1's $CredentialLogPatterns. Reads stdin, writes stdout.
protect_log_secrets() {
  node -e '
    const patterns = [
      /\b(sk|key|ak|api[_-]?key)[_-][\w-]{20,}\b/gi,
      /Bearer\s+[\w\-.~+\/]+=*/gi,
      /\b[A-Za-z0-9+\/]{40,}={0,2}\b/g,
      /\bAKIA[A-Z0-9]{16}\b/g,
      /password\s*[:=]\s*\S+/gi,
      /[\w.+-]+@[\w-]+\.[\w.]+:[\S]+/g,
      /\bgh[ps]_[A-Za-z0-9_]{36,}\b/g,
      /\bnpm_[A-Za-z0-9]{36,}\b/g,
      /\bxox[bpas]-[\w-]{10,}\b/g,
      /\b[sr]k_(live|test)_[A-Za-z0-9]{20,}\b/g,
      /\bsk-ant-[\w-]{20,}\b/g,
      /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
      /\b(postgres|mysql|mongodb(\+srv)?|redis):\/\/[^\s]+/gi,
      /\btoken\s*[:=]\s*[\w\-.~+\/]{20,}/gi,
    ];
    let text = require("fs").readFileSync(0, "utf8");
    for (const p of patterns) text = text.replace(p, "[REDACTED]");
    process.stdout.write(text);
  '
}

# Reads a single top-level field from a task JSON file, printing its string value to
# stdout. Prints nothing (not an error) if the file is missing/unparseable/the field is
# absent -- callers treat empty output as "skip this item", same as the .ps1 try/catch-to-
# empty-string pattern.
read_task_field() {
  local path="$1" field="$2"
  node -e '
    try {
      const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const v = o[process.argv[2]];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    } catch (e) {}
  ' "$path" "$field" 2>/dev/null
}

# Writes a task JSON document (given on stdin) to $path, creating the parent directory
# first -- a plain `>` redirect doesn't create missing parent dirs, and queue/review/ not
# existing yet was a real outage class in the PS version for exactly this reason (every
# task that finished its pass sequence died handing its draft to review). Every queue-state
# writer in the three daemon scripts should go through this, not a raw redirect.
write_task_json() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat > "$path"
}

# Mutates a task JSON file in place, adding blockedReason (and optionally blockedStage).
# blockedStage='review' is the ONLY thing queue-watchdog's reject-retry-requeue logic may
# treat as a genuine review-stage rejection -- never infer it from "has ornithVotes" alone
# (an apply-stage failure can still carry votes from an earlier, unrelated successful
# review). This function is the single place that sets it, matching what
# agent-manager-common.ps1's Set-TaskBlockedStage docs require.
set_task_blocked_stage() {
  local path="$1" reason="$2" stage="${3:-}"
  node -e '
    const fs = require("fs");
    const [path, reason, stage] = process.argv.slice(1);
    const o = JSON.parse(fs.readFileSync(path, "utf8"));
    o.blockedReason = reason;
    if (stage) o.blockedStage = stage;
    fs.writeFileSync(path, JSON.stringify(o, null, 2));
  ' "$path" "$reason" "$stage"
}

# True (exit 0) only if this task's blockedStage is exactly 'review'.
test_review_rejection() {
  local path="$1"
  local stage
  stage="$(read_task_field "$path" blockedStage)"
  [[ "$stage" == "review" ]]
}

# Ports Write-HeartbeatFile's stateSince-preservation logic: the same (status,pass,taskId)
# tuple AND the same pid as the previous write keeps the original transition timestamp --
# a stateless per-call writer can only tell "did state change" by reading its own prior
# file back. Any difference (or a missing/unreadable previous file, e.g. first write after
# a restart) resets stateSince to now. Powers the dashboard's "how long in current state"
# tracker (Workers tab).
write_heartbeat_file() {
  local instance_id="$1" status="$2" model="${3:-}" task_id="${4:-}" pass="${5:-}" started_at="${6:-}"
  local hb_path="${INSTANCES_DIR}/${instance_id}.json"
  mkdir -p "$INSTANCES_DIR"
  node -e '
    const fs = require("fs");
    const [hbPath, instanceId, status, model, taskId, pass, startedAt, pid] = process.argv.slice(1);
    const now = new Date().toISOString();
    let stateSince = now;
    try {
      const prev = JSON.parse(fs.readFileSync(hbPath, "utf8"));
      const prevKey = `${prev.status}|${prev.currentPass || ""}|${prev.currentTaskId || ""}`;
      const key = `${status}|${pass}|${taskId}`;
      if (prevKey === key && prev.stateSince && String(prev.pid) === pid) stateSince = prev.stateSince;
    } catch (e) {}
    const hb = {
      instanceId, pid: Number(pid), model: model || null, status,
      currentTaskId: taskId || null, currentPass: pass || null,
      lastHeartbeat: now, stateSince,
    };
    if (startedAt) hb.startedAt = startedAt;
    fs.writeFileSync(hbPath, JSON.stringify(hb, null, 2));
  ' "$hb_path" "$instance_id" "$status" "$model" "$task_id" "$pass" "$started_at" "$$"
}

# Startup liveness check -- adapted from taskmesh's dead-worker detection
# (detectDeadWorkers: check lastHeartbeat against a timeout, mark DEAD, recover) and
# taskforge's companion principle that a lease must comfortably exceed the heartbeat
# interval (scouted-repo survey, 2026-08-16). Refuses to start under an instanceId a
# DIFFERENT, still-alive process already holds, instead of silently overwriting its
# heartbeat and creating a duplicate claimant -- exactly CONTEXT.md's "Duplicate
# instance" entry ("two or more processes sharing the same instanceId... root-caused
# but not yet fixed in code as of 2026-07-19"), watched happen live this session: an
# EPIPE crash auto-restarted local-worker.sh worker-1 while a second worker-1 was
# ALSO started manually, both racing to write instances/worker-1.json and claim from
# the same drafting/worker-1/ folder. write_heartbeat_file (above) still writes
# unconditionally on every tick -- this is a one-time gate at startup only, before the
# main loop's first claim, not a per-tick check (a per-tick check can't prevent the
# race that matters: the SECOND process's first claim, which happens before its first
# heartbeat write).
#
# A stale heartbeat (older than 3x this daemon's own tick interval -- comfortably more
# than one missed tick, matching taskforge's "lease must exceed heartbeat" ratio) or a
# dead pid means the previous holder is gone, not still alive -- takeover proceeds
# normally (logged, not silent) rather than refusing forever on an abandoned file.
# Claude rate-limit gate. budget-monitor.js's isBudgetHealthy() (see that module's own
# header) reads Claude Code's own local transcript for a real rate-limit-hit event -- it
# existed and was already wired into review-runner.ps1/apply-runner.ps1 (both check it
# before spending a pass), but was never ported to any Linux daemon: claude-client.js
# itself has no rate-limit awareness at all (its only retry logic is for degenerate
# output), so nothing here previously stopped a worker/reviewer from repeatedly trying --
# and failing -- to start Claude-backed work while rate-limited, instead of backing off
# until the known reset time. Prints the reason to stdout either way (for the caller to
# log); exit 0 means healthy, exit 1 means back off Claude-backed work this tick. A
# missing script or a monitor failure is treated as healthy (fail open), same "a check
# failing here must never block the tick" rule gpu-guard.js's own header documents --
# this is a budget hint, not a correctness gate.
check_budget_healthy() {
  # Manual pause (2026-08-25 -- see get_claude_paused's own comment) short-circuits
  # BEFORE the real rate-limit check: a deliberate "don't spend tokens right now" must
  # win regardless of whether Claude Code's own transcripts say there's still headroom
  # left -- that's the whole point of a proactive pause versus a reactive rate-limit
  # detector. Every existing caller of this function (the plan-call budget-aware
  # override, worker-reasoning's own whole-tick gate, review-runner.sh's per-item gate)
  # gets pause support for free from this one chokepoint.
  if [[ "$(get_claude_paused)" == "true" ]]; then
    echo "Claude use is manually paused from the Workers tab"
    return 1
  fi
  local budget_script="${PACKAGE_SRC_DIR}/../budget-monitor.js"
  [[ -f "$budget_script" ]] || return 0
  node -e '
    try {
      const { isBudgetHealthy } = require(process.argv[1]);
      const b = isBudgetHealthy();
      console.log(b.reason);
      process.exit(b.healthy ? 0 : 1);
    } catch (e) {
      console.log("budget-monitor.js error (treating as healthy): " + e.message);
      process.exit(0);
    }
  ' "$budget_script"
}

check_instance_liveness() {
  local instance_id="$1"
  local hb_path="${INSTANCES_DIR}/${instance_id}.json"
  [[ -f "$hb_path" ]] || return 0

  # Pure PID liveness -- NOT heartbeat freshness. Confirmed live 2026-08-22: the original
  # version of this function ALSO required the recorded heartbeat to be within
  # tick_secs*3 (90s at the default 30s tick) of now, on top of the pid being confirmed
  # alive via kill(pid,0) -- but write_heartbeat_file only fires at "queued"/"working"/
  # "idle" TRANSITIONS, not continuously while a real call is in flight, and a real
  # draft/review call can legitimately sit in "working" for minutes (adhoc's own
  # ADHOC_TIMEOUT_MS allows up to 900s) without ever touching its heartbeat again. That
  # 90s staleness requirement made this gate WRONGLY treat a process that was still
  # genuinely alive and mid a normal-length real call as gone, letting a second live
  # process start under the SAME instanceId -- confirmed live: two worker-reasoning and
  # two reviewer processes running simultaneously, each independently claiming from the
  # same drafting/<instance>/ folder, which is exactly the fragmented "6 tasks partially
  # drafted instead of one at a time" symptom this was supposed to prevent in the first
  # place. If the recorded pid is confirmed alive, that alone is sufficient reason to
  # refuse a duplicate start here -- deciding whether an alive-but-stuck process should be
  # killed and replaced is dead-process-check.js's own, more careful job (its
  # WORKER_ZOMBIE_THRESHOLD_SECONDS=1200 is deliberately calibrated above the real
  # worst-case call chain, and it SIGKILLs the old pid before spawning a replacement,
  # never leaving two alive at once) -- this function racing ahead with its own,
  # shorter-fused staleness opinion is exactly what caused the duplication.
  local other_pid
  other_pid="$(node -e '
    const fs = require("fs");
    const [hbPath, myPid] = process.argv.slice(1);
    let hb;
    try { hb = JSON.parse(fs.readFileSync(hbPath, "utf8")); } catch { process.exit(0); }
    if (!hb || !hb.pid || String(hb.pid) === myPid) process.exit(0);
    let alive = true;
    try { process.kill(hb.pid, 0); } catch { alive = false; }
    if (!alive) process.exit(0);
    // Still alive -- print its pid (stdout) and signal via exit 1.
    console.log(hb.pid);
    process.exit(1);
  ' "$hb_path" "$$")"
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    printf '[%s] refusing to start: instances/%s.json is already claimed by live pid %s -- exiting instead of duplicating it. If that process is actually gone (e.g. the machine crashed without cleanup), delete %s and retry.\n' \
      "$instance_id" "$instance_id" "$other_pid" "$hb_path" >&2
    return 1
  fi
  return 0
}
