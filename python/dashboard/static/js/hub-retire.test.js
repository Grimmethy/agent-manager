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

// --- Batch helper tests ---

const { keyFor, retireUrl, sortInnermostFirst, summarizeBatch, runBatch } = require('./hub-retire.js');

test('keyFor returns repoRoot + NUL + hubId', () => {
  assert.equal(keyFor('repoA', 'h1'), 'repoA\u0000h1');
});

test('keyFor uses NUL separator between repoRoot and hubId', () => {
  const key = keyFor('repoA', 'h1');
  assert.ok(key.includes('\u0000'), 'key must contain NUL separator');
  const parts = key.split('\u0000');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], 'repoA');
  assert.equal(parts[1], 'h1');
});

test('retireUrl builds the per-hub retire URL', () => {
  assert.equal(
    retireUrl('/repoA'),
    '/api/retire?repoRoot=%2FrepoA'
  );
});

test('sortInnermostFirst sorts by depth descending', () => {
  const rows = [
    { repoRoot: '/a', hubId: 'h1', depth: 1 },
    { repoRoot: '/b', hubId: 'h2', depth: 3 },
    { repoRoot: '/c', hubId: 'h3', depth: 2 }
  ];
  const sorted = sortInnermostFirst(rows);
  assert.equal(sorted[0].depth, 3);
  assert.equal(sorted[1].depth, 2);
  assert.equal(sorted[2].depth, 1);
});

test('sortInnermostFirst uses keyFor as tie-breaker', () => {
  const rows = [
    { repoRoot: '/b', hubId: 'h1', depth: 2 },
    { repoRoot: '/a', hubId: 'h1', depth: 2 }
  ];
  const sorted = sortInnermostFirst(rows);
  assert.equal(sorted[0].repoRoot, '/a');
  assert.equal(sorted[1].repoRoot, '/b');
});

test('sortInnermostFirst does not mutate input', () => {
  const rows = [
    { repoRoot: '/a', hubId: 'h1', depth: 1 },
    { repoRoot: '/b', hubId: 'h2', depth: 2 }
  ];
  const original = JSON.parse(JSON.stringify(rows));
  sortInnermostFirst(rows);
  assert.deepEqual(rows, original);
});

test('summarizeBatch returns archived and left arrays', () => {
  const rows = [
    { repoRoot: '/a', hubId: 'h1' },
    { repoRoot: '/b', hubId: 'h2' }
  ];
  const results = new Map([
    [keyFor('/a', 'h1'), { archived: true }],
    [keyFor('/b', 'h2'), { archived: false, reason: 'conflict' }]
  ]);
  const { archived, left } = summarizeBatch(rows, results);
  assert.equal(archived.length, 1);
  assert.equal(left.length, 1);
  assert.equal(left[0].reason, 'conflict');
});

test('summarizeBatch throws when rows are unaccounted for', () => {
  const rows = [
    { repoRoot: '/a', hubId: 'h1' },
    { repoRoot: '/b', hubId: 'h2' }
  ];
  const results = new Map([
    [keyFor('/a', 'h1'), { archived: true }]
  ]);
  assert.throws(() => summarizeBatch(rows, results), /row not found in results/);
});

test('summarizeBatch identifies rows by keyFor, not hubId alone', () => {
  const rows = [
    { repoRoot: '/repoA', hubId: 'h1' },
    { repoRoot: '/repoB', hubId: 'h1' }
  ];
  const results = new Map([
    [keyFor('/repoA', 'h1'), { archived: true }],
    [keyFor('/repoB', 'h1'), { archived: false, reason: 'conflict' }]
  ]);
  const { archived, left } = summarizeBatch(rows, results);
  assert.equal(archived.length, 1);
  assert.equal(left.length, 1);
  assert.equal(left[0].hubId, 'h1');
  assert.equal(left[0].key, keyFor('/repoB', 'h1'));
});

test('runBatch awaits send one row at a time', async () => {
  const rows = [
    { repoRoot: '/a', hubId: 'h1' },
    { repoRoot: '/b', hubId: 'h2' }
  ];
  const sent = [];
  const send = async (url, body) => {
    sent.push({ url, body });
    return { archived: true };
  };
  const results = await runBatch(rows, send);
  assert.equal(sent.length, 2);
  assert.equal(results.size, 2);
});

test('runBatch continues past a rejected send', async () => {
  const rows = [
    { repoRoot: '/a', hubId: 'h1' },
    { repoRoot: '/b', hubId: 'h2' }
  ];
  const send = async (url, body) => {
    if (body.project === '/a') throw new Error('network error');
    return { archived: true };
  };
  const results = await runBatch(rows, send);
  assert.equal(results.size, 2);
  assert.equal(results.get(keyFor('/a', 'h1')).reason, 'network error');
  assert.equal(results.get(keyFor('/b', 'h2')).archived, true);
});

test('runBatch uses keyFor to identify rows in results', async () => {
  const rows = [
    { repoRoot: '/repoA', hubId: 'h1' },
    { repoRoot: '/repoB', hubId: 'h1' }
  ];
  const send = async () => ({ archived: true });
  const results = await runBatch(rows, send);
  assert.equal(results.size, 2);
  assert.ok(results.has(keyFor('/repoA', 'h1')));
  assert.ok(results.has(keyFor('/repoB', 'h1')));
});

test('runBatch sends body with project field carrying repo root', async () => {
  const rows = [
    { repoRoot: '/my-repo', hubId: 'h1' }
  ];
  let capturedBody = null;
  const send = async (url, body) => {
    capturedBody = body;
    return { archived: true };
  };
  await runBatch(rows, send);
  assert.deepEqual(capturedBody, { project: '/my-repo' });
});
