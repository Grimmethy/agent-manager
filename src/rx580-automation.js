'use strict';

// RX 580 failover automation: when the Haiku cloud lanes are plan-limited,
// enable the local worker-rx580 lane; when the limit clears, disable it —
// but only if the automation itself turned it on. Manual overrides are
// respected. Hysteresis prevents toggling on brief blips.
//
// Design: event-driven. The module exposes `onLimitStatusChange(newStatus)`
// which the caller invokes whenever the cloud plan-limit state flips.
// No setInterval, no sleep loops, no cron. Hysteresis is enforced via a
// timestamp comparison inside the event handler.
//
// Lane I/O reads/writes the lanes registry (lanes.json) directly. The rx580
// lane is identified by `gpu: 'rx580'`; its id auto-derives as `worker-rx580`.

const fs = require('fs');
const path = require('path');

const HYSTERESIS_MS = 5 * 60 * 1000; // 5 minutes
const RX580_GPU = 'rx580';

// Module-level state (single instance per require). Tests can reset by
// re-requiring or by calling the internal reset exposed for testing.
let state = {
  lastStatus: null,           // 'limited' | 'clear' | null
  statusSince: null,          // timestamp when current status began holding
  rx580Enabled: false,        // current effective enabled state
  lastChangeWasByAutomation: false, // did automation last toggle the switch?
  manualOverride: false,      // owner manually flipped the switch
  actedForStatus: null,       // status we've already acted on (to avoid repeated actions)
};

function getRegistryPath(env) {
  return (env && env.AGENT_MANAGER_LANES_PATH) || path.join(__dirname, '..', 'lanes.json');
}

function readRegistry(env) {
  const file = getRegistryPath(env);
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.lanes) ? parsed.lanes : []);
    return entries || [];
  } catch {
    return [];
  }
}

function writeRegistry(entries, env) {
  const file = getRegistryPath(env);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

function findRx580Entry(entries) {
  return entries.findIndex(e => e && e.gpu === RX580_GPU);
}

function isRx580Enabled(env) {
  const entries = readRegistry(env);
  const idx = findRx580Entry(entries);
  if (idx === -1) return false;
  // enabled === false means disabled; undefined or true means enabled.
  return entries[idx].enabled !== false;
}

function enableRx580(env) {
  const entries = readRegistry(env);
  const idx = findRx580Entry(entries);
  if (idx === -1) {
    // Create a new rx580 entry with sensible defaults.
    entries.push({
      gpu: RX580_GPU,
      ollamaUrl: 'http://localhost:11434',
      model: 'qwen3-vl:8b-instruct',
      enabled: true,
    });
  } else {
    entries[idx].enabled = true;
  }
  writeRegistry(entries, env);
  return true;
}

function disableRx580(env) {
  const entries = readRegistry(env);
  const idx = findRx580Entry(entries);
  if (idx !== -1) {
    entries[idx].enabled = false;
    writeRegistry(entries, env);
    return true;
  }
  return false;
}

// Core state machine. Called whenever the cloud plan-limit status changes
// (or on a heartbeat). Returns true if the automation acted (toggled rx580),
// false otherwise.
//
// Hysteresis: the current status must have held for HYSTERESIS_MS before
// the automation acts. The first call with a new status starts the timer;
// subsequent calls (with the same status) check if hysteresis has passed.
function onLimitStatusChange(newStatus, env, now) {
  if (typeof newStatus !== 'string' || (newStatus !== 'limited' && newStatus !== 'clear')) {
    return false;
  }
  env = env || process.env;
  now = typeof now === 'number' ? now : Date.now();

  const previousStatus = state.lastStatus;

  // Update status if changed, and reset the hysteresis timer.
  if (newStatus !== previousStatus) {
    state.lastStatus = newStatus;
    state.statusSince = now;
    state.actedForStatus = null; // reset acted flag for new status
  }

  // Hysteresis: require the status to hold for HYSTERESIS_MS.
  if (now - state.statusSince < HYSTERESIS_MS) {
    return false;
  }

  // Hysteresis passed — but only act once per status (avoid repeated actions).
  if (state.actedForStatus === newStatus) {
    return false;
  }

  // Make the decision.
  let acted = false;
  if (newStatus === 'limited') {
    // Cloud is limited — enable rx580 as failover, but only if:
    // 1. rx580 is currently disabled, AND
    // 2. there's no manual override (owner flipped it off intentionally).
    if (!isRx580Enabled(env) && !state.manualOverride) {
      enableRx580(env);
      state.rx580Enabled = true;
      state.lastChangeWasByAutomation = true;
      state.manualOverride = false;
      acted = true;
    }
  } else {
    // Cloud recovered — disable rx580, but ONLY if automation turned it on.
    // If the owner manually left it on, respect their choice.
    if (isRx580Enabled(env) && state.lastChangeWasByAutomation) {
      disableRx580(env);
      state.rx580Enabled = false;
      state.lastChangeWasByAutomation = false;
      acted = true;
    }
  }

  if (acted) {
    state.actedForStatus = newStatus;
  }
  return acted;
}

// Call when the owner manually toggles the rx580 switch. This tells the
// automation to respect the manual choice and not override it.
function setManualOverride(flag) {
  state.manualOverride = !!flag;
}

// Exposed for testing: reset all state to initial values.
function resetState() {
  state = {
    lastStatus: null,
    statusSince: null,
    rx580Enabled: false,
    lastChangeWasByAutomation: false,
    manualOverride: false,
    actedForStatus: null,
  };
}

module.exports = {
  onLimitStatusChange,
  enableRx580,
  disableRx580,
  isRx580Enabled,
  setManualOverride,
  resetState,
  HYSTERESIS_MS,
  RX580_GPU,
};
