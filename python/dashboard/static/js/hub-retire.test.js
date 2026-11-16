'use strict';

// Tests for hub-retire.js (the hub retire flow helpers). Pure functions, no DOM.
// Run: node --test python/dashboard/static/js/hub-retire.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { hubRetireRequest, hubRetirePreview, hubRetireOutcome } = require('./hub-retire.js');

test('hubRetirePreview keeps a review child alongside drafting and approved ones', () => {
  const subTasks = [
    { id: 'T-1', state: 'drafting', title: 'Same title' },
    { id: 'T-2', state: 'approved', title: 'Same title' },
    { id: 'T-3', state: 'review', title: 'Review piece' },
  ];
  const out = hubRetirePreview(subTasks);
  assert.equal(out.length, 3);
  const review = out.find((c) => c.state === 'review');
  assert.ok(review, 'review child must be present');
  assert.equal(review.id, 'T-3');
  assert.deepEqual(out.map((c) => c.id), ['T-1', 'T-2', 'T-3']);
});

test('hubRetireRequest rejects an empty reason with an error and no body', () => {
  const empty = hubRetireRequest('H1', '');
  assert.ok(empty.error, 'empty reason must return an error');
  assert.equal(empty.body, undefined);
  assert.equal(empty.url, undefined);
});

test('hubRetireRequest rejects a whitespace-only reason with an error and no body', () => {
  const ws = hubRetireRequest('H1', '   ');
  assert.ok(ws.error, 'whitespace reason must return an error');
  assert.equal(ws.body, undefined);
  assert.equal(ws.url, undefined);
});

test('hubRetireRequest URL-encodes the hub id and sends the trimmed reason', () => {
  const req = hubRetireRequest('a/b c', '  reason  ');
  assert.equal(req.url, '/api/hub/' + encodeURIComponent('a/b c') + '/retire');
  assert.deepEqual(req.body, { reason: 'reason' });
});

test('hubRetireOutcome 409 keeps the dialog open with the server message', () => {
  // The server's abort(409, description=...) puts the text in `description`.
  const out = hubRetireOutcome(409, { description: 'conflict text' });
  assert.equal(out.close, false);
  assert.match(out.message, /conflict text/);
});

test('hubRetireOutcome 500 keeps the dialog open', () => {
  const out = hubRetireOutcome(500, {});
  assert.equal(out.close, false);
  assert.equal(typeof out.message, 'string');
  assert.ok(out.message.length > 0);
});

test('hubRetireOutcome 2xx closes the dialog', () => {
  assert.equal(hubRetireOutcome(200, {}).close, true);
  assert.equal(hubRetireOutcome(204, {}).close, true);
});
