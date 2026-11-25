'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OUTCOME, park } = require('./outcome.js');

test('OUTCOME has exactly the three statuses', () => {
  assert.deepEqual(Object.values(OUTCOME).sort(), ['error', 'needs_human', 'saved']);
});

test('park returns needs_human with a reason and a handoff carrying the item id', () => {
  const r = park({ id: 't1', title: 'Add thing' }, {
    reason: 'missing API credential',
    partial: { file: 'src/a.js' },
    missing: ['API_KEY'],
  });
  assert.equal(r.status, 'needs_human');
  assert.ok(r.reason.length > 0);
  assert.equal(r.handoff.id, 't1');
  assert.equal(r.handoff.title, 'Add thing');
  assert.deepEqual(r.handoff.missing, ['API_KEY']);
  assert.deepEqual(r.handoff.partial, { file: 'src/a.js' });
});

test('park rejects an empty reason', () => {
  assert.throws(() => park({ id: 't1' }, { reason: '   ' }), /non-empty reason/);
});

test('park rejects an item without an id', () => {
  assert.throws(() => park({}, { reason: 'x' }), /item\.id is required/);
});
