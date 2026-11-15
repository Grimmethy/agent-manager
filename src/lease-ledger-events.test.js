'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./lease-ledger.js');

const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const HOUR = 3600 * 1000;

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-events-'));
  const pipelineDir = path.join(dir, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'adhoc'), { recursive: true });
  return { dir, pipelineDir, env: { HOME: '/nonexistent-home', AGENT_MANAGER_NODES_DIR: path.join(dir, 'nodes') } };
}

function writeRecord(w, id, extra = {}) {
  const file = path.join(w.pipelineDir, 'queue', 'adhoc', `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, ...extra }));
  return file;
}

test('the default lease lasts one hour and the event list is the closed six', () => {
  const w = tmp();
  assert.equal(L.DEFAULT_TTL_MS, HOUR);
  assert.equal(L.defaultTtlMs(w.env), HOUR);
  assert.equal(L.lendLease('t', 'grimm', { now: T0, env: w.env }).expiresAt, new Date(T0 + HOUR).toISOString());
  assert.deepEqual(L.EVENTS, ['drafted', 'reviewed', 'applied', 'merged', 'blocked', 'failed']);
});

test('recordEvent stamps lastEvent and lastEventAt, keeps the lease lent, and refuses an event outside the list', () => {
  const w = tmp();
  L.lendLease('t', 'grimm', { now: T0, env: w.env });
  const row = L.recordEvent('t', 'drafted', { now: T0 + 5000, env: w.env });
  assert.equal(row.lastEvent, 'drafted');
  assert.equal(row.lastEventAt, new Date(T0 + 5000).toISOString());
  assert.equal(row.state, 'lent');
  assert.deepEqual(L.leaseFor('t', w.env), row);
  for (const bad of ['done', '', 'Merged', undefined]) assert.throws(() => L.recordEvent('t', bad, { env: w.env }), /event must be one of/);
  assert.equal(L.leaseFor('t', w.env).lastEvent, 'drafted');
  assert.equal(L.recordEvent('unknown-task', 'drafted', { env: w.env }), null);
});

test('a merged event closes the lease so the task no longer counts as lent', () => {
  const w = tmp();
  L.lendLease('t', 'grimm', { now: T0, env: w.env });
  const row = L.recordEvent('t', 'merged', { now: T0 + 1000, env: w.env });
  assert.equal(row.state, 'merged');
  assert.equal(row.mergedAt, new Date(T0 + 1000).toISOString());
  assert.equal(L.returnLease('t', { env: w.env }), null);
  assert.deepEqual(L.expireLeases({ now: T0 + 5 * HOUR, env: w.env }), []);
  assert.ok(L.lendLease('t', 'wok', { now: T0 + 2000, env: w.env }), 'a merged lease may be replaced');
});

test('settleExpired renews an in-progress lease for another ttl and closes a merged one', async () => {
  const w = tmp();
  L.lendLease('a', 'grimm', { now: T0, env: w.env });
  L.lendLease('b', 'grimm', { now: T0, env: w.env });
  const asked = [];
  const answers = { a: 'in-progress', b: 'merged' };
  const out = await L.settleExpired({ askNode: async (node, id) => { asked.push([node, id]); return answers[id]; }, now: T0 + HOUR, env: w.env });
  assert.deepEqual(asked, [['grimm', 'a'], ['grimm', 'b']]);
  assert.deepEqual(out.renewed.map((r) => r.taskId), ['a']);
  assert.deepEqual(out.merged.map((r) => r.taskId), ['b']);
  assert.deepEqual(out.released, []);
  const a = L.leaseFor('a', w.env);
  assert.equal(a.state, 'lent');
  assert.equal(a.expiresAt, new Date(T0 + 2 * HOUR).toISOString());
  assert.equal(a.renewedAt, new Date(T0 + HOUR).toISOString());
  assert.equal(L.leaseFor('b', w.env).state, 'merged');
});

test('settleExpired does not ask about a live lease', async () => {
  const w = tmp();
  L.lendLease('a', 'grimm', { now: T0, env: w.env });
  let calls = 0;
  const out = await L.settleExpired({ askNode: async () => { calls += 1; return 'merged'; }, now: T0 + HOUR - 1, env: w.env });
  assert.equal(calls, 0);
  assert.deepEqual(out, { merged: [], renewed: [], released: [] });
  assert.equal(L.leaseFor('a', w.env).state, 'lent');
});

test('an unknown answer, a thrown error and a junk answer all put the task back in the pool and clear leasedTo', async () => {
  const w = tmp();
  for (const id of ['u', 'e', 'j']) {
    L.lendLease(id, 'grimm', { now: T0, env: w.env });
    writeRecord(w, id, { leasedTo: 'grimm' });
  }
  writeRecord(w, 'other', { leasedTo: 'someone-else' });
  const answer = { u: () => 'unknown', e: () => { throw new Error('node unreachable'); }, j: () => 'maybe' };
  const out = await L.settleExpired({ askNode: async (node, id) => answer[id](), pipelineDirs: [w.pipelineDir], now: T0 + HOUR, env: w.env });
  assert.deepEqual(out.released.map((r) => r.taskId).sort(), ['e', 'j', 'u']);
  for (const id of ['u', 'e', 'j']) {
    assert.equal(L.leaseFor(id, w.env).state, 'expired', id);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.pipelineDir, 'queue', 'adhoc', `${id}.json`), 'utf8')).leasedTo, undefined, id);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.pipelineDir, 'queue', 'adhoc', 'other.json'), 'utf8')).leasedTo, 'someone-else');
});

test('one lease can be merged while another is released in the same pass, and an unknown answer never touches the merged one', async () => {
  const w = tmp();
  L.lendLease('m', 'grimm', { now: T0, env: w.env });
  L.lendLease('x', 'grimm', { now: T0, env: w.env });
  writeRecord(w, 'm', { leasedTo: 'grimm' });
  writeRecord(w, 'x', { leasedTo: 'grimm' });
  const out = await L.settleExpired({ askNode: async (n, id) => (id === 'm' ? 'merged' : 'unknown'), pipelineDirs: [w.pipelineDir], now: T0 + HOUR, env: w.env });
  assert.deepEqual(out.merged.map((r) => r.taskId), ['m']);
  assert.deepEqual(out.released.map((r) => r.taskId), ['x']);
  assert.equal(L.leaseFor('m', w.env).state, 'merged');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.pipelineDir, 'queue', 'adhoc', 'm.json'), 'utf8')).leasedTo, 'grimm');
});

test('a junk answer on its own releases the task like unknown', async () => {
  const w = tmp();
  L.lendLease('j', 'grimm', { now: T0, env: w.env });
  writeRecord(w, 'j', { leasedTo: 'grimm' });
  const out = await L.settleExpired({ askNode: async () => 'maybe', pipelineDirs: [w.pipelineDir], now: T0 + HOUR, env: w.env });
  assert.deepEqual(out.released.map((r) => r.taskId), ['j']);
  assert.equal(L.leaseFor('j', w.env).state, 'expired');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.pipelineDir, 'queue', 'adhoc', 'j.json'), 'utf8')).leasedTo, undefined);
});

test('a lease that closed while the node was being asked is left alone, whatever the node answered', async () => {
  const w = tmp();
  L.lendLease('a', 'grimm', { now: T0, env: w.env });
  const out = await L.settleExpired({
    askNode: async (n, id) => { L.recordEvent(id, 'merged', { now: T0 + HOUR, env: w.env }); return 'in-progress'; },
    now: T0 + HOUR, env: w.env,
  });
  assert.deepEqual(out, { merged: [], renewed: [], released: [] });
  const row = L.leaseFor('a', w.env);
  assert.equal(row.state, 'merged');
  assert.equal(row.renewedAt, undefined);
});

test('a lease that was re-lent while the node was being asked is not closed by the old answer', async () => {
  const w = tmp();
  L.lendLease('a', 'grimm', { now: T0, env: w.env });
  const out = await L.settleExpired({
    askNode: async (n, id) => { L.lendLease(id, 'grimm', { now: T0 + HOUR, ttlMs: 10 * HOUR, env: w.env }); return 'merged'; },
    now: T0 + HOUR, env: w.env,
  });
  assert.deepEqual(out.merged, []);
  assert.equal(L.leaseFor('a', w.env).state, 'lent');
});

test('a lease cancelled while the node was being asked is skipped without a crash', async () => {
  const w = tmp();
  L.lendLease('a', 'grimm', { now: T0, env: w.env });
  const out = await L.settleExpired({
    askNode: async (n, id) => { L.cancelLease(id, { env: w.env }); return 'merged'; },
    now: T0 + HOUR, env: w.env,
  });
  assert.deepEqual(out, { merged: [], renewed: [], released: [] });
  assert.equal(L.leaseFor('a', w.env), null);
});
