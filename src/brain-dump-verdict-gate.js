'use strict';

// Verdict gate for brain-dump entries.
// Trigger event: a resolutionCheck write (recordResolutionVerdict -> stampVerdict in
// src/brain-dump-resolution-check.js). The gate is evaluated once per such write.
// This is NOT a poll: no timer, no interval, no model call. Pure decision functions only.

const { hasCodeReference } = require('./brain-dump-resolution-check.js');

const ENV_KEY = 'AGENT_MANAGER_BRAIN_DUMP_VERDICT_GATE';
const MODES = ['off', 'dry-run', 'on'];
const PARK_VERDICT = 'already fixed';

function resolveMode(env) {
  const raw = (env || {})[ENV_KEY];
  if (raw === undefined || raw === '') return 'dry-run';
  if (MODES.includes(raw)) return raw;
  console.warn(`[verdict-gate] invalid ${ENV_KEY}=${JSON.stringify(raw)}; using dry-run`);
  return 'dry-run';
}

// `now` is part of the contract signature; verdictGateWaitUntil is owned by SUBTASK 2.
function decideGate(entry, now) {
  const check = entry && entry.resolutionCheck;
  if (check) {
    if (check.verdict === 'no') return { action: 'queue', evidence: null };
    if (check.verdict === PARK_VERDICT && Array.isArray(check.citedShas) && check.citedShas.length > 0) {
      const evidence = (entry.possiblyResolved && entry.possiblyResolved.evidence) || check.citedShas;
      return { action: 'park', evidence };
    }
    return { action: 'queue', evidence: null };
  }
  if (hasCodeReference(entry && entry.rawText)) return { action: 'wait', evidence: null };
  return { action: 'queue', evidence: null };
}

module.exports = { resolveMode, decideGate };
