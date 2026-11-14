'use strict';

// Unit tests for src/lib/brain-dump-duplicate-check.js.
// Run: node --test src/lib/brain-dump-duplicate-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isEnabled,
  citedPaths,
  firstIdentifier,
  normalizeFilePath,
  normalizeBrainDumpKey,
  checkBrainDumpDuplicate,
  checkBrainDumpEntries,
} = require('./brain-dump-duplicate-check.js');

function makeEntry(overrides = {}) {
  return { id: 'bd-test-1', rawText: '`src/foo.js` fix the `bar` function', ...overrides };
}

test('isEnabled: kill switch honored', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(isEnabled({ AGENT_MANAGER_BRAIN_DUMP_DUPLICATE_CHECK: 'false' }), false);
  assert.equal(isEnabled({ AGENT_MANAGER_BRAIN_DUMP_DUPLICATE_CHECK: 'true' }), true);
});

test('citedPaths: extracts backticked file paths', () => {
  const paths = citedPaths('fix `src/foo.js:10` and `docs/bar.md`');
  assert.deepEqual(paths, ['src/foo.js', 'docs/bar.md']);
});

test('firstIdentifier: extracts first backticked identifier', () => {
  assert.equal(firstIdentifier('fix the `bar` function'), 'bar');
  assert.equal(firstIdentifier('no backticks here'), '');
  assert.equal(firstIdentifier('`resolveGraphPath`'), 'resolvegraphpath');
});

test('normalizeFilePath: strips backticks, quotes, line numbers', () => {
  assert.equal(normalizeFilePath('`src/foo.js:10`'), 'src/foo.js');
  assert.equal(normalizeFilePath("'src/bar.ts'"), 'src/bar.ts');
  assert.equal(normalizeFilePath('./src/baz.py'), 'src/baz.py');
});

test('normalizeBrainDumpKey: returns null when no files or no identifier', () => {
  assert.equal(normalizeBrainDumpKey({ rawText: 'no paths here' }), null);
  assert.equal(normalizeBrainDumpKey({ rawText: '`src/foo.js` no backticked id' }), null);
});

test('normalizeBrainDumpKey: returns stable key for same input', () => {
  const e1 = { rawText: '`src/foo.js` fix the `bar` function' };
  const e2 = { rawText: '`src/foo.js` fix the `bar` function' };
  assert.equal(normalizeBrainDumpKey(e1), normalizeBrainDumpKey(e2));
});

