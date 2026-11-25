'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChangeDraft } = require('../src/review/change-draft.js');

const SAMPLE_ARTIFACT = {
  id: 'art-1',
  title: 'Fix login',
  file: 'src/auth.js',
  files: ['src/auth.js', 'test/auth.test.js'],
  body: 'Patched the login flow',
  status: 'open',
  confidenceSource: 'manual'
};

function makeDraft(overrides = {}) {
  return createChangeDraft({
    artifacts: [SAMPLE_ARTIFACT],
    actor: 'tester',
    ...overrides
  });
}

test('update throws on patch keys outside artifact schema', () => {
  const draft = makeDraft();
  assert.throws(
    () => draft.update('art-1', { unknownField: 'x' }),
    /patch key outside artifact schema: unknownField/
  );
  assert.throws(
    () => draft.update('art-1', { title: 'ok', bogus: 1 }),
    /patch key outside artifact schema: bogus/
  );
});

test('update adds one entry to history()', () => {
  const draft = makeDraft();
  const before = draft.history().length;
  draft.update('art-1', { title: 'Renamed login' });
  const after = draft.history().length;
  assert.equal(after - before, 1, 'history should grow by exactly one on update');
  const entry = draft.history()[after - 1];
  assert.equal(entry.op, 'update');
  assert.equal(entry.id, 'art-1');
  assert.equal(entry.actor, 'tester');
  assert.equal(entry.before.title, 'Fix login');
  assert.equal(entry.after.title, 'Renamed login');
});

test('remove adds one entry to history()', () => {
  const draft = makeDraft();
  const before = draft.history().length;
  draft.remove('art-1');
  const after = draft.history().length;
  assert.equal(after - before, 1, 'history should grow by exactly one on remove');
  const entry = draft.history()[after - 1];
  assert.equal(entry.op, 'remove');
  assert.equal(entry.id, 'art-1');
  assert.equal(entry.actor, 'tester');
  assert.equal(entry.after, null);
  assert.equal(entry.before.title, 'Fix login');
});

test('input changeSet is unchanged after mutations', () => {
  const input = {
    artifacts: [{ ...SAMPLE_ARTIFACT }],
    actor: 'tester'
  };
  const frozen = JSON.stringify(input);
  const draft = createChangeDraft(input);
  draft.update('art-1', { title: 'mutated' });
  draft.remove('art-1');
  assert.equal(JSON.stringify(input), frozen, 'original changeSet must not be mutated');
});

test('a throwing validation stops the apply path: history unchanged, no partial mutation', () => {
  const draft = makeDraft();
  const beforeLen = draft.history().length;
  const beforeTitle = draft.get('art-1').title;
  assert.throws(
    () => draft.update('art-1', { title: 'ok', bogus: 1 }),
    /patch key outside artifact schema/
  );
  const afterLen = draft.history().length;
  assert.equal(afterLen, beforeLen, 'history length must not change when update throws');
  assert.equal(draft.get('art-1').title, beforeTitle, 'artifact must not be partially mutated');
});

test('list() returns copies, not live references', () => {
  const draft = makeDraft();
  const listA = draft.list();
  const listB = draft.list();
  assert.notEqual(listA, listB, 'each list() call must return a new array');

  listA[0].title = 'HACKED';
  assert.equal(draft.list()[0].title, 'Fix login', 'mutating returned list must not affect draft');

  const item = draft.list()[0];
  item.title = 'HACKED TOO';
  assert.equal(draft.list()[0].title, 'Fix login', 'mutating returned item must not affect draft');
});

test('list returns deep copies of artifact objects', () => {
  const draft = makeDraft();
  const items = draft.list();
  const first = items[0];
  first.files.push('injected.js');
  assert.equal(draft.list()[0].files.length, SAMPLE_ARTIFACT.files.length, 'nested arrays must also be isolated');
});

test('get returns undefined for unknown id', () => {
  const draft = makeDraft();
  assert.equal(draft.get('nope'), undefined);
});

test('history() returns a read-only deep copy', () => {
  const draft = makeDraft();
  draft.update('art-1', { title: 'x' });
  const h1 = draft.history();
  const h2 = draft.history();
  assert.notEqual(h1, h2, 'each history() call must return a new array');
  h1.pop();
  assert.equal(draft.history().length, 1, 'mutating returned history must not affect draft');
});
