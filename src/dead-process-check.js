'use strict';

// Dead-process detection: decides which pipeline daemon instances (by their instances/*.json
// heartbeat file) look dead and need restarting. Port of queue-watchdog.ps1's
// Invoke-DeadProcessCheck DECISION logic only -- the actual OS-level kill/restart/pidfile
// bookkeeping stays in bash (queue-watcher.sh), matching how the rest of this pipeline
// splits "decide" (Node, easy JSON/logic) from "do" (bash, native process control) --
// same division apply-task.sh/apply-task.js already use.
//
// Not ported from the reference: the stray-process reaper (Invoke-StrayProcessReap) --
// that targets Windows-specific failure modes (a lingering `powershell.exe -NoExit` host
// surviving its own script's crash, orphaned `llama-server.exe` VRAM squatters after a
// killed Ollama server) that don't have a direct Linux equivalent in how these bash
// daemons or the systemd-managed Ollama service actually fail here.
//
// CLI: node dead-process-check.js
// Writes newline-delimited JSON to stdout, one action object per line (easier for
// queue-watcher.sh to iterate than a single JSON array would be):
//   { instanceId, pid, action: 'restart'|'restart-after-kill'|'flag', reason, script, args, pidfileName }
// 'flag' means "looks dead but no restart rule matches this instanceId" -- log only.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

const STALE_HEARTBEAT_SECONDS = 300; // 5 min -- comfortably above local-client.js's 4-min REQUEST_TIMEOUT_MS per-call ceiling.
// worker-only: pid alive but heartbeat stale this long means a hung call, not a slow one.
// draftTask() (local-draft.js) chains up to 4 sequential localCall()s per task -- plan,
// implement, critique, and (if critique flags issues) revise -- each individually bounded
// by local-client.js's REQUEST_TIMEOUT_MS (240s default), with no heartbeat write between
// passes. Worst case is therefore ~4*240s=960s of legitimate, non-hung work between the
// "working" heartbeat at claim time and the "idle" heartbeat at completion. The old 300s
// value only covered a single call and was killing every multi-pass task mid-flight,
// confirmed live 2026-08-16: worker-1 was SIGKILL'd and restarted by the watchdog roughly
// every 5 minutes for hours straight, re-starting the same leftover drafting/ tasks from
// scratch each time (no partial-pass checkpointing) and never completing one.
// reviewer-only: review-task.js's own single majorityVote() call (n=3 votes) now retries
// each vote's call() up to maxRetries=1 (2 attempts) after 2026-08-23's fix for a
// different bug (a single vote's hard failure no longer aborts the whole review -- see
// local-client.js's own header on that commit). Worst case is therefore up to 3*2=6
// sequential real network calls, each individually bounded by the same 240s ceiling draft
// uses, before review-task.js finally reports failure: 6*240s=1440s -- ALREADY above the
// 1200s value this constant used to be sized to, which would have started zombie-killing
// a reviewer instance genuinely still working through its own new (and correct) retry
// budget, the exact same SIGKILL-loop failure mode the comment above documents for
// draft's own worst case. Sized to the LARGER of the two chains (review's 1440s, not
// draft's 960s) plus the same 240s slack margin the original value used.
const WORKER_ZOMBIE_THRESHOLD_SECONDS = 1680; // 28 min -- comfortably above review's real ~1440s worst-case chain (the larger of the two), not a single call.
const RESTART_COOLDOWN_SECONDS = 120; // don't re-restart the same instanceId again this soon -- a fresh replacement's own first heartbeat can take a moment to land.

// instanceId -> { script, args, pidfileName } -- mirrors launch.sh's own hardcoded
// start_bg() invocations exactly (the actual source of truth for how each instance is
// named/launched on this Linux port), not a generic pattern-match table the way the
// reference's $RESTART_MAP is -- this deployment only ever creates a small, fixed set of
// instances, so there's no real "any worker-N" generality to preserve beyond the one
// literal worker-1 already handles via the worker- prefix check below.
function restartTargetFor(instanceId) {
  if (instanceId.startsWith('worker-')) {
    return { script: 'local-worker.sh', args: [instanceId], pidfileName: `${instanceId}.pid` };
  }
  if (instanceId === 'reviewer') {
    return { script: 'review-runner.sh', args: ['reviewer'], pidfileName: 'review-runner.pid' };
  }
  return null; // no rule -- e.g. 'watchdog' (never restarts itself) or an unrecognized instanceId.
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check only, doesn't actually signal the process.
    return true;
  } catch (e) {
    return false;
  }
}

