'use strict';

// HUB0281-02: prioritizeEntry() in the browser script brain-dump-and-second-brain.js. The file is a plain <script> (no module.exports), so the function is cut
// out of the source text and run in a vm context with a stub fetch, a stub window.confirm and the real prioritizeRefusal from brain-dump-chips.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { prioritizeRefusal } = require('../python/dashboard/static/js/brain-dump-chips.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'python/dashboard/static/js/brain-dump-and-second-brain.js'), 'utf8');

function functionSource(name) {
  const start = SRC.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `async function ${name} not found`);
  const end = SRC.indexOf('\n}\n', start);
  return SRC.slice(start, end + 3);
}

// responses: array of { status, body } returned by successive fetch calls (body is the JSON the server sends, or a string for a non-JSON body).
function harness(responses, confirmAnswer = true) {
  const fetches = [];
  const confirms = [];
  const sandbox = {
    encodeURIComponent, JSON, prioritizeRefusal,
    window: { confirm: (m) => { confirms.push(m); return confirmAnswer; } },
    fetch: async (url, opts) => {
      fetches.push({ url, opts });
      const r = responses.shift() || { status: 200, body: {} };
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${functionSource('prioritizeEntry')}; this.prioritizeEntry = prioritizeEntry;`, sandbox);
  return { prioritizeEntry: sandbox.prioritizeEntry, fetches, confirms };
}

test('the browser script has no top-level require (it runs as a plain <script>, where require is undefined)', () => {
  assert.doesNotMatch(SRC, /^\s*(const|let|var)\s.*=\s*require\(/m);
  assert.doesNotMatch(SRC, /\brequire\(/);
});

test('a 200 queues with one plain POST and no prompt', async () => {
  const h = harness([{ status: 200, body: { queued: true } }]);
  const r = await h.prioritizeEntry('bd-1');
  assert.deepEqual({ ...r }, { queued: true, declined: false, status: 200 });
  assert.equal(h.fetches.length, 1);
  assert.equal(h.fetches[0].url, '/api/brain-dump/bd-1/prioritize');
  assert.equal(h.fetches[0].opts.body, undefined);
  assert.equal(h.confirms.length, 0);
});

test('a 409 asks with the server reason and a yes re-POSTs once with {force:true}', async () => {
  const h = harness([{ status: 409, body: { description: 'Process now was not run: target missing' } }, { status: 200, body: {} }], true);
  const r = await h.prioritizeEntry('bd-2');
  assert.deepEqual({ ...r }, { queued: true, declined: false, status: 200 });
  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0], /Process now was not run: target missing/);
  assert.equal(h.fetches.length, 2);
  assert.equal(h.fetches[1].opts.body, JSON.stringify({ force: true }));
  assert.equal(h.fetches[1].opts.headers['Content-Type'], 'application/json');
});

test('a 409 the owner declines queues nothing and does not re-POST', async () => {
  const h = harness([{ status: 409, body: { description: 'held back' } }], false);
  const r = await h.prioritizeEntry('bd-3');
  assert.deepEqual({ ...r }, { queued: false, declined: true, status: 409 });
  assert.equal(h.fetches.length, 1);
  assert.equal(h.confirms.length, 1);
});

test('a 409 whose body is not JSON still asks (without a reason)', async () => {
  const h = harness([{ status: 409, body: '<html>nope' }, { status: 200, body: {} }], true);
  const r = await h.prioritizeEntry('bd-4');
  assert.equal(r.queued, true);
  assert.equal(h.confirms.length, 1);
});

test('a 409 on the forced re-POST does not prompt again', async () => {
  const h = harness([{ status: 409, body: { description: 'a' } }, { status: 409, body: { description: 'b' } }], true);
  const r = await h.prioritizeEntry('bd-5');
  assert.deepEqual({ ...r }, { queued: false, declined: false, status: 409 });
  assert.equal(h.confirms.length, 1);
  assert.equal(h.fetches.length, 2);
});

test('other failures (404, 500) do not prompt or retry', async () => {
  for (const status of [404, 500]) {
    const h = harness([{ status, body: { description: 'x' } }]);
    const r = await h.prioritizeEntry('bd-6');
    assert.deepEqual({ ...r }, { queued: false, declined: false, status });
    assert.equal(h.confirms.length, 0);
    assert.equal(h.fetches.length, 1);
  }
});

test('the id is URL-encoded', async () => {
  const h = harness([{ status: 200, body: {} }]);
  await h.prioritizeEntry('a b/c');
  assert.equal(h.fetches[0].url, '/api/brain-dump/a%20b%2Fc/prioritize');
});
