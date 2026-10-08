'use strict';

// find-recheck.js and recheckFinalEdits (implement-critique.js): the FINAL edit set must apply, in apply order.
// Run: node --test src/lib/find-recheck.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { simulateEdits, feedbackFor, nearestExcerpt, signatureOf, recheckMode } = require('./find-recheck.js');
const { recheckFinalEdits } = require('./implement-critique.js');

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-recheck-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}
const FILE = 'import os\n\ndef run(x):\n    return x + 1\n\ndef other():\n    return 2\n';

test('an edit whose find matches exactly once passes; zero matches and several matches are flagged with the real nearby lines', () => {
  const dir = repo({ 'a.py': FILE });
  assert.deepEqual(simulateEdits([{ mode: 'edit', file: 'a.py', find: 'return x + 1', replace: 'return x + 2' }], dir), []);
  const miss = simulateEdits([{ mode: 'edit', file: 'a.py', find: 'from django.conf import settings', replace: 'x' }], dir);
  assert.equal(miss.length, 1);
  assert.equal(miss[0].type, 'find_not_found');
  assert.equal(miss[0].index, 0);
  const many = simulateEdits([{ mode: 'edit', file: 'a.py', find: 'return', replace: 'x' }], dir);
  assert.equal(many[0].type, 'find_ambiguous');
  assert.match(many[0].detail, /matches 2 times/);
  const near = simulateEdits([{ mode: 'edit', file: 'a.py', find: 'def run(x, y):\n    return x + 1', replace: 'x' }], dir)[0];
  assert.equal(near.type, 'find_not_found');
  assert.match(near.excerpt.text, /3\| def run\(x\):/, 'the excerpt shows the real line to copy');
  assert.match(feedbackFor([near]), /Copy the `find` text from these real lines/);
});

test('items replay in apply order: a later edit may depend on an earlier one, and an earlier edit can break a later one', () => {
  const dir = repo({ 'a.py': FILE });
  const ok = simulateEdits([
    { mode: 'edit', file: 'a.py', find: 'return x + 1', replace: 'return helper(x)' },
    { mode: 'edit', file: 'a.py', find: 'return helper(x)', replace: 'return helper(x, 2)' },
  ], dir);
  assert.deepEqual(ok, [], 'the second find only exists after the first edit');
  const broken = simulateEdits([
    { mode: 'edit', file: 'a.py', find: 'return x + 1', replace: 'return 0' },
    { mode: 'edit', file: 'a.py', find: 'return x + 1', replace: 'return 9' },
  ], dir);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].index, 1, 'the first edit consumed the text the second wants');
});

test('create / delete / missing-file semantics mirror apply-group-b', () => {
  const dir = repo({ 'a.py': FILE });
  assert.deepEqual(simulateEdits([
    { mode: 'create', file: 'new.js', content: 'let a = 1;\n' },
    { mode: 'edit', file: 'new.js', find: 'let a = 1;', replace: 'let a = 2;' },
  ], dir), [], 'an edit on a file an earlier item creates is checked against the created content');
  assert.equal(simulateEdits([{ mode: 'create', file: 'a.py', content: 'x' }], dir)[0].type, 'create_exists');
  assert.equal(simulateEdits([{ mode: 'edit', file: 'ghost.py', find: 'x', replace: 'y' }], dir)[0].type, 'missing_file');
  assert.equal(simulateEdits([{ mode: 'delete', file: 'a.py' }, { mode: 'edit', file: 'a.py', find: 'import os', replace: 'x' }], dir)[0].type, 'missing_file', 'edit after delete');
  assert.deepEqual(simulateEdits([{ mode: 'delete', file: 'a.py' }, { mode: 'create', file: 'a.py', content: 'x' }], dir), [], 'delete then create is fine');
  assert.equal(simulateEdits([{ mode: 'edit', file: 'a.py', replace: 'y' }], dir)[0].type, 'find_not_found', 'an edit with no find cannot apply');
});

test('unparsable or empty input yields no flags and never throws; the mode env defaults to block', () => {
  assert.deepEqual(simulateEdits(null, '/nope'), []);
  assert.deepEqual(simulateEdits([null, 5, { mode: 'edit' }], '/nope'), []);
  assert.equal(recheckMode({}), 'block');
  assert.equal(recheckMode({ AGENT_MANAGER_FIND_RECHECK: 'OFF' }), 'off');
  assert.equal(recheckMode({ AGENT_MANAGER_FIND_RECHECK: 'advisory' }), 'advisory');
  assert.equal(nearestExcerpt('a\nb\n', 'zzzzzzzz').nearLine, null);
  assert.equal(signatureOf([{ type: 'x', file: 'f', index: 1 }]), 'x:f:1');
});

// --- recheckFinalEdits ---