function readCooldowns(cooldownPath) {
  try {
    return JSON.parse(fs.readFileSync(cooldownPath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeCooldowns(cooldownPath, cooldowns) {
  fs.mkdirSync(path.dirname(cooldownPath), { recursive: true });
  fs.writeFileSync(cooldownPath, JSON.stringify(cooldowns));
}

function deadProcessCheck({ instancesDir, cooldownPath, now = Date.now() }) {
  const actions = [];
  let names = [];
  try {
    // Real heartbeat files are always named "<instanceId>.json" with no leading dot
    // (worker-1.json, reviewer.json, watchdog.json, ...). instances/ also holds non-
    // heartbeat state files that happen to end in .json -- .active-local-model.json (the
    // model-swap-thrashing guard's own state, agent-manager-common.sh's record_active_model)
    // and .watchdog-restart-cooldown.json (this module's own cooldown bookkeeping, written
    // a few lines below) -- both by convention dot-prefixed specifically so they're not
    // mistaken for a real instance here. Before this filter, .active-local-model.json was
    // getting read as a heartbeat: it has an `instanceId` field (whichever worker last
    // recorded model residency) but no `lastHeartbeat`/`pid`, so `new Date(undefined)` ->
    // NaN age and undefined pid -> isProcessAlive(undefined) -> false, which looked exactly
    // like "process confirmed gone" for a perfectly healthy worker -- confirmed live
    // 2026-08-19: repeated spurious "restarted worker-reasoning (was pid , ... heartbeat
    // stale NaNs)" restarts, every time that state file's instanceId matched a real,
    // already-alive worker, producing a duplicate process the startup liveness check then
    // had to reject (agent-manager-common.sh's check_instance_liveness) -- harmless once
    // rejected, but a needless spawn/reject cycle roughly every watchdog tick.
    names = fs.readdirSync(instancesDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch (e) {
    console.warn(`[dead-process-check] readdirSync failed for ${instancesDir}: ${e.code ?? e.message}`);
    return actions;
  }

  const cooldowns = readCooldowns(cooldownPath);
  let cooldownsChanged = false;

  for (const name of names) {
    try {
      const hb = JSON.parse(fs.readFileSync(path.join(instancesDir, name), 'utf8'));
      if (hb.instanceId === 'queue-watchdog') continue; // never watch ourselves.

      const ageSeconds = (now - new Date(hb.lastHeartbeat).getTime()) / 1000;
      if (ageSeconds < STALE_HEARTBEAT_SECONDS) continue; // recently updated, fine.

      const pidAlive = isProcessAlive(hb.pid);
      const isWorker = hb.instanceId.startsWith('worker-');
      const isZombie = pidAlive && isWorker && ageSeconds >= WORKER_ZOMBIE_THRESHOLD_SECONDS;

      if (pidAlive && !isZombie) continue; // still alive, just a slow single call (or a non-worker instance, which keeps the strict PID-gate).

      const lastRestart = cooldowns[hb.instanceId];
      if (lastRestart && (now - lastRestart) / 1000 < RESTART_COOLDOWN_SECONDS) continue; // a just-launched replacement may not have its first heartbeat yet.

      const target = restartTargetFor(hb.instanceId);
      if (!target) {
        actions.push({ instanceId: hb.instanceId, pid: hb.pid, action: 'flag', reason: `stale ${Math.round(ageSeconds)}s, pid ${pidAlive ? 'alive' : 'gone'}, no restart rule matches` });
        continue;
      }

      actions.push({
        instanceId: hb.instanceId,
        pid: hb.pid,
        action: isZombie ? 'restart-after-kill' : 'restart',
        reason: isZombie ? `zombie: pid lingered but heartbeat stale ${Math.round(ageSeconds)}s` : `process confirmed gone, heartbeat stale ${Math.round(ageSeconds)}s`,
        script: target.script,
        args: target.args,
        pidfileName: target.pidfileName,
      });
      cooldowns[hb.instanceId] = now;
      cooldownsChanged = true;
    } catch (e) {
      console.warn(`[dead-process-check] skipping unreadable heartbeat: ${name} -- ${e.message}`);
      // Unreadable/mid-write heartbeat file -- skip it this pass, same "don't let one bad
      // file stop the rest" treatment the reference gives this per-item try/catch.
    }
  }

  if (cooldownsChanged) writeCooldowns(cooldownPath, cooldowns);
  return actions;
}

// Orphaned model-call child process detection (2026-08-24, pipeline hardening --
// Grimmethy: "that going looking needs to be an automated process"). Caught live: killing
// a worker daemon's own bash loop (e.g. to pick up a code fix) does NOT kill its
// in-flight `node local-draft.js` child -- that process just keeps running, one seen
// stuck 11+ minutes, still holding the GPU single-flight lock, silently blocking every
// NEW draft call pipeline-wide with no error anywhere. dead-process-check.js above
// already handles "this daemon INSTANCE looks dead, restart it" via heartbeat staleness;
// this is the complementary case its own heartbeat mechanism can't see at all -- the
// PARENT is confirmed gone, but a CHILD it spawned is still alive and unaccounted for.
//
// Detection is the standard, portable Unix orphan signal: when a parent process dies,
// its children are re-parented to PID 1 (the init/reaper process) rather than being
// killed automatically. A `node local-draft.js` process with ppid===1 is therefore, by
// construction, no longer under ANY daemon's control -- there is no legitimate
// "in-flight call the current worker is waiting on" story for it, since a live worker's
// real in-flight call always has that worker's own bash PID as its parent. No heartbeat
// cross-referencing needed (and none attempted) -- ppid===1 alone is sufficient and
// avoids the fragile alternative of trying to match a specific expected PPID across
// bash's own subshell/command-substitution process nesting.
//
// Killing an orphan is unambiguously safe: by definition nothing is waiting on its
// result (its own parent, the only thing that could have been, is gone), and the task
// file it was working from is untouched on disk, so a fresh worker claim just starts a
// real new attempt -- same "always reversible, never lose real queued work" property
// dead-process-check.js's own daemon restarts already have.
const MODEL_CALL_SCRIPT_RE = /\blocal-draft\.js\b/;

function listProcessesWithPpid() {
  const { execFileSync } = require('child_process');
  const out = execFileSync('ps', ['-eo', 'pid,ppid,cmd', '--no-headers'], { encoding: 'utf8' });
  return out.split('\n').map((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null;
  }).filter(Boolean);
}

// 2026-08-26 (Grimmethy: "Please look at the watchdogs restart mechanism" -- an 8.5-hour
// stuck-lock incident this investigates). CORRECTED assumption: this used to filter on
// `p.ppid === 1`, on the theory that a dead parent's child always reparents to true init.
// Confirmed live this box does NOT reparent orphans to PID 1 -- it runs under a
// `systemd --user` session, which (like most modern desktop/session-managed Linux setups)
// acts as its own subreaper, so an orphan lands on that session's own scope/manager
// process instead. That process is itself NOT permanent (confirmed live: the one from
// this exact incident, PPID 902699, was ALSO gone by the time this was diagnosed), so
// hardcoding any single "the real reaper is PID X" assumption would just move the same
// bug rather than fix it. This never fired ONCE across an entire 8.5-hour incident that
// it exists specifically to catch (44 accumulated zombie local-worker.sh loops, each with
// its own stuck local-draft.js child, none ever reparented to 1) -- confirmed live via
// `ps -ejH` during the incident: every stuck child's ppid was 902699, never 1.
//
// Robust fix: don't guess the reaper's identity at all. A `local-draft.js` process is
// legitimate exactly when SOME currently-alive worker daemon's own heartbeat file
// records it as that worker's real child (heartbeat.pid === the child's ppid, since a
// worker's own bash `$$` never changes across its lifetime, including while its child is
// running). Anything else -- ppid 1, ppid some other now-dead reaper, ppid a completely
// unrelated live process -- has, by construction, no live worker that considers it "my
// current in-flight call," which is the actual property this function has always cared
// about (see this section's own header comment above).
function currentWorkerHeartbeatPids(instancesDir) {
  const pids = new Set();
  let names;
  try {
    names = fs.readdirSync(instancesDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch (e) {
    return pids; // instances/ unreadable -- best-effort, same as deadProcessCheck() above.
  }
  for (const name of names) {
    try {
      const hb = JSON.parse(fs.readFileSync(path.join(instancesDir, name), 'utf8'));
      if (hb.instanceId && hb.instanceId.startsWith('worker-') && hb.pid) pids.add(hb.pid);
    } catch (e) {
      // Unreadable/mid-write heartbeat file -- skip it this pass, same per-item tolerance
      // deadProcessCheck() already gives this exact class of file.
    }
  }
  return pids;
}

// 2026-08-26, same day as the fix above: that fix was ITSELF broken. `p.ppid` is the
// immediate parent only, but a worker script invokes local-draft.js as
// `draft_result="$(node local-draft.js ...)"` -- bash `$(...)` command substitution always
// forks an intermediate subshell to run the command, so the node process's REAL kernel
// ppid is that ephemeral subshell's own pid, never the worker script's own `$$` (which is
// what gets written into the heartbeat file and never changes across the worker's life).
// Confirmed live: every currently-running local-draft.js process's ppid failed to match
// its own worker's heartbeat pid, 100% of the time -- meaning `!liveWorkerPids.has(p.ppid)`
// was true for every single legitimate in-flight call, not just real orphans. Any watchdog
// tick landing while a call was still running would kill it mid-flight, which is what
// actually produced the "draft call failed" / empty-output pattern this was investigating.
// Fix: walk the full ancestor chain (following ppid repeatedly through as many intermediate
// subshells as bash happens to have forked) instead of only checking the immediate parent.
// A process is a legitimate in-flight call if ANY ancestor is a live worker's heartbeat
// pid; it's a genuine orphan only if the chain runs out (hits an unknown/missing pid)
// without ever matching one. Capped at a generous depth so a `ps` result with a pid/ppid
// cycle or a bug elsewhere can't spin this forever.
const MAX_ANCESTOR_DEPTH = 25;

function hasLiveWorkerAncestor(pid, pidToPpid, liveWorkerPids) {
  let current = pid;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i += 1) {
    if (liveWorkerPids.has(current)) return true;
    const parent = pidToPpid.get(current);
    if (!parent || parent === current) return false; // chain ends (pid 1, unknown, or self-loop)
    current = parent;
  }
  return false;
}

// 2026-08-26, third pass at this same function, same day: the ancestor-walk fix above was
// STILL wrong, for a different reason. `instances/<id>.json`'s `pid` field is not the
// stable value that fix (and the one before it) assumed -- src/heartbeat.js's
// writeHeartbeatFile, called from INSIDE local-draft.js during its own plan/implement
// passes (added 2026-08-22/25 for queued-vs-working status, see that file's own header),
// intentionally overwrites it with `process.pid`, i.e. the in-flight local-draft.js
// child's OWN pid -- not the daemon's. So for most of a real call's lifetime, the
// "live worker pid" IS the exact pid of the process being checked, not an ancestor of it.
// An ancestor-only walk can never match that (it only ever looks upward, never at the
// node itself), so it kept killing real in-flight calls exactly as before. Confirmed
// live: instances/worker-reasoning.json's recorded pid was identical to the running
// local-draft.js process's own pid, sampled 3x while draft/implement was actively
// running. Fix: legitimate if EITHER the process's own pid is a live worker heartbeat
// pid (the common case once local-draft.js's own heartbeat write has fired) OR any
// ancestor is (the brief window between bash's pre-spawn heartbeat write, using the
// daemon's real pid, and local-draft.js's first internal heartbeat write).
function findOrphanedModelCallProcesses({ listProcesses = listProcessesWithPpid, instancesDir } = {}) {
  let processes;
  try {
    processes = listProcesses();
  } catch (e) {
    return []; // `ps` unavailable/failed -- best-effort, same as every other check here.
  }
  const liveWorkerPids = currentWorkerHeartbeatPids(instancesDir);
  const pidToPpid = new Map(processes.map((p) => [p.pid, p.ppid]));
  return processes.filter((p) => MODEL_CALL_SCRIPT_RE.test(p.cmd)
    && !liveWorkerPids.has(p.pid)
    && !hasLiveWorkerAncestor(p.ppid, pidToPpid, liveWorkerPids));
}

function main() {
  const { pipelineDir } = getConfig();
  const instancesDir = path.join(pipelineDir, 'instances');
  const cooldownPath = path.join(instancesDir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir, cooldownPath });
  for (const action of actions) process.stdout.write(`${JSON.stringify(action)}\n`);

  const orphans = findOrphanedModelCallProcesses({ instancesDir });
  for (const orphan of orphans) {
    process.stdout.write(`${JSON.stringify({ action: 'kill-orphan', pid: orphan.pid, reason: `orphaned model-call process (no live worker in its ancestor chain, ppid=${orphan.ppid}, cmd: ${orphan.cmd.slice(0, 120)})` })}\n`);
  }
}

module.exports = { deadProcessCheck, restartTargetFor, isProcessAlive, findOrphanedModelCallProcesses };

if (require.main === module) {
  main();
}
