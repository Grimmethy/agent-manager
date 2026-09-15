'use strict';

// Ollama hang detection: decides whether the local Ollama endpoint looks WEDGED (not just
// slow) and needs a service restart. Same "decide in Node, do in bash" split as
// dead-process-check.js -- this module never touches systemd itself, it only ever emits an
// NDJSON action line for queue-watcher.sh to act on.
//
// Root-caused live 2026-09-12 (screaminggoatclubmt, "worker-1 pipeline is showing an awful
// lot of ollama timeouts"): worker-1's qwen2.5:3b brain_dump_sort calls were timing out
// (~190s each) nearly 100% of the time while worker-reasoning's qwen3.8:27b calls on the
// SAME endpoint kept succeeding. Traced past the pipeline entirely -- a bare `curl`/`ollama
// run qwen2.5:3b` issued directly against the endpoint, bypassing every pipeline lock,
// reproduced the identical hang: the TCP connection was accepted and the request body fully
// sent, but `ollama serve` never spawned a runner for the model, never touched the GPU (0%
// util the whole time), and never logged a single line at any verbosity -- for as long as we
// waited (60s+ via curl, 30s+ via the `ollama` CLI itself). A `systemctl restart ollama`
// cleared it instantly; the exact same model load succeeded in ~10s against the fresh
// process. Nothing else about the pipeline's own code was involved -- this is a wedged
// server-side scheduler that only a restart clears, most likely one of worker-1's own many
// earlier client-side-timeout abandonments leaving Ollama's internal "load in progress"
// bookkeeping for that model permanently stuck.
//
// Detection strategy: gpu-arbiter.js's own ticket file for the endpoint's lockKey is the
// single most reliable signal available without adding new active probing traffic --
// - A ticket with holding:true means SOME caller has the real underlying flock and should,
//   under normal operation, be making forward progress (queued behind it is fine and
//   expected; STUCK while holding it is not).
//   its `startedAt` field is set once, at the moment it first entered the FIFO queue, and
//   is never touched again by the periodic keep-alive refresh (gpu-arbiter.js's own
//   REFRESH_MS interval only touches the ticket file's mtime, which is therefore USELESS
//   for detecting a stall -- a permanently-wedged-but-still-alive holder refreshes its own
//   ticket forever, looking "fresh" to a staleness sweep). `startedAt` is the one field
//   immune to that, so `now - startedAt` is used as the age signal instead of file mtime.
// - GPU utilization (nvidia-smi) is the corroborating signal that distinguishes "stuck" from
//   "genuinely still working" -- a real generation, even a very long multi-turn one, drives
//   the GPU busy the whole time (confirmed live: worker-reasoning's legitimate multi-minute
//   calls ran the GPU at 30-96% throughout); the wedged-scheduler case measured 0% GPU
//   utilization for the entire ~12 minutes it was stuck. Requiring BOTH "ticket held past
//   threshold" AND "GPU idle" avoids ever mistaking a slow-but-real generation for a hang.
// - A two-tick confirmation window (the SAME ticket identity must still look suspicious on
//   a second check, not just once) absorbs a single noisy nvidia-smi sample (e.g. a brief
//   gap between generation batches) without needing multiple nvidia-smi calls per tick.
// - A restart cooldown prevents a restart storm: right after a real restart, the resident
//   model has to cold-load again (measured live at up to 115s under memory pressure -- see
//   this repo's own gpu-capacity.js MIN_TIMEOUT_MS comment for the calibration history),
//   during which a fresh holding ticket can look transiently idle-GPU+aging too.
//
// Scope: only the HOST's own local Ollama endpoint (systemd-managed, restart is a plain
// `systemctl restart`) is covered. The P40 VM's own Ollama instance
// (AGENT_MANAGER_P40_OLLAMA_URL) is a different physical machine reached over the network --
// restarting it would need SSH/virsh access this module deliberately does not attempt;
// a hang there needs its own remediation path, not silently mis-applied here.
//
// CLI: node ollama-hang-check.js
// Writes at most one line of newline-delimited JSON to stdout when a restart is warranted:
//   { action: 'restart-ollama', lockKey, reason, evidence: {...} }
// Prints nothing when everything looks healthy, when a hang is merely suspected but not yet
// confirmed across two ticks, or while the restart cooldown is still active.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const gpuArbiter = require('./gpu-arbiter.js');

const DEFAULT_LOCK_KEY = 'ollama-localhost-11434';
const HANG_THRESHOLD_MS = 6 * 60 * 1000; // 6 min -- comfortably above the worst legitimate single call/cold-load observed live (~115s reload, ~155s generation), see this file's own header.
const CONFIRM_WINDOW_MS = 90 * 1000; // must still look suspicious on a second tick this far apart before acting -- absorbs one noisy nvidia-smi sample.
const IDLE_GPU_PCT = 5; // at/below this is "not doing real work" -- real generation measured live at 30-96% throughout.
const RESTART_COOLDOWN_MS = 10 * 60 * 1000; // don't restart again this soon -- a fresh restart's own cold reload (up to ~115s measured) can transiently look idle+aging too.

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    console.warn(`[ollama-hang-check] failed to read ${filePath} -- ${e.code ?? e.name} -- ${e.message}`);
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function removeIfExists(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

function defaultReadTickets(instancesDir, lockKey) {
  return gpuArbiter.liveTickets(instancesDir, lockKey);
}

// Returns a 0-100 integer, or null when nvidia-smi is unavailable/fails -- callers must
// treat null as "can't corroborate" and refuse to act, never as "0% util".
function defaultReadGpuUtil() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 });
    const first = out.split('\n')[0].trim();
    const n = Number(first);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

