'use strict';

// Node plan-limit breaker: pauses a node when consecutive provider errors (429s) reach a threshold.
//
// Why: the Claude gateway answers HTTP 429 when an account hits its weekly plan limit.
// Without a breaker, the worker keeps claiming tasks on that account, burning infra
// requeue rounds on every failure. This module tracks consecutive 429s, trips a pause
// at the configured threshold, and exposes when to next probe (the earlier of the
// pause's resetsAt and now + minimum-minutes).
//
// What this does: a self-contained circuit-breaker state machine with no timers.
// States: CLOSED (healthy, counting failures) → OPEN (tripped, paused until probeAt).
// Reads AGENT_MANAGER_NODE_BREAKER_FAILS (default 6), AGENT_MANAGER_NODE_BREAKER_MIN
// (default 30), and AGENT_MANAGER_NODE_LIMIT_MARKER_DIRS (comma-separated dirs to
// scan for plan-limit.json markers).
//
// The pause mechanism never overrides a foreign pause: if source A paused, source B
// cannot extend or replace it. Only the same source can extend its own pause forward.
// probeAt returns the earlier of the pause's resetsAt and now + minimum-minutes, so
// the caller always probes at the right time regardless of which limit fired.

const fs = require('fs');
const path = require('path');

const DEFAULT_FAILS = 6;
const DEFAULT_MIN = 30; // minutes

// Read an integer env var with a default. Returns the default for empty/missing/invalid.
function envInt(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : def;
}

// Parse AGENT_MANAGER_NODE_LIMIT_MARKER_DIRS into an array of trimmed non-empty strings.
function markerDirs() {
  const raw = process.env.AGENT_MANAGER_NODE_LIMIT_MARKER_DIRS || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// Scan marker dirs for plan-limit.json. Returns { file, data } for the first match,
// or null when none is found or parseable. Pure: no side effects.
function scanMarkers() {
  const dirs = markerDirs();
  for (const dir of dirs) {
    const file = path.join(dir, 'plan-limit.json');
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { file, data };
    } catch (e) {
      // File not found, not JSON, or read error: skip and try next dir.
    }
  }
  return null;
}

// Check if a lane result is a provider error (HTTP 429).
// Matches status === 429 or message string containing '429'.
function isProviderError(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.status === 429) return true;
  if (typeof result.message === 'string' && result.message.includes('429')) return true;
  return false;
}

// Create a new breaker state instance.
// Options override env defaults for testing: { failsThreshold, minMinutes }.
function createBreaker(opts = {}) {
  const failsThreshold = opts.failsThreshold !== undefined ? opts.failsThreshold : envInt('AGENT_MANAGER_NODE_BREAKER_FAILS', DEFAULT_FAILS);
  const minMinutes = opts.minMinutes !== undefined ? opts.minMinutes : envInt('AGENT_MANAGER_NODE_BREAKER_MIN', DEFAULT_MIN);

  let state = 'CLOSED'; // CLOSED | OPEN
  let failures = 0;
  let currentPause = null; // { source: string, resetsAt: number (ms) }

  // Pause the node. Never overrides a foreign pause (different source).
  // Only extends an existing pause from the same source forward in time.
  function pause(source, resetsAt) {
    if (!source || typeof source !== 'string') return;
    const resets = Number(resetsAt);
    if (!Number.isFinite(resets)) return;

    // Never override a foreign pause.
    if (currentPause && currentPause.source !== source) return;

    // Only extend forward, never shorten.
    if (currentPause && resets <= currentPause.resetsAt) return;

    currentPause = { source, resetsAt: resets };
    if (state === 'CLOSED') {
      state = 'OPEN';
    }
  }

  // Clear the pause (used when a probe succeeds or manually).
  function clearPause() {
    currentPause = null;
    if (state === 'OPEN') {
      state = 'CLOSED';
      failures = 0;
    }
  }

  // Compute when to next probe. Returns ISO string or null if not paused.
  // Returns the earlier of: the pause's resetsAt, or now + minimum-minutes.
  function probeAt(now = Date.now()) {
    if (state !== 'OPEN' || !currentPause) return null;
    const minMs = minMinutes * 60 * 1000;
    const byMin = now + minMs;
    const earliest = currentPause.resetsAt < byMin ? currentPause.resetsAt : byMin;
    return new Date(earliest).toISOString();
  }

  // Feed a lane result into the breaker. Updates failure count and may trip.
  // Returns the new state ('CLOSED' or 'OPEN').
  function onLaneResult(result) {
    if (!result || typeof result !== 'object') return state;

    if (isProviderError(result)) {
      failures++;
      if (failures >= failsThreshold && state === 'CLOSED') {
        // Trip the breaker with an auto-pause.
        state = 'OPEN';
        pause('breaker', Date.now() + minMinutes * 60 * 1000);
      }
    } else {
      // Non-provider error or success: reset failure count.
      failures = 0;
    }
    return state;
  }

  // Getters for state inspection.
  function getState() { return state; }
  function getFailures() { return failures; }
  function getPause() { return currentPause ? { ...currentPause } : null; }

  return {
    getState,
    getFailures,
    getPause,
    pause,
    clearPause,
    probeAt,
    onLaneResult,
    isProviderError,
    scanMarkers
  };
}

module.exports = {
  createBreaker,
  isProviderError,
  scanMarkers,
  markerDirs,
  envInt,
  DEFAULT_FAILS,
  DEFAULT_MIN
};
