'use strict';

// Tests for branch-check-store.js: the RAM-only, expiring store of branch-check results.
// Each test points the store at its own temp directory (AGENT_MANAGER_BRANCH_CHECK_DIR) and restores the environment afterwards.
// Run: node --test src/branch-check-store.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { saveBranchCheck, loadBranchCheck, MAX_AGE_MS } = require('./branch-check-store.js');

const REPO = '/repos/agent-manager';
const SHA = 'a'.repeat(40);
const result = (over = {}) => ({
  headSha: SHA, branch: 'agent/one', base: 'origin/master', repoRoot: REPO, changedFiles: ['src/a.js'], docsOnly: false, harness: 'node-test', testsRun: true,
  checked: [{ kind: 'tests', what: 'node tests', command: 'node --test src/a.test.js', ok: true, summary: 'exit 0' }], notRun: [], durationMs: 5, checkedAt: '2026-10-29T10:00:00.000Z', ...over,
});
const nameFor = (repoRoot, headSha) => `${crypto.createHash('sha1').update(`${repoRoot}:${headSha}`).digest('hex').slice(0, 16)}.json`;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-check-store-test-'));
  const prev = process.env.AGENT_MANAGER_BRANCH_CHECK_DIR;
  process.env.AGENT_MANAGER_BRANCH_CHECK_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.AGENT_MANAGER_BRANCH_CHECK_DIR; else process.env.AGENT_MANAGER_BRANCH_CHECK_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('a saved result comes back as the same object', (t) => {
  setup(t);
  assert.equal(saveBranchCheck(REPO, result()), true);
  assert.deepEqual(loadBranchCheck(REPO, SHA), result());
});

test('another head sha or another repository gives null, and a later save for the same head replaces the earlier one', (t) => {
  setup(t);
  saveBranchCheck(REPO, result());
  assert.equal(loadBranchCheck(REPO, 'b'.repeat(40)), null);
  assert.equal(loadBranchCheck('/repos/other', SHA), null);
  saveBranchCheck(REPO, result({ testsRun: false, checked: [], notRun: ['no test harness recognised for this repo'] }));
  const latest = loadBranchCheck(REPO, SHA);
  assert.equal(latest.testsRun, false);
  assert.deepEqual(latest.notRun, ['no test harness recognised for this repo']);
});

test('a result is good for six hours and no longer, by the clock passed in', (t) => {
  setup(t);
  const T = 1_800_000_000_000;
  saveBranchCheck(REPO, result(), { now: T });
  assert.deepEqual(loadBranchCheck(REPO, SHA, { now: T + MAX_AGE_MS }), result(), 'exactly six hours old is still good');
  assert.equal(loadBranchCheck(REPO, SHA, { now: T + MAX_AGE_MS + 1 }), null);
  assert.equal(MAX_AGE_MS, 6 * 60 * 60 * 1000);
  assert.deepEqual(loadBranchCheck(REPO, SHA, { now: T - 1000 }), result(), 'a clock that reads slightly earlier than the save is not treated as expired');
});

test('a garbage file, another version and a file for a different head or repository all give null', (t) => {
  const dir = setup(t);
  const file = path.join(dir, nameFor(REPO, SHA));
  fs.writeFileSync(file, '\u0000 not json at all');
  assert.equal(loadBranchCheck(REPO, SHA), null);

  const wrap = (over) => JSON.stringify({ version: 1, repoRoot: REPO, savedAt: Date.now(), result: result(), ...over });
  fs.writeFileSync(file, wrap({ version: 2 }));
  assert.equal(loadBranchCheck(REPO, SHA), null, 'another store version');
  fs.writeFileSync(file, wrap({ result: result({ headSha: 'c'.repeat(40) }) }));
  assert.equal(loadBranchCheck(REPO, SHA), null, 'the stored result is for another head');
  fs.writeFileSync(file, wrap({ repoRoot: '/repos/other' }));
  assert.equal(loadBranchCheck(REPO, SHA), null, 'the stored result is for another repository');
  fs.writeFileSync(file, wrap({ result: null }));
  assert.equal(loadBranchCheck(REPO, SHA), null);
  fs.writeFileSync(file, wrap({ savedAt: 'yesterday' }));
  assert.equal(loadBranchCheck(REPO, SHA), null, 'an unreadable timestamp is not a fresh result');
  fs.writeFileSync(file, wrap({}));
  assert.deepEqual(loadBranchCheck(REPO, SHA), result(), 'and the same file well-formed is accepted');
});

