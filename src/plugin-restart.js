'use strict';
/**
 * Bounded plugin restart helper.
 *
 * restartPlugin(name, manager, opts) -> { state, reason }
 *   state: 'restarted' | 'failed' | 'conflict'
 *   The route maps 'conflict' to HTTP 409.
 *
 * `manager` is injected (no dependency on the real process manager). Contract:
 *   - signal(name, 'SIGTERM')  (or kill(name, 'SIGTERM'), or stop(name) as a fallback)
 *   - isRunning(name) -> boolean   (or is_running(name))
 *   - start(name)                  (same path ensure-started uses)
 *
 * opts: { maxAttempts = 20, intervalMs = 250, sleep = sleepSync }
 *
 * The wait between exit checks is a bounded retry (not a poll loop): a
 * synchronous Atomics.wait on a throwaway SharedArrayBuffer, so no timers are added.
 */

const MAX_ATTEMPTS = 20;
const INTERVAL_MS = 250;

// Names with a restart currently running.
const inFlight = new Set();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function sendTerm(manager, name) {
  if (typeof manager.signal === 'function') return manager.signal(name, 'SIGTERM');
  if (typeof manager.kill === 'function') return manager.kill(name, 'SIGTERM');
  if (typeof manager.stop === 'function') return manager.stop(name);
  throw new Error('manager cannot send SIGTERM');
}

function running(manager, name) {
  if (typeof manager.isRunning === 'function') return !!manager.isRunning(name);
  if (typeof manager.is_running === 'function') return !!manager.is_running(name);
  throw new Error('manager cannot report running state');
}

function msg(err) {
  return err && err.message ? err.message : String(err);
}

function restartPlugin(name, manager, opts = {}) {
  if (inFlight.has(name)) {
    return { state: 'conflict', reason: 'restart already in flight' };
  }
  const maxAttempts = opts.maxAttempts > 0 ? opts.maxAttempts : MAX_ATTEMPTS;
  const intervalMs = opts.intervalMs >= 0 ? opts.intervalMs : INTERVAL_MS;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepSync;

  inFlight.add(name);
  try {
    try {
      sendTerm(manager, name);
    } catch (err) {
      return { state: 'failed', reason: `SIGTERM failed: ${msg(err)}` };
    }

    let exited = false;
    for (let i = 0; i < maxAttempts; i++) {
      let up;
      try {
        up = running(manager, name);
      } catch (err) {
        return { state: 'failed', reason: msg(err) };
      }
      if (!up) { exited = true; break; }
      if (i < maxAttempts - 1) sleep(intervalMs);
    }
    if (!exited) {
      return { state: 'failed', reason: `did not exit after ${maxAttempts} attempts` };
    }

    try {
      const ok = manager.start(name);
      if (ok === false) return { state: 'failed', reason: 'start returned false' };
    } catch (err) {
      return { state: 'failed', reason: `start failed: ${msg(err)}` };
    }
    return { state: 'restarted', reason: 'ok' };
  } finally {
    inFlight.delete(name);
  }
}

module.exports = { restartPlugin, inFlight, MAX_ATTEMPTS, INTERVAL_MS };
