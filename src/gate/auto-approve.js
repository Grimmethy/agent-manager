'use strict';

// Auto-approve gate: decides whether a review request may be approved without a human.
//
// Pure by design: no I/O, timers, network, or client-library imports. It fails closed
// until the request schema is known, and decide() never rejects.

async function decide(request) {
  try {
    // Non-object input is invalid. Arrays are treated as non-object input too.
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return { approved: false, reason: 'invalid-request' };
    }
    // Touch every own property so a throwing accessor surfaces as gate-error
    // instead of being silently ignored.
    for (const key of Object.keys(request)) {
      void request[key];
    }
    // No auto-approval rules exist yet, so fail closed.
    return { approved: false, reason: 'no-auto-approval-rule-matched' };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { approved: false, reason: 'gate-error: ' + message };
  }
}

module.exports = { decide };
