'use strict';
// Core recovery driver. Every dependency is injected; this module does no
// real I/O, takes no lock, and has no CLI (siblings 2/4 and 3/4 own those).
// Module style: CommonJS, matching the neighbouring scripts/*.js files.
// Contract (assumed; confirm against siblings 2/4 and 3/4):
//   observe()        -> state snapshot
//   plan(state)      -> [{kind:'pipeline'|'forge', name, intent, healthy?}]
//   execute(action), verify(action) -> verify returns truthy when healthy afterwards
//   notify(event), history(entry)   -> record sinks; now() -> timestamp
// STOPPED_INTENT is an ASSUMED intent token for "stopped on purpose"; confirm
// against the observer (sibling 2/4), which has not yet been verified to emit it.
// observe/plan errors propagate to the caller (the CLI owns top-level handling).

const STOPPED_INTENT = 'stopped';

const REASONS = Object.freeze({
  STOPPED: 'stopped-on-purpose',
  HEALTHY: 'already-healthy',
  FORGE: 'forge-never-started',
});

// Pure helper: returns a reason code if the action is protected, else null.
// A forge is never started. A pipeline is protected only by its own intent.
function protectedReason(action) {
  if (action && action.kind === 'forge') return REASONS.FORGE;
  if (action && action.kind === 'pipeline' && action.intent === STOPPED_INTENT) {
    return REASONS.STOPPED;
  }
  return null;
}

const errMsg = (e) => String((e && e.message) || e);

async function runRecovery({ observe, plan, execute, verify, notify, history, now } = {}) {
  const started = [];
  const failed = [];
  const skipped = [];
  const sinkErrors = [];

  const stamp = () => (typeof now === 'function' ? now() : undefined);
  // A broken sink must not abort the run or drop results; record its error.
  const safeSink = async (fn, entry) => {
    if (typeof fn !== 'function') return;
    try {
      await fn(entry);
    } catch (e) {
      sinkErrors.push(errMsg(e));
    }
  };
  const record = async (type, action, extra) => {
    const entry = Object.assign({ type, action, at: stamp() }, extra);
    await safeSink(history, entry);
    await safeSink(notify, entry);
  };

  const state = await observe();
  const actions = (await plan(state)) || [];

  for (const action of actions) {
    const reason =
      protectedReason(action) ||
      (action && action.healthy === true ? REASONS.HEALTHY : null);
    if (reason) {
      skipped.push({ action, reason });
      await record('skipped', action, { reason });
      continue;
    }

    try {
      await execute(action);
    } catch (e) {
      failed.push({ action, error: 'execute-threw: ' + errMsg(e) });
      await record('failed', action, { error: 'execute-threw' });
      continue;
    }

    let ok;
    try {
      ok = await verify(action);
    } catch (e) {
      failed.push({ action, error: 'verify-threw: ' + errMsg(e) });
      await record('failed', action, { error: 'verify-threw' });
      continue;
    }

    if (!ok) {
      failed.push({ action, error: 'verify-failed' });
      await record('failed', action, { error: 'verify-failed' });
      continue;
    }

    started.push({ action });
    await record('started', action, {});
  }

  return { started, failed, skipped, sinkErrors };
}

module.exports = { runRecovery, protectedReason, REASONS, STOPPED_INTENT };
