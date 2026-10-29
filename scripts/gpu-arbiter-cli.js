#!/usr/bin/env node
'use strict';

// Thin CLI over src/gpu-arbiter.js for the non-Node callers (the dashboard's chat-preempt,
// operator debugging). Not used by the worker/reviewer lanes -- those require() the module
// directly.
//
//   node scripts/gpu-arbiter-cli.js cancel-below [--local | --key K | --model M] [--cls interactive]
//       -> mark every lower-class GPU ticket cancelRequested + SIGKILL any active holder.
//          Prints a JSON array: [{ pid, cls, taskId, action }]
//   node scripts/gpu-arbiter-cli.js status [--local | --key K | --model M]
//       -> { holder, waiting, reserved } for the dashboard (reserved = live place tickets, i.e. holds).
//   node scripts/gpu-arbiter-cli.js hold (--key K | --local) --pid P [--cls review] [--task ID] [--phase reservation] [--model M]
//       -> LONG-LIVED. Reserves endpoint K for process P: takes an arbiter place ticket of class --cls (default review, so every
//          draft lane on K yields; interactive still outranks it) and keeps it alive until the first of: P exits (reason
//          owner-exited), this process gets SIGTERM/SIGINT/SIGHUP (signal:<NAME>), or a higher class's cancel-below marks the
//          ticket (cancelled). Prints one JSON line {"event":"held",...} once the ticket exists and one {"event":"released",
//          reason, heldMs,...} on release, then exits 0; logs both as 'gpu-hold' events in pipeline-history.log. Refuses (exit 1,
//          nothing written) an unknown --cls, a missing/dead --pid, or no --key/--local (a model-name key never matches the
//          endpoint-keyed lane tickets, so it would reserve nothing). A SIGKILL'd hold leaves its ticket to go stale (90 s) and be
//          swept by the next reader. For non-Node callers (brain-dump 1902); a Node caller can use gpu-arbiter.js holdPlace().
//
// Which tickets: worker drafts key their tickets by Ollama ENDPOINT (one per GPU), so a --model key finds none of them (2026-09-21: that is why the chat's
// takeover silently did nothing). --local = the endpoint THIS process talks to (its OLLAMA_URL, i.e. the host GPU): the chat's own GPU, the only one it may
// take over. It REFUSES (prints [] and exits 0) if that endpoint is the P40 VM's, so a mis-set OLLAMA_URL can never let a chat turn kill the P40 lane.
// --key K names a serialization key explicitly. With none of these, --model defaults to $LOCAL_MODEL (the old per-model key).
// instancesDir comes from getConfig().

