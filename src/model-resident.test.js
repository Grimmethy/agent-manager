'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./model-resident.js');

const MODEL = 'ornith:35b';
const psOf = (models) => async () => ({ ok: true, json: async () => ({ models }) });
const loaded = (ctx = 49152) => [{ name: MODEL, context_length: ctx }];

function harness({ psSequence }) {
  const calls = { ps: 0, warm: [], locks: 0 };
  let i = 0;
  const fetchFn = async () => { calls.ps += 1; const m = psSequence[Math.min(i++, psSequence.length - 1)]; return m === null ? { ok: false } : { ok: true, json: async () => ({ models: m }) }; };
  const post = async (u, body, timeoutMs) => { calls.warm.push({ u, body, timeoutMs }); };
  const withLock = async (dir, fn, key, opts) => { calls.locks += 1; calls.lockKey = key; calls.lockOpts = opts; return fn(); };
  return { calls, args: { url: 'http://x:1', model: MODEL, numCtx: 49152, instancesDir: '/i', fetchFn, post, withLock, log: () => {} } };
}

test.beforeEach(() => R.clearCache());

test('resident at the wanted context: no lock, no warm-up', async () => {
  const h = harness({ psSequence: [loaded()] });
  const r = await R.ensureResident(h.args);
  assert.equal(r.resident, true);
  assert.equal(h.calls.locks, 0);
  assert.equal(h.calls.warm.length, 0);
});

test('not resident: exactly one warm-up under the model-warmup lock, never-expire keep_alive, load-length timeout', async () => {
  const h = harness({ psSequence: [[], []] });
  const r = await R.ensureResident(h.args);
  assert.equal(r.resident, true);
  assert.equal(h.calls.lockKey, R.WARM_LOCK_KEY);
  assert.equal(h.calls.lockOpts.skipPriorityBackoff, true);
  assert.equal(h.calls.warm.length, 1);
  assert.equal(h.calls.warm[0].body.keep_alive, '8760h');
  assert.equal(h.calls.warm[0].body.options.num_ctx, 49152);
  assert.equal(h.calls.warm[0].timeoutMs, 30 * 60 * 1000);
});

test('loaded at a DIFFERENT context counts as not resident', async () => {
  const h = harness({ psSequence: [loaded(8192), loaded(8192)] });
  await R.ensureResident(h.args);
  assert.equal(h.calls.warm.length, 1);
});

test('a waiter whose predecessor finished the load while it queued sends no warm-up of its own', async () => {
  const h = harness({ psSequence: [[], loaded()] });
  const r = await R.ensureResident(h.args);
  assert.equal(r.resident, true);
  assert.equal(h.calls.locks, 1);
  assert.equal(h.calls.warm.length, 0);
});

test('three concurrent callers produce one warm-up (shared lock + recheck)', async () => {
  let resident = false; let warm = 0; let chain = Promise.resolve();
  const fetchFn = async () => ({ ok: true, json: async () => ({ models: resident ? loaded() : [] }) });
  const post = async () => { warm += 1; await new Promise((r) => setTimeout(r, 30)); resident = true; };
  const withLock = (dir, fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
  const base = { url: 'http://x:1', model: MODEL, numCtx: 49152, instancesDir: '/i', fetchFn, post, withLock, log: () => {} };
  await Promise.all([R.ensureResident(base), R.ensureResident(base), R.ensureResident(base)]);
  assert.equal(warm, 1);
});

test('a positive answer is cached so a burst costs one /api/ps', async () => {
  const h = harness({ psSequence: [loaded()] });
  await R.ensureResident(h.args); await R.ensureResident(h.args); await R.ensureResident(h.args);
  assert.equal(h.calls.ps, 1);
});

test('degrades instead of throwing: unreachable /api/ps, no instancesDir, failed warm-up', async () => {
  const h1 = harness({ psSequence: [null] });
  assert.equal((await R.ensureResident(h1.args)).skipped, 'ps-unreachable');
  const h2 = harness({ psSequence: [[]] });
  assert.equal((await R.ensureResident({ ...h2.args, instancesDir: null })).skipped, 'not-configured');
  const h3 = harness({ psSequence: [[], []] });
  const r3 = await R.ensureResident({ ...h3.args, post: async () => { throw new Error('boom'); } });
  assert.equal(r3.resident, false);
  assert.match(r3.error, /boom/);
});
