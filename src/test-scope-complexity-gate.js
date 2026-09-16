'use strict';

// node:test coverage for scopeComplexityGate (src/local-agentic-write-draft.js) --
// the 3-case contract from the scope-complexity-gate decomposition:
//   (1) POSITIVE  -- multi-endpoint ask text with a flagged-oversized anchor in
//       prefetchedPaths -> shouldDecompose true, reason contains 'scope-complexity-gate';
//   (2) NEGATIVE  -- single endpoint with the same anchor -> false;
//   (3) NEGATIVE  -- the multi-endpoint text but a prefetched anchor that is NOT
//       flagged oversized -> false.
//
// The gate short-circuits to {shouldDecompose:false} unless a prefetched file is
// CURRENTLY flagged in queue/file-length-flags.json (via decompose-loop-autoroute.js's
// oversizedFiles()), so each test runs inside withFlaggedFiles(), which points
// AGENT_MANAGER_REPO_ROOT / AGENT_MANAGER_PIPELINE_DIR at a temp dir carrying that
// fixture -- same setup pattern as src/scope-complexity-gate.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ANCHOR = 'python/dashboard/app.py';
const MULTIS = 'Add /api/plugins/catalog, /api/plugins/install, /api/plugins/update endpoints to python/dashboard/app.py with a UI panel';
const SINGLE = 'Add a /api/health endpoint to python/dashboard/app.py';

function withFlaggedFiles(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-scope-gate-'));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'file-length-flags.json'), JSON.stringify({
    findings: files.map((file) => ({ file })),
  }));
  const prev = { r: process.env.AGENT_MANAGER_REPO_ROOT, p: process.env.AGENT_MANAGER_PIPELINE_DIR };
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    for (const [e, v] of [['AGENT_MANAGER_REPO_ROOT', prev.r], ['AGENT_MANAGER_PIPELINE_DIR', prev.p]]) {
      if (v === undefined) delete process.env[e]; else process.env[e] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Re-require with clean config state (config.js caches process.env per call site, and
// the gate reads getConfig().pipelineDir at call time -- deleting the cached instances
// between tests keeps the temp-dir fixture authoritative).
function freshGate() {
  const p = require.resolve('./local-agentic-write-draft.js');
  delete require.cache[p];
  delete require.cache[require.resolve('./config.js')];
  return require('./local-agentic-write-draft.js').scopeComplexityGate;
}

function makeTask(text, prefetchedPaths) {
  return { title: text, promptContext: { rawText: text, prefetchedPaths } };
}

test('POSITIVE: multi-endpoint text with flagged app.py anchor -> shouldDecompose true, reason names the gate', () => {
  withFlaggedFiles([ANCHOR], () => {
    const scopeComplexityGate = freshGate();
    assert.strictEqual(typeof scopeComplexityGate, 'function', 'scopeComplexityGate must be exported from local-agentic-write-draft.js');
    const result = scopeComplexityGate(makeTask(MULTIS, [ANCHOR]));
    assert.strictEqual(result.shouldDecompose, true);
    assert.ok(typeof result.reason === 'string' && result.reason.includes('scope-complexity-gate'),
      `reason should contain 'scope-complexity-gate', got: ${result.reason}`);
  });
});

test('NEGATIVE: single endpoint with flagged app.py anchor -> shouldDecompose false', () => {
  withFlaggedFiles([ANCHOR], () => {
    const scopeComplexityGate = freshGate();
    const result = scopeComplexityGate(makeTask(SINGLE, [ANCHOR]));
    assert.strictEqual(result.shouldDecompose, false);
  });
});

test('NEGATIVE: multi-endpoint text but anchor file not flagged oversized -> shouldDecompose false', () => {
  withFlaggedFiles([ANCHOR], () => {
    const scopeComplexityGate = freshGate();
    const result = scopeComplexityGate(makeTask(MULTIS, ['python/dashboard/templates/index.html']));
    assert.strictEqual(result.shouldDecompose, false);
  });
});
