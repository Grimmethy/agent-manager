'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const L = require('./lease-ledger.js');

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-ledger-'));
  return { dir, env: { HOME: '/nonexistent-home', AGENT_MANAGER_NODES_DIR: dir } };
}

test('lend creates a lent lease that expires after the ttl and is written to leases.json in the nodes directory', () => {
  const { dir, env } = tmp();
  const lease = L.lendLease('t1', 'grimm', { ttlMs: 60000, now: T0, env });
  assert.deepEqual(lease, { taskId: 't1', nodeId: 'grimm', leasedAt: '2026-11-11T12:00:00.000Z', expiresAt: '2026-11-11T12:01:00.000Z', state: 'lent' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8')), { t1: lease });
  assert.deepEqual(L.leaseFor('t1', env), lease);
  assert.equal(L.leaseFor('nope', env), null);
});

test('the default ttl is six hours and AGENT_MANAGER_LEASE_TTL_MS overrides it; junk falls back', () => {
  const { env } = tmp();
  assert.equal(L.defaultTtlMs(env), 6 * 3600 * 1000);
  assert.equal(L.lendLease('a', 'grimm', { now: T0, env }).expiresAt, '2026-11-11T18:00:00.000Z');
  assert.equal(L.defaultTtlMs({ ...env, AGENT_MANAGER_LEASE_TTL_MS: '1000' }), 1000);
  assert.equal(L.defaultTtlMs({ ...env, AGENT_MANAGER_LEASE_TTL_MS: 'soon' }), 6 * 3600 * 1000);
  assert.equal(L.defaultTtlMs({ ...env, AGENT_MANAGER_LEASE_TTL_MS: '-5' }), 6 * 3600 * 1000);
});

test('a ttl that is not a positive number falls back to the default instead of producing a broken expiry', () => {
  const { env } = tmp();
  for (const [i, bad] of [-5, 0, NaN, 'soon'].entries()) {
    assert.equal(L.lendLease('t' + i, 'grimm', { ttlMs: bad, now: T0, env }).expiresAt, '2026-11-11T18:00:00.000Z', String(bad));
  }
});

test('a second lend of a live lease is refused and leaves the first untouched', () => {
  const { env } = tmp();
  const first = L.lendLease('t1', 'grimm', { ttlMs: 60000, now: T0, env });
  assert.equal(L.lendLease('t1', 'other', { ttlMs: 60000, now: T0 + 1000, env }), null);
  assert.deepEqual(L.leaseFor('t1', env), first);
});

test('an expired or a returned lease can be lent again', () => {
  const { env } = tmp();
  L.lendLease('t1', 'grimm', { ttlMs: 1000, now: T0, env });
  assert.equal(L.lendLease('t1', 'b', { ttlMs: 1000, now: T0 + 1000, env }).nodeId, 'b', 'at expiresAt the lease no longer blocks');
  L.returnLease('t1', { now: T0 + 1500, env });
  assert.equal(L.lendLease('t1', 'c', { ttlMs: 1000, now: T0 + 2000, env }).nodeId, 'c');
});

test('return marks a lent lease returned once; unknown or already returned tasks give null', () => {
  const { env } = tmp();
  L.lendLease('t1', 'grimm', { now: T0, env });
  const r = L.returnLease('t1', { now: T0 + 5000, env });
  assert.equal(r.state, 'returned');
  assert.equal(r.returnedAt, '2026-11-11T12:00:05.000Z');
  assert.equal(L.returnLease('t1', { env }), null);
  assert.equal(L.returnLease('missing', { env }), null);
});

test('expireLeases expires exactly the lent leases whose time has come, returns them, and does not touch the others', () => {
  const { env } = tmp();
  L.lendLease('early', 'grimm', { ttlMs: 1000, now: T0, env });
  L.lendLease('late', 'grimm', { ttlMs: 9000, now: T0, env });
  L.lendLease('done', 'grimm', { ttlMs: 1000, now: T0, env });
  L.returnLease('done', { now: T0, env });
  assert.deepEqual(L.expireLeases({ now: T0 + 999, env }), [], 'nothing yet one millisecond before expiry');
  const expired = L.expireLeases({ now: T0 + 1000, env });
  assert.deepEqual(expired.map((l) => l.taskId), ['early']);
  assert.equal(L.leaseFor('early', env).state, 'expired');
  assert.equal(L.leaseFor('late', env).state, 'lent');
  assert.equal(L.leaseFor('done', env).state, 'returned');
  assert.deepEqual(L.expireLeases({ now: T0 + 1000, env }), [], 'a second sweep finds nothing new');
});

test('a damaged or non-object leases.json reads as empty and a new lend replaces it', () => {
  const { dir, env } = tmp();
  fs.writeFileSync(path.join(dir, 'leases.json'), '{oops');
  assert.deepEqual(L.listLeases(env), []);
  fs.writeFileSync(path.join(dir, 'leases.json'), '[1,2]');
  assert.deepEqual(L.listLeases(env), []);
  assert.ok(L.lendLease('t1', 'grimm', { now: T0, env }));
  assert.equal(L.listLeases(env).length, 1);
});

test('the nodes directory is created on demand', () => {
  const { dir } = tmp();
  const env = { HOME: '/x', AGENT_MANAGER_NODES_DIR: path.join(dir, 'deep', 'nodes') };
  assert.ok(L.lendLease('t1', 'grimm', { now: T0, env }));
  assert.ok(fs.existsSync(path.join(dir, 'deep', 'nodes', 'leases.json')));
});

test('main: list, lend, return and expire print JSON; a repeat lend and an unknown return exit 3; usage exits 2', () => {
  const { env } = tmp();
  const out = [];
  const run = (...argv) => L.main(argv, env, (s) => out.push(s));
  assert.equal(run('lend', 't1', 'grimm'), 0);
  assert.equal(JSON.parse(out.pop()).state, 'lent');
  assert.equal(run('lend', 't1', 'grimm'), 3);
  assert.match(out.pop(), /already has a live lease/);
  assert.equal(JSON.parse((run('list'), out.pop())).length, 1);
  assert.equal(run('return', 't1'), 0);
  assert.equal(JSON.parse(out.pop()).state, 'returned');
  assert.equal(run('return', 't1'), 3);
  assert.match(out.pop(), /no lent lease/);
  assert.equal(run('expire'), 0);
  assert.equal(out.pop(), '[]');
  assert.equal(run('lend', 'only-one-arg'), 2);
  assert.equal(run('bogus'), 2);
});

test('the CLI runs as a real process against a temp nodes directory', () => {
  const { dir, env } = tmp();
  const r = spawnSync(process.execPath, [path.join(__dirname, 'lease-ledger.js'), 'lend', 't9', 'grimm'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8')).t9.nodeId, 'grimm');
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, 'lease-ledger.js')], { env: { ...process.env, ...env }, encoding: 'utf8' }).status, 2);
});