test('an unwritable directory makes save return false and load return null, without throwing', (t) => {
  const dir = setup(t);
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file where the store directory should be');
  process.env.AGENT_MANAGER_BRANCH_CHECK_DIR = path.join(blocker, 'store');
  assert.doesNotThrow(() => assert.equal(saveBranchCheck(REPO, result()), false));
  assert.doesNotThrow(() => assert.equal(loadBranchCheck(REPO, SHA), null));
});

test('the file is named by the first 16 hex characters of the sha1 of repoRoot:headSha, and no temp file is left behind', (t) => {
  const dir = setup(t);
  saveBranchCheck(REPO, result());
  assert.deepEqual(fs.readdirSync(dir), [nameFor(REPO, SHA)]);
  assert.match(nameFor(REPO, SHA), /^[0-9a-f]{16}\.json$/);
  saveBranchCheck(REPO, result());
  saveBranchCheck('/repos/other', result({ repoRoot: '/repos/other' }));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('the store is in RAM by default and falls back to the OS temp dir when tmpfs cannot be used', (t) => {
  setup(t);
  delete process.env.AGENT_MANAGER_BRANCH_CHECK_DIR;
  const attempted = [];
  const realMkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (p, ...rest) => {
    attempted.push(String(p));
    if (String(p).startsWith('/dev/shm')) throw Object.assign(new Error('no tmpfs here'), { code: 'EACCES' });
    return realMkdir.call(fs, p, ...rest);
  });
  const uniqueRepo = `/repos/fallback-test-${process.pid}-${Date.now()}`;
  const fallbackDir = path.join(os.tmpdir(), 'agent-manager-branch-checks');
  const file = path.join(fallbackDir, nameFor(uniqueRepo, SHA));
  t.after(() => { fs.rmSync(file, { force: true }); try { fs.rmdirSync(fallbackDir); } catch (_) { /* not empty or not ours */ } });
  assert.equal(saveBranchCheck(uniqueRepo, result({ repoRoot: uniqueRepo })), true);
  assert.equal(attempted[0], '/dev/shm/agent-manager-branch-checks', 'tmpfs is tried first');
  assert.ok(fs.existsSync(file), 'the result went to the OS temp dir fallback');
  assert.ok(loadBranchCheck(uniqueRepo, SHA));
});

test('missing or non-text arguments give false and null, never an exception', (t) => {
  const dir = setup(t);
  for (const args of [[null, result()], ['', result()], ['  ', result()], [REPO, null], [REPO, {}], [REPO, result({ headSha: '' })], [REPO, 'text'], [42, result()]]) {
    assert.doesNotThrow(() => assert.equal(saveBranchCheck(...args), false), JSON.stringify(args).slice(0, 60));
  }
  for (const args of [[null, SHA], [REPO, null], [REPO, ''], ['', SHA], [undefined, undefined], [REPO, 42]]) {
    assert.doesNotThrow(() => assert.equal(loadBranchCheck(...args), null));
  }
  assert.deepEqual(fs.readdirSync(dir), [], 'a refused save writes nothing');
});

test('a save that fails after writing its temp file removes the temp file and returns false', (t) => {
  const dir = setup(t);
  // a directory sitting where the result file must go makes the final rename fail
  const target = path.join(dir, nameFor(REPO, SHA));
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'in-the-way'), 'x');
  assert.equal(saveBranchCheck(REPO, result()), false);
  assert.deepEqual(fs.readdirSync(dir), [nameFor(REPO, SHA)], 'no .tmp file is left behind');
  assert.equal(loadBranchCheck(REPO, SHA), null);
});

test('the store directory is created when it does not exist yet', (t) => {
  const dir = setup(t);
  const fresh = path.join(dir, 'not', 'there', 'yet');
  process.env.AGENT_MANAGER_BRANCH_CHECK_DIR = fresh;
  assert.equal(saveBranchCheck(REPO, result()), true);
  assert.ok(fs.existsSync(path.join(fresh, nameFor(REPO, SHA))));
  assert.deepEqual(loadBranchCheck(REPO, SHA), result());
});