test('checkBrainDumpEntries: finds duplicate in brain-dump.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-test-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  const entries = [
    { id: 'bd-1', rawText: '`src/foo.js` fix the `bar` function' },
    { id: 'bd-2', rawText: '`src/foo.js` fix the `bar` function' },
  ];
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }));
  const result = checkBrainDumpEntries({ id: 'bd-3', rawText: '`src/foo.js` fix the `bar` function' }, brainDumpPath);
  assert.equal(result.isDuplicate, true);
  assert.equal(result.duplicateOf, 'bd-1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkBrainDumpEntries: no duplicate when key differs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-test-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  const entries = [
    { id: 'bd-1', rawText: '`src/foo.js` fix the `bar` function' },
  ];
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }));
  const result = checkBrainDumpEntries({ id: 'bd-2', rawText: '`src/foo.js` fix the `baz` function' }, brainDumpPath);
  assert.equal(result, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkBrainDumpDuplicate: same-key duplicate is skipped with duplicateOf set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-test-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  const entries = [
    { id: 'bd-1793277449921', rawText: '`questforge/ddl/store.py` fix the `migrate` function' },
  ];
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }));
  const entry = { id: 'bd-1793466944652', rawText: '`questforge/ddl/store.py` fix the `migrate` function' };
  const result = checkBrainDumpDuplicate(entry, { brainDumpPath });
  assert.equal(result.isDuplicate, true);
  assert.equal(result.duplicateOf, 'bd-1793277449921');
  assert.equal(result.source, 'brain-dump');
  assert.equal(entry.duplicateOf, 'bd-1793277449921');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkBrainDumpDuplicate: different symbol in same file NOT skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-test-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  const entries = [
    { id: 'bd-1', rawText: '`src/foo.js` fix the `bar` function' },
  ];
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }));
  const entry = { id: 'bd-2', rawText: '`src/foo.js` fix the `baz` function' };
  const result = checkBrainDumpDuplicate(entry, { brainDumpPath });
  assert.equal(result, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkBrainDumpDuplicate: entry with no cited path fails open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-test-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries: [] }));
  const entry = { id: 'bd-1', rawText: 'no paths here' };
  const result = checkBrainDumpDuplicate(entry, { brainDumpPath });
  assert.equal(result, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkBrainDumpDuplicate: override honored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-test-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  const entries = [
    { id: 'bd-1', rawText: '`src/foo.js` fix the `bar` function' },
  ];
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }));
  const entry = { id: 'bd-2', rawText: '`src/foo.js` fix the `bar` function', duplicateOverride: true };
  const result = checkBrainDumpDuplicate(entry, { brainDumpPath });
  assert.equal(result, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkBrainDumpDuplicate: kill switch honored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-test-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  const entries = [
    { id: 'bd-1', rawText: '`src/foo.js` fix the `bar` function' },
  ];
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }));
  const entry = { id: 'bd-2', rawText: '`src/foo.js` fix the `bar` function' };
  // Temporarily set kill switch
  const orig = process.env.AGENT_MANAGER_BRAIN_DUMP_DUPLICATE_CHECK;
  process.env.AGENT_MANAGER_BRAIN_DUMP_DUPLICATE_CHECK = 'false';
  const result = checkBrainDumpDuplicate(entry, { brainDumpPath });
  process.env.AGENT_MANAGER_BRAIN_DUMP_DUPLICATE_CHECK = orig;
  assert.equal(result, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('both filings of one defect sit in the file: the FIRST is queued and the SECOND is parked behind it (never both parked)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-pair-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  const text = '`questforge/ddl/store.py` fix the `migrate` function to align column types';
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries: [{ id: 'bd-first', rawText: text }, { id: 'bd-second', rawText: text }] }));
  const first = { id: 'bd-first', rawText: text };
  const second = { id: 'bd-second', rawText: text };
  assert.equal(checkBrainDumpDuplicate(first, { brainDumpPath }), null, 'the first filing is not a duplicate of the later one');
  const parked = checkBrainDumpDuplicate(second, { brainDumpPath });
  assert.equal(parked.duplicateOf, 'bd-first');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an entry that is itself parked (duplicateOf set) is not the original of anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-parked-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  const text = '`src/a.js` the `fn` is wrong';
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries: [{ id: 'bd-1', rawText: text, duplicateOf: 'bd-0' }, { id: 'bd-2', rawText: text }] }));
  assert.equal(checkBrainDumpDuplicate({ id: 'bd-2', rawText: text }, { brainDumpPath }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an already-queued entry counts as the original even when it sits LATER in the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-queued-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  const text = '`src/a.js` the `fn` is wrong';
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries: [{ id: 'bd-1', rawText: text }, { id: 'bd-2', rawText: text, status: 'actioned', queuedTaskId: 't-2' }] }));
  assert.equal(checkBrainDumpDuplicate({ id: 'bd-1', rawText: text }, { brainDumpPath }).duplicateOf, 'bd-2');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the branch half, against a real pushed branch (origin/agent/*) ----
const { execFileSync } = require('child_process');
function repoWithPushedBranch(fileBody, branchBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bddup-branch-'));
  const origin = path.join(dir, 'origin.git'); const work = path.join(dir, 'work');
  const run = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { stdio: 'ignore' });
  fs.mkdirSync(origin); run(origin, 'init', '-q', '--bare', '-b', 'main');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true }); run(work, 'init', '-q', '-b', 'main');
  run(work, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(work, 'src', 'real.js'), fileBody); run(work, 'add', '-A'); run(work, 'commit', '-q', '-m', 'init'); run(work, 'push', '-q', 'origin', 'main');
  run(work, 'checkout', '-q', '-b', 'agent/some-task'); fs.writeFileSync(path.join(work, 'src', 'real.js'), branchBody);
  run(work, 'commit', '-q', '-am', 'fix'); run(work, 'push', '-q', 'origin', 'agent/some-task'); run(work, 'checkout', '-q', 'main');
  run(work, 'branch', '-D', 'agent/some-task'); run(work, 'fetch', '-q', 'origin');
  return { dir, work };
}

test('branch half: a pushed origin/agent/* branch that changes the cited file AND symbol makes the entry a duplicate', () => {
  const { dir, work } = repoWithPushedBranch('function fixIt() { return 1 }\nfunction other() { return 2 }\n', 'function fixIt() { return 3 }\nfunction other() { return 2 }\n');
  const entry = { id: 'bd-9', rawText: 'The `src/real.js` function `fixIt` returns the wrong value' };
  const r = checkBrainDumpDuplicate(entry, { repoRoot: work });
  assert.equal(r.source, 'branch');
  assert.equal(r.duplicateOf, 'agent/some-task');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('branch half: the same file but a different symbol is NOT a duplicate; no repoRoot fails open', () => {
  const { dir, work } = repoWithPushedBranch('function fixIt() { return 1 }\nfunction other() { return 2 }\n', 'function fixIt() { return 3 }\nfunction other() { return 2 }\n');
  assert.equal(checkBrainDumpDuplicate({ id: 'bd-9', rawText: 'The `src/real.js` function `other` is wrong' }, { repoRoot: work }), null);
  assert.equal(checkBrainDumpDuplicate({ id: 'bd-9', rawText: 'The `src/real.js` function `fixIt` is wrong' }, { repoRoot: null }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