function ticketIdentity(ticket) {
  return `${ticket.pid}:${ticket.taskId}:${ticket.startedAt}`;
}

function ollamaHangCheck({
  instancesDir,
  now = Date.now(),
  lockKey = DEFAULT_LOCK_KEY,
  hangThresholdMs = HANG_THRESHOLD_MS,
  confirmWindowMs = CONFIRM_WINDOW_MS,
  idleGpuPct = IDLE_GPU_PCT,
  restartCooldownMs = RESTART_COOLDOWN_MS,
  suspectPath,
  cooldownPath,
  readTickets = defaultReadTickets,
  readGpuUtil = defaultReadGpuUtil,
}) {
  let tickets;
  try {
    tickets = readTickets(instancesDir, lockKey);
  } catch (e) {
    console.warn(`[ollama-hang-check] readTickets failed for ${lockKey} -- ${e.message}`);
    return null;
  }

  const holder = tickets.find((t) => t.holding);
  if (!holder) {
    removeIfExists(suspectPath); // nothing holding -- whatever was suspicious before has resolved.
    return null;
  }

  const ticketAgeMs = now - Date.parse(holder.startedAt);
  if (!(ticketAgeMs >= hangThresholdMs)) {
    removeIfExists(suspectPath); // held, but not long enough yet to be suspicious.
    return null;
  }

  const gpuUtil = readGpuUtil();
  if (gpuUtil === null) return null; // can't corroborate -- refuse to act on ticket age alone.
  if (gpuUtil > idleGpuPct) {
    removeIfExists(suspectPath); // GPU is genuinely busy -- this is a real long call, not a hang.
    return null;
  }

  const identity = ticketIdentity(holder);
  const suspect = readJson(suspectPath);

  if (!suspect || suspect.key !== identity) {
    // First sighting of this specific stuck-looking ticket -- record it and wait for a
    // second, later confirmation rather than acting on one sample.
    writeJson(suspectPath, { key: identity, firstSeenAt: now });
    return null;
  }

  if (now - suspect.firstSeenAt < confirmWindowMs) {
    return null; // seen before, but not persisted long enough yet.
  }

  const cooldown = readJson(cooldownPath);
  if (cooldown && cooldown.lastRestartAt && now - cooldown.lastRestartAt < restartCooldownMs) {
    return null; // already restarted recently -- most likely still cold-reloading.
  }

  writeJson(cooldownPath, { lastRestartAt: now, lockKey, reason: 'ollama-hang-check' });
  removeIfExists(suspectPath);

  return {
    action: 'restart-ollama',
    lockKey,
    reason: `draft ticket held ${Math.round(ticketAgeMs / 1000)}s (pid ${holder.pid}, task ${holder.taskId || '(none)'}, model ${holder.model || '(unknown)'}) with GPU at ${gpuUtil}% util -- looks wedged, not just slow`,
    evidence: { ticketAgeMs, gpuUtil, holderPid: holder.pid, taskId: holder.taskId, model: holder.model },
  };
}

function main() {
  if (process.env.AGENT_MANAGER_OLLAMA_WATCHDOG === 'false') return;

  const { pipelineDir } = getConfig();
  const instancesDir = path.join(pipelineDir, 'instances');
  const suspectPath = path.join(instancesDir, '.ollama-watchdog-suspect.json');
  const cooldownPath = path.join(instancesDir, '.ollama-watchdog-cooldown.json');

  const hangThresholdMs = Number(process.env.AGENT_MANAGER_OLLAMA_HANG_THRESHOLD_MS) || undefined;
  const confirmWindowMs = Number(process.env.AGENT_MANAGER_OLLAMA_HANG_CONFIRM_MS) || undefined;
  const idleGpuPct = Number(process.env.AGENT_MANAGER_OLLAMA_HANG_IDLE_GPU_PCT) || undefined;
  const restartCooldownMs = Number(process.env.AGENT_MANAGER_OLLAMA_HANG_COOLDOWN_MS) || undefined;

  const action = ollamaHangCheck({
    instancesDir,
    suspectPath,
    cooldownPath,
    ...(hangThresholdMs ? { hangThresholdMs } : {}),
    ...(confirmWindowMs ? { confirmWindowMs } : {}),
    ...(idleGpuPct ? { idleGpuPct } : {}),
    ...(restartCooldownMs ? { restartCooldownMs } : {}),
  });

  if (action) process.stdout.write(`${JSON.stringify(action)}\n`);
}

module.exports = { ollamaHangCheck, ticketIdentity, HANG_THRESHOLD_MS, CONFIRM_WINDOW_MS, IDLE_GPU_PCT, RESTART_COOLDOWN_MS };

if (require.main === module) {
  main();
}
