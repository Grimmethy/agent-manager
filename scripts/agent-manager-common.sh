#!/usr/bin/env bash
# Bash port of src/agent-manager-common.ps1 -- shared helpers sourced by ornith-worker.sh,
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
# EPIPE crash auto-restarted ornith-worker.sh worker-1 while a second worker-1 was
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
check_instance_liveness() {
  local instance_id="$1" tick_secs="${2:-30}"
  local hb_path="${INSTANCES_DIR}/${instance_id}.json"
  [[ -f "$hb_path" ]] || return 0

  local stale_secs=$(( tick_secs * 3 ))
  local other_pid
  other_pid="$(node -e '
    const fs = require("fs");
    const [hbPath, myPid, staleSecs] = process.argv.slice(1);
    let hb;
    try { hb = JSON.parse(fs.readFileSync(hbPath, "utf8")); } catch { process.exit(0); }
    if (!hb || !hb.pid || String(hb.pid) === myPid) process.exit(0);
    let alive = true;
    try { process.kill(hb.pid, 0); } catch { alive = false; }
    if (!alive) process.exit(0);
    const ageMs = Date.now() - new Date(hb.lastHeartbeat || 0).getTime();
    if (!(ageMs <= Number(staleSecs) * 1000)) process.exit(0);
    // Still alive and recently heard from -- print its pid (stdout) and signal via exit 1.
    console.log(hb.pid);
    process.exit(1);
  ' "$hb_path" "$$" "$stale_secs")"
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    printf '[%s] refusing to start: instances/%s.json is already claimed by live pid %s (heartbeat within %ss) -- exiting instead of duplicating it. If that process is actually gone (e.g. the machine crashed without cleanup), delete %s and retry.\n' \
      "$instance_id" "$instance_id" "$other_pid" "$stale_secs" "$hb_path" >&2
    return 1
  fi
  return 0
}
