'use strict';
// Pure test-failure gate. No I/O, no timers, no env or flag reads, no override.
// Blocks when:
//   1. a failing test is in addedTestNames (added by this diff and failing);
//   2. a failing test is not in masterFailingTests (new failure vs. master baseline);
//   3. the master baseline is unavailable (masterFailingTests === null).
// blockedReason names every blocking test.

function evaluateTestGate({ failingTests, addedTestNames, masterFailingTests }) {
  // Invalid input is rejected explicitly rather than silently coerced.
  if (!Array.isArray(failingTests)) {
    throw new TypeError('evaluateTestGate: failingTests must be an array of strings');
  }
  if (!Array.isArray(addedTestNames)) {
    throw new TypeError('evaluateTestGate: addedTestNames must be an array of strings');
  }
  if (masterFailingTests !== null && !Array.isArray(masterFailingTests)) {
    throw new TypeError('evaluateTestGate: masterFailingTests must be an array of strings or null');
  }

  // Baseline unavailable: block regardless of failures, naming any failing tests.
  if (masterFailingTests === null) {
    const names = failingTests.map(String);
    const reason = names.length
      ? `master baseline unavailable; blocking failing tests: ${names.join(', ')}`
      : 'master baseline unavailable';
    return { blocked: true, blockedReason: reason };
  }

  const added = new Set(addedTestNames);
  const master = new Set(masterFailingTests);
  const seen = new Set();
  const reasons = [];
  for (const name of failingTests) {
    if (seen.has(name)) continue;
    seen.add(name);
    const why = [];
    if (added.has(name)) why.push('added by this diff and failing');
    if (!master.has(name)) why.push('new failure, absent from master baseline');
    if (why.length > 0) reasons.push(`${name}: ${why.join('; ')}`);
  }

  if (reasons.length === 0) return { blocked: false, blockedReason: '' };
  return { blocked: true, blockedReason: reasons.join('\n') };
}

module.exports = { evaluateTestGate };
