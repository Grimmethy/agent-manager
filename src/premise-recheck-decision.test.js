'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerTaskSource, clearRegistry } = require('./task-source-registry.js');
const { registerDeterministicRecheck, clearDeterministicRecheckRegistry } = require('./deterministic-recheck-registry.js');
const { decidePremiseRecheckOutcome, decideFindingResolved, isFalsePositiveResponse } = require('./premise-recheck-decision.js');

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


// --- decideFindingResolved: location-scoped ---------------------------------------------
// 2026-09-18 (observability-fix-ac-169): the whole-file rule above can never clear a
// candidate in a big file that has OTHER, unrelated findings (src/local-draft.js has nine
// silent catches). But each finding carries its line span, so the question can be asked at
// the candidate's own site: locate the candidate's Snippet in the CURRENT file and check
// that no scanner finding overlaps it. Conservative -- an ambiguous or missing anchor means
// no verdict; and the scanner cycles the whole repo, so a real remaining problem is
// re-filed as a fresh candidate rather than lost.

const SNIPPET_BODY = [
  '### AC-1 . Log swallowed exception',
  'Files: src/a.js',
  'Snippet:',
  '```',
  '  let g = null;',
  "  if (enabled && process.env.FLAG !== 'false') {",
  '    try { g = build(); } catch { g = null; }',
  '    if (g) {',
  '```',
  '',
  'Problem: the catch swallows the exception.',
].join('\n');

const RESOLVED_SITE = [
  '// BUG: an unrelated finding elsewhere in the same file',
  'function other() { return 1; }',
  'function more() { return 2; }',
  '',
  '  let g = null;',
  "  if (enabled && process.env.FLAG !== 'false') {",
  '    try { g = build(); } catch (e) { console.warn(e); g = null; }',
  '    if (g) {',
  '',
].join('\n');

const candidateTask = (over = {}) => ({
  source: 'fixture_fix',
  promptContext: { files: ['src/a.js'], body: SNIPPET_BODY, ...over },
});

test('decideFindingResolved: true when the candidate site is clean even though the file has an unrelated finding', () => {
  setup();
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), RESOLVED_SITE);
    assert.equal(decideFindingResolved(candidateTask(), { repoRoot: repo }), true);
  } finally { teardown(); }
});

test('decideFindingResolved: false when a finding still overlaps the located site', () => {
  setup();
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), RESOLVED_SITE.replace('console.warn(e); g = null; }', 'g = null; } // BUG'));
    assert.equal(decideFindingResolved(candidateTask(), { repoRoot: repo }), false);
  } finally { teardown(); }
});

test('decideFindingResolved: false when the anchor line is gone from the file (cannot localize -- no verdict)', () => {
  setup();
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), '// BUG: elsewhere\nfunction other() { return 1; }\n');
    assert.equal(decideFindingResolved(candidateTask(), { repoRoot: repo }), false);
  } finally { teardown(); }
});

test('decideFindingResolved: false when the anchor line appears more than once (ambiguous -- no verdict)', () => {
  setup();
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), `// BUG: elsewhere\n${RESOLVED_SITE}\n${RESOLVED_SITE}`);
    assert.equal(decideFindingResolved(candidateTask(), { repoRoot: repo }), false);
  } finally { teardown(); }
});

test('decideFindingResolved: false when the candidate has no Snippet to locate and the file still has a finding', () => {
  setup();
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), RESOLVED_SITE);
    assert.equal(decideFindingResolved(candidateTask({ body: 'Problem: no snippet here.' }), { repoRoot: repo }), false);
  } finally { teardown(); }
});

test('decideFindingResolved: still true when the whole file is clean, snippet or not (the original whole-file rule)', () => {
  setup();
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'function f() { return 1; }\n');
    assert.equal(decideFindingResolved(candidateTask({ body: 'Problem: no snippet here.' }), { repoRoot: repo }), true);
  } finally { teardown(); }
});

test('decideFindingResolved: false for a source with no premiseRecheckSource opt-in', () => {
  setup({ withRule: false });
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'function f() { return 1; }\n');
    assert.equal(decideFindingResolved(candidateTask(), { repoRoot: repo }), false);
  } finally { teardown(); }
});

test("decidePremiseRecheckOutcome: a FALSE POSITIVE refusal is now also approved when only the candidate's own site is clean", () => {
  setup();
  try {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), RESOLVED_SITE);
    const task = { ...candidateTask(), implementResponse: 'FALSE POSITIVE -- already fixed' };
    assert.equal(decidePremiseRecheckOutcome(task, { repoRoot: repo }), 'approve');
  } finally { teardown(); }
});
