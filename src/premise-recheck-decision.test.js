'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerTaskSource, clearRegistry } = require('./task-source-registry.js');
const { registerDeterministicRecheck, clearDeterministicRecheckRegistry } = require('./deterministic-recheck-registry.js');
const { decidePremiseRecheckOutcome, isFalsePositiveResponse } = require('./premise-recheck-decision.js');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premise-recheck-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

function setup({ withRule = true, hasRules = true } = {}) {
  clearRegistry();
  clearDeterministicRecheckRegistry();
  registerTaskSource('fixture_fix', {
    priority: 80,
    next: () => null,
    candidateFulfillment: true,
    ...(withRule ? { premiseRecheckSource: 'fixture_review' } : {}),
  });
  if (hasRules) {
    registerDeterministicRecheck('fixture_review', {
      // A trivial "rule": flags any line containing the literal word BUG.
      perFileRules: {
        'bug-marker': (text) => text.split('\n').flatMap((line, i) => (
          /\bBUG\b/.test(line) ? [{ file: null, line: i + 1, detail: 'BUG marker present' }] : []
        )),
      },
    });
  }
}

function teardown() {
  clearRegistry();
  clearDeterministicRecheckRegistry();
}

// --- isFalsePositiveResponse -----------------------------------------------------------

test('isFalsePositiveResponse: matches the documented "FALSE POSITIVE -- ..." shape, case-insensitively', () => {
  assert.equal(isFalsePositiveResponse('FALSE POSITIVE -- already fixed'), true);
  assert.equal(isFalsePositiveResponse('  false positive -- already fixed  '), true);
  assert.equal(isFalsePositiveResponse('This is a FALSE POSITIVE somewhere in the middle'), false, 'must be at the start, not embedded mid-response');
  assert.equal(isFalsePositiveResponse('{"mode":"edit","file":"x.js"}'), false);
  assert.equal(isFalsePositiveResponse(''), false);
  assert.equal(isFalsePositiveResponse(undefined), false);
});

// --- decidePremiseRecheckOutcome --------------------------------------------------------

test('decidePremiseRecheckOutcome: null when implementResponse is not a FALSE POSITIVE claim', () => {
  setup();
  try {
    const task = { source: 'fixture_fix', implementResponse: '{"mode":"edit"}', promptContext: { files: ['src/a.js'] } };
    assert.equal(decidePremiseRecheckOutcome(task, { repoRoot: tmpRepo() }), null);
  } finally { teardown(); }
});

test('decidePremiseRecheckOutcome: null when the source has no premiseRecheckSource opt-in', () => {
  setup({ withRule: false });
  try {
    const task = { source: 'fixture_fix', implementResponse: 'FALSE POSITIVE -- already fixed', promptContext: { files: ['src/a.js'] } };
    assert.equal(decidePremiseRecheckOutcome(task, { repoRoot: tmpRepo() }), null);
  } finally { teardown(); }
});

test('decidePremiseRecheckOutcome: null when the opted-in review source has no registered recheck rules', () => {
  setup({ hasRules: false });
  try {
    const task = { source: 'fixture_fix', implementResponse: 'FALSE POSITIVE -- already fixed', promptContext: { files: ['src/a.js'] } };
    assert.equal(decidePremiseRecheckOutcome(task, { repoRoot: tmpRepo() }), null);
  } finally { teardown(); }
});

test('decidePremiseRecheckOutcome: null when no files are cited', () => {
  setup();
  try {
    const task = { source: 'fixture_fix', implementResponse: 'FALSE POSITIVE -- already fixed', promptContext: {} };
    assert.equal(decidePremiseRecheckOutcome(task, { repoRoot: tmpRepo() }), null);
  } finally { teardown(); }
});

test('decidePremiseRecheckOutcome: null when the cited file does not resolve in the repo', () => {
  setup();
  try {
    const task = { source: 'fixture_fix', implementResponse: 'FALSE POSITIVE -- already fixed', promptContext: { files: ['src/does-not-exist.js'] } };
    assert.equal(decidePremiseRecheckOutcome(task, { repoRoot: tmpRepo() }), null);
  } finally { teardown(); }
});

test("decidePremiseRecheckOutcome: 'approve' when the rule set finds nothing in the current file -- premise genuinely resolved", () => {
  setup();
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'function f() { return 1; }\n'); // clean, no BUG marker
    const task = { source: 'fixture_fix', implementResponse: 'FALSE POSITIVE -- already fixed', promptContext: { files: ['src/a.js'] } };
    assert.equal(decidePremiseRecheckOutcome(task, { repoRoot: repo }), 'approve');
  } finally { teardown(); }
});

test('decidePremiseRecheckOutcome: null when the rule set still finds something -- refusal was wrong, let normal review handle it', () => {
  setup();
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), '// BUG: still here\nfunction f() { return 1; }\n');
    const task = { source: 'fixture_fix', implementResponse: 'FALSE POSITIVE -- already fixed', promptContext: { files: ['src/a.js'] } };
    assert.equal(decidePremiseRecheckOutcome(task, { repoRoot: repo }), null);
  } finally { teardown(); }
});

test('decidePremiseRecheckOutcome: requires EVERY cited file to be clean -- one lingering finding blocks approval', () => {
  setup();
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'function f() { return 1; }\n');
    fs.writeFileSync(path.join(repo, 'src', 'b.js'), '// BUG: still here\n');
    const task = { source: 'fixture_fix', implementResponse: 'FALSE POSITIVE -- already fixed', promptContext: { files: ['src/a.js', 'src/b.js'] } };
    assert.equal(decidePremiseRecheckOutcome(task, { repoRoot: repo }), null);
  } finally { teardown(); }
});

test('decidePremiseRecheckOutcome: null for a source with no registration at all (unrelated/unknown source)', () => {
  setup();
  try {
    const task = { source: 'totally_unregistered_source', implementResponse: 'FALSE POSITIVE -- already fixed', promptContext: { files: ['src/a.js'] } };
    assert.equal(decidePremiseRecheckOutcome(task, { repoRoot: tmpRepo() }), null);
  } finally { teardown(); }
});
