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

const STALE_HEARTBEAT_SECONDS = 300; // 5 min -- comfortably above ornith-client.js's 4-min REQUEST_TIMEOUT_MS per-call ceiling.
// worker-only: pid alive but heartbeat stale this long means a hung call, not a slow one.
// draftTask() (ornith-draft.js) chains up to 4 sequential ornithCall()s per task -- plan,
// implement, critique, and (if critique flags issues) revise -- each individually bounded
// by ornith-client.js's REQUEST_TIMEOUT_MS (240s default), with no heartbeat write between
// passes. Worst case is therefore ~4*240s=960s of legitimate, non-hung work between the
// "working" heartbeat at claim time and the "idle" heartbeat at completion. The old 300s
// value only covered a single call and was killing every multi-pass task mid-flight,
// confirmed live 2026-08-16: worker-1 was SIGKILL'd and restarted by the watchdog roughly
// every 5 minutes for hours straight, re-starting the same leftover drafting/ tasks from
// scratch each time (no partial-pass checkpointing) and never completing one.
const WORKER_ZOMBIE_THRESHOLD_SECONDS = 1200; // 20 min -- comfortably above the real ~960s worst-case chain, not a single call.
const RESTART_COOLDOWN_SECONDS = 120; // don't re-restart the same instanceId again this soon -- a fresh replacement's own first heartbeat can take a moment to land.

// instanceId -> { script, args, pidfileName } -- mirrors launch.sh's own hardcoded
// start_bg() invocations exactly (the actual source of truth for how each instance is
// named/launched on this Linux port), not a generic pattern-match table the way the
// reference's $RESTART_MAP is -- this deployment only ever creates a small, fixed set of
// instances, so there's no real "any worker-N" generality to preserve beyond the one
// literal worker-1 already handles via the worker- prefix check below.
function restartTargetFor(instanceId) {
  if (instanceId.startsWith('worker-')) {
    return { script: 'ornith-worker.sh', args: [instanceId], pidfileName: `${instanceId}.pid` };
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
      // Unreadable/mid-write heartbeat file -- skip it this pass, same "don't let one bad
      // file stop the rest" treatment the reference gives this per-item try/catch.
    }
  }

  if (cooldownsChanged) writeCooldowns(cooldownPath, cooldowns);
  return actions;
}

function main() {
  const { pipelineDir } = getConfig();
  const instancesDir = path.join(pipelineDir, 'instances');
  const cooldownPath = path.join(instancesDir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir, cooldownPath });
  for (const action of actions) process.stdout.write(`${JSON.stringify(action)}\n`);
}

module.exports = { deadProcessCheck, restartTargetFor, isProcessAlive };

if (require.main === module) {
  main();
}
