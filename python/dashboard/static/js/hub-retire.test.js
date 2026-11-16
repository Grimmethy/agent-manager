'use strict';
// Run: node --test python/dashboard/static/js/hub-retire.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { hubRetireRequest, hubRetirePreview, hubRetireOutcome } = require('./hub-retire.js');

test('hubRetireRequest encodes the hub id into the URL', () => {
  const result = hubRetireRequest('a b', 'stale');
  assert.equal(result.url, '/api/hub/a%20b/retire');
});

test('hubRetireRequest trims the reason in the body', () => {
  const result = hubRetireRequest('hub1', '  stale  ');
  assert.deepEqual(result.body, { reason: 'stale' });
});

test('hubRetireRequest returns an error for a whitespace-only reason', () => {
  const result = hubRetireRequest('hub1', '   ');
  assert.ok('error' in result);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  assert.equal(result.url, undefined);
});

test('hubRetirePreview keeps every child and preserves review state', () => {
  const subTasks = [
    { id: 't1', state: 'done', title: 'First' },
    { id: 't2', state: 'review', title: 'Second' },
    { id: 't3', state: 'pending', title: 'Third' },
  ];
  const preview = hubRetirePreview(subTasks);
  assert.equal(preview.length, subTasks.length);
  const review = preview.find((t) => t.id === 't2');
  assert.ok(review, 'review child must be present');
  assert.equal(review.state, 'review');
});

test('hubRetireOutcome closes the dialog on 204', () => {
  assert.deepEqual(hubRetireOutcome(204, {}), { close: true });
});

test('hubRetireOutcome keeps the dialog open with the server message on 409', () => {
  assert.deepEqual(hubRetireOutcome(409, { description: 'busy' }), { close: false, message: 'busy' });
});