function withRepo(files, fn) {
  const dir = repo(files);
  const prev = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  return Promise.resolve(fn(dir)).finally(() => { if (prev === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prev; });
}
const BAD = JSON.stringify([{ mode: 'edit', file: 'a.py', find: 'from django.conf import settings', replace: 'x' }]);
const GOOD = JSON.stringify([{ mode: 'edit', file: 'a.py', find: 'return x + 1', replace: 'return x + 2' }]);
const ctx = (responses, calls = []) => ({
  maybeLocked: async (_l, fn) => fn(),
  resolvedCallIsLocal: true,
  profileSupportsThink: false,
  attempt: {},
  recordModelCall: null,
  resolvedLocalCall: async ({ prompt }) => { calls.push(prompt); return { response: responses.shift() }; },
});
const mkTask = (id, over = {}) => ({ id, source: 'group_b_fixture', domain: 'default', planResponse: 'PLAN', implementResponse: BAD, history: [], ...over });

test('recheckFinalEdits: a failing edit set is repaired by ONE fix call that is shown the real lines', async () => {
  await withRepo({ 'a.py': FILE }, async () => {
    const calls = [];
    const task = mkTask('fr-1');
    const blocked = await recheckFinalEdits(task, ctx([GOOD], calls));
    assert.equal(blocked, false);
    assert.equal(task.implementResponse, GOOD);
    assert.equal(task.revisionApplied, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /find string not found in a\.py/);
    assert.match(calls[0], /1\| import os/, 'the file head is shown when nothing is near');
    assert.ok(task.history.some((h) => /corrected by one bounded fix call/.test(h.detail || '')));
  });
});

test('recheckFinalEdits: a fix that still fails (or is degenerate / prose) blocks the draft with the feedback for the redraft; the same failure twice downgrades', async () => {
  await withRepo({ 'a.py': FILE }, async () => {
    const task = mkTask('fr-2');
    assert.equal(await recheckFinalEdits(task, ctx([BAD])), true);
    assert.equal(task.critiqueOutcome, 'find-recheck-failed');
    assert.equal(task.blockedStage, 'review');
    assert.match(task.blockedReason, /Edit set would not apply: .*find string not found in a\.py/);
    assert.match(task.priorRejectionFeedback.join('\n'), /find string not found/);
    assert.ok(task.findRecheckBlocked);
    // prose answer: not a valid fix either
    const prose = mkTask('fr-2b');
    assert.equal(await recheckFinalEdits(prose, ctx(['The find string is wrong, sorry.'])), true);
    // the retry produces the same failure: waved through as an advisory, no model call
    const calls = [];
    const again = mkTask('fr-3', { findRecheckBlocked: task.findRecheckBlocked });
    assert.equal(await recheckFinalEdits(again, ctx([GOOD], calls)), false);
    assert.equal(calls.length, 0);
    assert.ok(again.history.some((h) => h.stage === 'advisory' && /not blocking again/.test(h.detail || '')));
    assert.equal(again.findRecheckBlocked, undefined);
  });
});

test('recheckFinalEdits: a clean edit set, a non-JSON answer, advisory mode and off are all untouched', async () => {
  await withRepo({ 'a.py': FILE }, async () => {
    const calls = [];
    const clean = mkTask('fr-ok', { implementResponse: GOOD });
    assert.equal(await recheckFinalEdits(clean, ctx([], calls)), false);
    assert.equal(calls.length, 0);
    assert.equal(await recheckFinalEdits(mkTask('fr-fp', { implementResponse: 'FALSE POSITIVE -- already fixed' }), ctx([], calls)), false);
    const prev = process.env.AGENT_MANAGER_FIND_RECHECK;
    try {
      process.env.AGENT_MANAGER_FIND_RECHECK = 'advisory';
      const adv = mkTask('fr-adv');
      assert.equal(await recheckFinalEdits(adv, ctx([GOOD], calls)), false);
      assert.equal(calls.length, 0);
      assert.equal(adv.implementResponse, BAD, 'advisory never changes the answer');
      assert.ok(adv.history.some((h) => h.stage === 'advisory' && /advisory mode/.test(h.detail || '')));
      process.env.AGENT_MANAGER_FIND_RECHECK = 'off';
      const off = mkTask('fr-off');
      assert.equal(await recheckFinalEdits(off, ctx([GOOD], calls)), false);
      assert.deepEqual(off.history, []);
    } finally { if (prev === undefined) delete process.env.AGENT_MANAGER_FIND_RECHECK; else process.env.AGENT_MANAGER_FIND_RECHECK = prev; }
  });
});

test('recheckFinalEdits: a source with its own apply (adhoc diffs) is never rechecked', async () => {
  await withRepo({ 'a.py': FILE }, async () => {
    const calls = [];
    const task = mkTask('fr-adhoc', { source: 'manual', domain: 'adhoc' });
    assert.equal(await recheckFinalEdits(task, ctx([GOOD], calls)), false);
    assert.equal(calls.length, 0);
    assert.equal(task.implementResponse, BAD);
  });
});
