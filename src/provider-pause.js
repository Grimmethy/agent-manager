'use strict';

// Per-provider pause record and claim gate (HUB0611 2/6).
//
// A provider that answers a plan-limit 429 is PAUSED, not failing: one record {provider, resetsAt, source} per provider is persisted to disk (so it survives a
// restart) and claiming for that provider stops until resetsAt plus a small jitter. Other providers keep claiming. `claimAllowed(provider)` is the gate; wiring
// it into the real claim path belongs to the sibling pieces.
//
// No polling: pause() arms ONE one-shot setTimeout per provider, firing at resetsAt + jitter, and rearm() re-arms from the persisted file at startup. The
// callback only clears the record (and calls the optional onResume hook); it never re-arms. The gate itself is time-based (now < resetsAt + jitter), so it is
// correct even if a timer is late, lost, or clamped (setTimeout cannot wait longer than 2^31-1 ms; a clamped timer that fires early leaves the record alone).
//
// The jitter is derived from the provider name (a stable hash, 0..jitterMaxMs), so it is identical before and after a restart and needs no persistence.
//
// State file: <dir>/provider-pause.json where dir is AGENT_MANAGER_PAUSE_STATE_DIR, default $HOME/.local/state/agent-manager/provider-pause.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomicSync } = require('./atomic-write.js');

const DEFAULT_JITTER_MAX_MS = 5000;
const MAX_TIMEOUT_MS = 2147483647;
const FILE_NAME = 'provider-pause.json';

function stateDir(env = process.env) {
  const override = String(env.AGENT_MANAGER_PAUSE_STATE_DIR || '').trim();
  if (override) return override;
  return path.join(env.HOME || os.homedir(), '.local', 'state', 'agent-manager', 'provider-pause');
}

function pauseFile(env = process.env) {
  return path.join(stateDir(env), FILE_NAME);
}

function jitterFor(provider, jitterMaxMs = DEFAULT_JITTER_MAX_MS) {
  let h = 0;
  for (const ch of String(provider)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return jitterMaxMs > 0 ? h % (jitterMaxMs + 1) : 0;
}

// resetsAt as ISO string, epoch ms or Date -> epoch ms, or NaN.
function toMs(resetsAt) {
  if (resetsAt instanceof Date) return resetsAt.getTime();
  if (typeof resetsAt === 'number') return resetsAt;
  if (typeof resetsAt === 'string') return Date.parse(resetsAt);
  return NaN;
}

function createProviderPause({
  env = process.env,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  jitterMaxMs = DEFAULT_JITTER_MAX_MS,
  onResume = null,
} = {}) {
  const file = pauseFile(env);
  const timers = new Map(); // provider -> timeout handle (at most one each)

  // A missing or corrupt file is "nothing paused".
  function readAll() {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [provider, rec] of Object.entries(parsed)) {
      if (rec && typeof rec === 'object' && Number.isFinite(Date.parse(rec.resetsAt))) {
        out[provider] = { provider, resetsAt: rec.resetsAt, source: rec.source };
      }
    }
    return out;
  }

  function writeAll(map) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomicSync(file, map);
  }

  const untilMs = (rec) => Date.parse(rec.resetsAt) + jitterFor(rec.provider, jitterMaxMs);

  function getPause(provider) {
    return readAll()[provider] || null;
  }

  // The claim gate's question: is this provider held right now?
  function isPaused(provider) {
    const rec = getPause(provider);
    return !!rec && now() < untilMs(rec);
  }

  function claimAllowed(provider) {
    return !isPaused(provider);
  }

  function clearTimer(provider) {
    const handle = timers.get(provider);
    if (handle !== undefined) clearTimeoutFn(handle);
    timers.delete(provider);
  }

  function removeRecord(provider, expectedResetsAt) {
    const map = readAll();
    const rec = map[provider];
    if (!rec) return null;
    if (expectedResetsAt !== undefined && rec.resetsAt !== expectedResetsAt) return null;
    delete map[provider];
    writeAll(map);
    return rec;
  }

  function fireResume(rec) {
    if (typeof onResume !== 'function') return;
    try { onResume(rec); } catch (e) { /* a hook failure must not break the gate */ }
  }

  // One one-shot timer at resetsAt + jitter. The callback never re-arms.
  function arm(rec) {
    clearTimer(rec.provider);
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, untilMs(rec) - now()));
    const handle = setTimeoutFn(() => {
      timers.delete(rec.provider);
      if (now() < untilMs(rec)) return; // clamped long wait fired early: leave the record, the gate is time-based
      const removed = removeRecord(rec.provider, rec.resetsAt);
      if (removed) fireResume(removed);
    }, delay);
    if (handle && typeof handle.unref === 'function') handle.unref();
    timers.set(rec.provider, handle);
  }

  function pause({ provider, resetsAt, source }) {
    if (typeof provider !== 'string' || !provider) throw new Error('provider-pause: provider is required');
    const ms = toMs(resetsAt);
    if (!Number.isFinite(ms)) throw new Error('provider-pause: resetsAt must be a valid time');
    const rec = { provider, resetsAt: new Date(ms).toISOString(), source: source === undefined ? null : source };
    const map = readAll();
    map[provider] = rec;
    writeAll(map);
    arm(rec);
    return rec;
  }

  // Lift a pause early (clears its timer and record).
  function resume(provider) {
    clearTimer(provider);
    return removeRecord(provider);
  }

  // Startup: re-arm every persisted pause; an already-expired one is cleared (and handed to onResume) with no timer left.
  function rearm() {
    const map = readAll();
    for (const rec of Object.values(map)) {
      if (now() >= untilMs(rec)) {
        const removed = removeRecord(rec.provider, rec.resetsAt);
        if (removed) fireResume(removed);
      } else {
        arm(rec);
      }
    }
    return Object.keys(readAll());
  }

  return { pause, resume, rearm, getPause, isPaused, claimAllowed, pauseFile: file, activeTimers: () => timers.size };
}

module.exports = { createProviderPause, jitterFor, pauseFile, stateDir, DEFAULT_JITTER_MAX_MS, MAX_TIMEOUT_MS };
