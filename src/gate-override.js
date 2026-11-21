'use strict';

const GATE_CODES = Object.freeze(["docs-only", "forbidden-path", "ungrounded-field", "ungrounded-url", "executed-verification", "undefined-identifier"]);

// Returns the gateOverrides entry whose gate field exactly equals code, or null.
// Never throws: a missing or non-array gateOverrides simply means no override.
function findOverride(task, code) {
  if (!task || !Array.isArray(task.gateOverrides)) return null;
  for (const entry of task.gateOverrides) {
    if (entry && entry.gate === code) return entry;
  }
  return null;
}

// Builds the history event recorded whenever an owner override is applied. Fields are copied as passed.
function buildOverrideEvent({ gate, reason, by, at, suppressed }) {
  return { type: 'gate-override', gate, reason, by, at, suppressed };
}

module.exports = { GATE_CODES, findOverride, buildOverrideEvent };
