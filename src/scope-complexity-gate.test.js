'use strict';

// node:test coverage for scopeComplexityGate (src/local-agentic-write-draft.js).
//
// Contract under test:
//   scopeComplexityGate(task) ->
//     { shouldDecompose: true,  reason: <string containing 'scope-complexity-gate'> }
//       when some file in task.promptContext.prefetchedPaths is CURRENTLY flagged
//       oversized (queue/file-length-flags.json, via decompose-loop-autoroute.js's
//       oversizedFiles()) AND the task's text names >= 3 distinct /api/... endpoints,
//       OR >= 3 of the domain keywords (catalog / install / update / ui / frontend);
//     { shouldDecompose: false }
//       otherwise -- notably:
//         * no prefetched file is currently flagged oversized (even if one is named in
//           text but never prefetched, or prefetched but not flagged), or
//         * there are only 2 signals (the threshold is strictly >= 3 distinct).
//
// 2026-09-14 (consolidation research, generalized off a hardcoded
// python/dashboard/app.py anchor): the gate used to treat that ONE path as an anchor
// unconditionally, with no oversized-file lookup at all. It now accepts ANY prefetched
// file the file-length-scan watchdog currently has flagged -- app.py included, but no
// longer hardcoded to it. What did NOT change: the anchor must still come from
// prefetchedPaths (the orient/grep pass's own confirmation this file is actually
// relevant), never just a name mentioned in prose -- see the "named in text but not
// prefetched" test below, unchanged in intent from the original suite.
//
// Sibling-tasks note (2026-09-11): this suite was written from the accepted plan while
// scopeComplexityGate itself was still landing in a sibling task. If the export is not
// present yet, the whole suite SKIPs cleanly (exit 0, visible skip message) rather than
// hard-failing CI; once the sibling merges, the same file runs as-is.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Re-require the module under test with a clean instance (no shared mutable state
// between tests, even if the module ever grows module-level caches).
function freshModule() {
  const p = require.resolve('./local-agentic-write-draft.js');
  delete require.cache[p];
  delete require.cache[require.resolve('./config.js')];
  return require('./local-agentic-write-draft.js');
}

// Isolated pipeline dir with a file-length-flags.json naming exactly the files passed --
// oversizedFiles() reads this the same way the reactive file-decompose sweep does.
function withFlaggedFiles(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-gate-test-'));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'file-length-flags.json'), JSON.stringify({
    findings: files.map((file) => ({ file })),
  }));
  const prev = { r: process.env.AGENT_MANAGER_REPO_ROOT, p: process.env.AGENT_MANAGER_PIPELINE_DIR };
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  try { return fn(dir); } finally {
    for (const [e, v] of [['AGENT_MANAGER_REPO_ROOT', prev.r], ['AGENT_MANAGER_PIPELINE_DIR', prev.p]]) {
      if (v === undefined) delete process.env[e]; else process.env[e] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Anchor file and signal sets the contract names.
const ANCHOR = 'python/dashboard/app.py';
const THREE_APIS = 'Update /api/users, /api/orders, and /api/reports endpoints.';
const TWO_APIS = 'Update /api/users and /api/orders endpoints.';
const THREE_KEYWORDS = 'Handle catalog, install, and update flows for the ui layer.';

function makeTask({ rawText, prefetchedPaths, title = 'Dashboard work' } = {}) {
  return { title, promptContext: { rawText, prefetchedPaths } };
}

const gate = typeof freshModule().scopeComplexityGate === 'function' ? freshModule().scopeComplexityGate : null;

describe('scopeComplexityGate', {
  skip: gate ? false : 'scopeComplexityGate not yet exported (sibling task pending)',
}, () => {
  test('fires on a flagged-oversized anchor in prefetchedPaths + 3 distinct /api/ endpoints', () => {
    withFlaggedFiles([ANCHOR], () => {
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
  });

  test('fires on a flagged-oversized anchor in prefetchedPaths + 3 domain keywords', () => {
    withFlaggedFiles([ANCHOR], () => {
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
  });

  test('fires on a DIFFERENT flagged-oversized anchor -- no longer hardcoded to app.py', () => {
    const otherFile = 'src/some-other-huge-file.js';
    withFlaggedFiles([otherFile], () => {
      const scopeComplexityGate = freshModule().scopeComplexityGate;
      const task = makeTask({
        title: 'Refactor a big module',
        rawText: THREE_APIS,
        prefetchedPaths: [otherFile],
      });
      const result = scopeComplexityGate(task);
      assert.equal(result.shouldDecompose, true);
      assert.match(result.reason, /src\/some-other-huge-file\.js/);
    });
  });

  test('does not fire when the prefetched anchor is not currently flagged oversized', () => {
    withFlaggedFiles([], () => {
      const scopeComplexityGate = freshModule().scopeComplexityGate;
      const task = makeTask({
        title: 'API work',
        rawText: THREE_APIS,
        prefetchedPaths: [ANCHOR],
      });
      const result = scopeComplexityGate(task);
      assert.equal(result.shouldDecompose, false);
    });
  });

  test('does not fire with only 2 signals (threshold is strictly >= 3 distinct)', () => {
    withFlaggedFiles([ANCHOR], () => {
      const scopeComplexityGate = freshModule().scopeComplexityGate;
      const task = makeTask({
        title: 'Minor API tweak',
        rawText: TWO_APIS,
        prefetchedPaths: [ANCHOR],
      });
      const result = scopeComplexityGate(task);
      assert.equal(result.shouldDecompose, false);
    });
  });

  test('does not fire when the flagged-oversized anchor is only named in text, not in prefetchedPaths', () => {
    withFlaggedFiles([ANCHOR], () => {
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

  test('does not crash and declines when file-length-flags.json does not exist yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-gate-test-noflags-'));
    fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
    const prev = { r: process.env.AGENT_MANAGER_REPO_ROOT, p: process.env.AGENT_MANAGER_PIPELINE_DIR };
    process.env.AGENT_MANAGER_REPO_ROOT = dir;
    process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
    try {
      const scopeComplexityGate = freshModule().scopeComplexityGate;
      const result = scopeComplexityGate(makeTask({ rawText: THREE_APIS, prefetchedPaths: [ANCHOR] }));
      assert.equal(result.shouldDecompose, false);
    } finally {
      for (const [e, v] of [['AGENT_MANAGER_REPO_ROOT', prev.r], ['AGENT_MANAGER_PIPELINE_DIR', prev.p]]) {
        if (v === undefined) delete process.env[e]; else process.env[e] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
