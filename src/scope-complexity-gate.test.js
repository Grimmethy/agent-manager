'use strict';

// node:test coverage for scopeComplexityGate (src/local-agentic-write-draft.js).
//
// Contract under test:
//   scopeComplexityGate(task) ->
//     { shouldDecompose: true,  reason: <string containing 'scope-complexity-gate'> }
//       when task.promptContext.prefetchedPaths contains python/dashboard/app.py
//       AND the task's text names >= 3 distinct /api/... endpoints, OR >= 3 of the
//       domain keywords (catalog / install / update / ui / frontend);
//     { shouldDecompose: false }
//       otherwise -- notably:
//         * the anchor file is NOT in prefetchedPaths (even if it is named in text), or
//         * there are only 2 signals (the threshold is strictly >= 3 distinct).
//
// Sibling-tasks note (2026-09-11): this suite was written from the accepted plan while
// scopeComplexityGate itself was still landing in a sibling task ("Add
// scopeComplexityGate function and export in local-agentic-write-draft.js" / "Wire
// scopeComplexityGate before runPlanWithTools"). If the export is not present yet, the
// whole suite SKIPs cleanly (exit 0, visible skip message) rather than hard-failing CI;
// once the sibling merges, the same file runs as-is.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Re-require the module under test with a clean instance (no shared mutable state
// between tests, even if the module ever grows module-level caches).
function freshModule() {
  const p = require.resolve('./local-agentic-write-draft.js');
  delete require.cache[p];
  return require('./local-agentic-write-draft.js');
}

// Anchor file and signal sets the contract names.
const ANCHOR = 'python/dashboard/app.py';
const THREE_APIS = 'Update /api/users, /api/orders, and /api/reports endpoints.';
const TWO_APIS = 'Update /api/users and /api/orders endpoints.';
const THREE_KEYWORDS = 'Handle catalog, install, and update flows for the ui layer.';

function makeTask({ rawText, prefetchedPaths, title = 'Dashboard work' } = {}) {
  return { title, promptContext: { rawText, prefetchedPaths } };
}

const mod = freshModule();
const gate = typeof mod.scopeComplexityGate === 'function' ? mod.scopeComplexityGate : null;

describe('scopeComplexityGate', {
  skip: gate ? false : 'scopeComplexityGate not yet exported (sibling task pending)',
}, () => {
  test('fires on anchor in prefetchedPaths + 3 distinct /api/ endpoints', () => {
    const scopeComplexityGate = freshModule().scopeComplexityGate;
    const task = makeTask({
      title: 'Refactor dashboard API',
      rawText: THREE_APIS,
      prefetchedPaths: [ANCHOR],
    });
    const result = scopeComplexityGate(task);
    assert.equal(result.shouldDecompose, true);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.includes('scope-complexity-gate'), `reason should name the gate, got: ${result.reason}`);
  });

  test('fires on anchor in prefetchedPaths + 3 domain keywords', () => {
    const scopeComplexityGate = freshModule().scopeComplexityGate;
    const task = makeTask({
      title: 'Full-stack overhaul',
      rawText: THREE_KEYWORDS,
      prefetchedPaths: [ANCHOR],
    });
    const result = scopeComplexityGate(task);
    assert.equal(result.shouldDecompose, true);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.includes('scope-complexity-gate'), `reason should name the gate, got: ${result.reason}`);
  });

  test('does not fire when the anchor file is not in prefetchedPaths (no anchor -> no gate)', () => {
    const scopeComplexityGate = freshModule().scopeComplexityGate;
    const task = makeTask({
      title: 'API work',
      rawText: 'Update /api/a, /api/b, /api/c endpoints.',
      prefetchedPaths: ['src/index.js'], // anchor absent
    });
    const result = scopeComplexityGate(task);
    assert.equal(result.shouldDecompose, false);
  });

  test('does not fire with only 2 signals (threshold is strictly >= 3 distinct)', () => {
    const scopeComplexityGate = freshModule().scopeComplexityGate;
    const task = makeTask({
      title: 'Minor API tweak',
      rawText: TWO_APIS,
      prefetchedPaths: [ANCHOR],
    });
    const result = scopeComplexityGate(task);
    assert.equal(result.shouldDecompose, false);
  });

  test('does not fire when the anchor is only named in text, not in prefetchedPaths', () => {
    const scopeComplexityGate = freshModule().scopeComplexityGate;
    const task = makeTask({
      title: 'Dashboard work',
      rawText: `Edit ${ANCHOR} and update /api/a, /api/b, /api/c.`,
      prefetchedPaths: ['src/other.js'], // anchor NOT prefetched, only mentioned in text
    });
    const result = scopeComplexityGate(task);
    assert.equal(result.shouldDecompose, false);
  });
});