const path = require('path');
const arb = require(path.join(__dirname, '..', 'src', 'gpu-arbiter.js'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function instancesDir() {
  try {
    return require(path.join(__dirname, '..', 'src', 'instances-dir.js')).sharedInstancesDir(require(path.join(__dirname, '..', 'src', 'config.js')).getConfig().pipelineDir);
  } catch {
    const pd = process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT;
    return pd ? require(path.join(__dirname, '..', 'src', 'instances-dir.js')).sharedInstancesDir(pd) : null;
  }
}

function pipelineDir() {
  try {
    return require(path.join(__dirname, '..', 'src', 'config.js')).getConfig().pipelineDir;
  } catch {
    return process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT || null;
  }
}

const HOLD_POLL_MS = 1000;

function emitLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// `hold` -- see this file's header. Validation first, so a refusal never leaves a ticket behind.
function runHold(key, dir) {
  const fail = (code, msg) => { process.stderr.write(`gpu-arbiter-cli hold: ${msg}\n`); process.exit(code); };
  const cls = arg('cls', 'review');
  if (!Object.prototype.hasOwnProperty.call(arb.CLASS_RANK, cls)) fail(1, `unknown --cls '${cls}' (one of ${Object.keys(arb.CLASS_RANK).join(', ')})`);
  const ownerPid = Number(arg('pid', ''));
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) fail(1, '--pid <pid of the process the reservation is for> is required');
  if (!arb.pidAlive(ownerPid)) fail(1, `--pid ${ownerPid} is not a live process`);
  if (!process.argv.includes('--local') && !arg('key', '')) fail(1, '--key <endpoint key, e.g. ollama-<host>-<port>> or --local is required');
  if (key === null) fail(2, '--local resolved to a remote lane endpoint; name it with --key instead');
  const taskId = arg('task', null);
  const phase = arg('phase', 'reservation');
  const model = arg('model', null);
  const pd = pipelineDir();
  const { logPipelineEvent } = require(path.join(__dirname, '..', 'src', 'pipeline-history.js'));

  const base = { key, cls, pid: process.pid, ownerPid, taskId, phase };
  let handle = null;
  let startedMs = null;
  let done = false;
  let poll = null;
  const finish = (reason) => {
    if (done) return;
    done = true;
    if (poll) clearInterval(poll);
    if (handle) {
      handle.release();
      const heldMs = Date.now() - startedMs;
      emitLine({ event: 'released', ...base, reason, heldMs });
      logPipelineEvent(pd, 'gpu-hold', { event: 'release', ...base, reason, heldMs });
    }
    process.exit(0);
  };
  // Signal handlers go in BEFORE the ticket exists: a caller may signal the moment it reads the 'held' line, and the default
  // SIGTERM action would exit without releasing (the ticket then lingers until TICKET_STALE_MS). Caught in this change's own tests.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => finish(`signal:${sig}`));

  handle = arb.holdPlace(dir, { cls, model, lockKey: key, taskId, phase, ownerPid });
  startedMs = Date.now();
  emitLine({ event: 'held', ...base, startedAt: new Date(startedMs).toISOString() });
  logPipelineEvent(pd, 'gpu-hold', { event: 'start', ...base });
  // Ref'd on purpose: holdPlace's own re-touch interval is unref'd, so this timer is what keeps the process (and the ticket) alive.
  poll = setInterval(() => {
    if (!arb.pidAlive(ownerPid)) finish('owner-exited');
    else if (handle.cancelled()) finish('cancelled');
  }, HOLD_POLL_MS);
}

const cmd = process.argv[2];
const { localOllamaLockKey, remoteLaneLockKeys } = require(path.join(__dirname, '..', 'src', 'lib', 'ollama-lock-key.js'));
// The serialization key the arbiter functions look tickets up by (model is only a key when nothing better is given).
function resolveKey() {
  if (process.argv.includes('--local')) {
    const key = localOllamaLockKey();
    if (remoteLaneLockKeys().includes(key)) { process.stderr.write(`gpu-arbiter-cli: --local resolves to a remote lane's endpoint (${key}); refusing, the chat only takes over the host GPU\n`); return null; }
    return key;
  }
  return arg('key', arg('model', process.env.LOCAL_MODEL || ''));
}
const model = resolveKey();
const dir = instancesDir();

if (!dir) { process.stderr.write('gpu-arbiter-cli: cannot resolve instances dir\n'); process.exit(2); }

if (cmd === 'hold') {
  runHold(model, dir);
} else if (model === null) {
  process.stdout.write(cmd === 'status' ? JSON.stringify({ holder: null, waiting: [] }) : '[]');
} else if (cmd === 'cancel-below') {
  const cls = arg('cls', 'interactive');
  let out = [];
  try { out = arb.cancelBelow(dir, model, cls); } catch (e) { process.stderr.write(`gpu-arbiter-cli: ${e.message}\n`); }
  process.stdout.write(JSON.stringify(out));
} else if (cmd === 'status') {
  let out = { holder: null, waiting: [] };
  try { out = arb.status(dir, model); } catch (e) { process.stderr.write(`gpu-arbiter-cli: ${e.message}\n`); }
  process.stdout.write(JSON.stringify(out));
} else {
  process.stderr.write('usage: gpu-arbiter-cli.js <cancel-below|status|hold> [--local | --key K | --model M] [--cls C] [--pid P --task ID]\n');
  process.exit(1);
}
