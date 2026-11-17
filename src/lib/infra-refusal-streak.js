'use strict';

// infra-refusal-streak.js: pure helpers that count consecutive connection-refused errors from the model host.
//
//   isConnectionRefused(err) -> boolean
//   createRefusalStreak({ maxRefusals }) -> { record(err), reset() }
//
// Refusal detection is deliberately narrower than classifyError() in infra-outage.js: it also inspects
// err.cause.code and err.message, which classifyError() does not. The code string is taken from the shared
// TRANSPORT_CODES set in infra-outage.js, so this module never redefines the infra classification.
//
// Purity contract: no I/O, no timers, no clock reads, no randomness. Errors are supplied one at a time by the caller.

const { TRANSPORT_CODES } = require('./infra-outage.js');

const REFUSED_CODE = 'ECONNREFUSED';

// Load-time sanity check against the shared infra classification (no I/O).
if (!TRANSPORT_CODES.has(REFUSED_CODE)) {
  throw new Error('infra-refusal-streak: ' + REFUSED_CODE + ' missing from TRANSPORT_CODES');
}

function isConnectionRefused(err) {
  if (err === null || err === undefined) return false;
  if (typeof err !== 'object' && typeof err !== 'function') return false;
  if (err.code === REFUSED_CODE) return true;
  if (err.cause && err.cause.code === REFUSED_CODE) return true;
  return String(err.message ?? '').includes(REFUSED_CODE);
}

function createRefusalStreak({ maxRefusals = 2 } = {}) {
  let count = 0;

  function record(err) {
    if (!isConnectionRefused(err)) {
      count = 0;
      return { refused: false, giveUp: false };
    }
    count += 1;
    return { refused: true, giveUp: count > maxRefusals };
  }

  function reset() {
    count = 0;
  }

  return { record, reset };
}

module.exports = { isConnectionRefused, createRefusalStreak };
