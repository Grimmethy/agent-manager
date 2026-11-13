'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nodesDir, staleMinutes, isValidNodeId, loadNodes, loadTokens, registerNode, verifyToken, recordHeartbeat, statusOf, listNodes, sweepStale, main } = require('./node-registry.js');

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const MIN = 60 * 1000;
function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-registry-'));
  return { dir, env: { HOME: '/nonexistent-home', AGENT_MANAGER_NODES_DIR: dir, ...extra } };
}
const spec = (over = {}) => ({ id: 'grimm', address: '192.168.40.83', cores: 4, ramGb: 15, gpu: 'RX 580', allowedProviders: ['claude-haiku'], concurrencyCap: 3, ...over });

test('the directory defaults to the global state under HOME and the override wins; the stale limit defaults to 5 minutes', () => {
  assert.equal(nodesDir({ HOME: '/home/x' }), '/home/x/.local/state/agent-manager/nodes');
  assert.equal(nodesDir({ HOME: '/home/x', AGENT_MANAGER_NODES_DIR: '/tmp/n' }), '/tmp/n');
  assert.equal(nodesDir({ HOME: '/home/x', AGENT_MANAGER_NODES_DIR: '  ' }), '/home/x/.local/state/agent-manager/nodes');
  assert.equal(staleMinutes({}), 5);
  assert.equal(staleMinutes({ AGENT_MANAGER_NODE_STALE_MIN: '12' }), 12);
  assert.equal(staleMinutes({ AGENT_MANAGER_NODE_STALE_MIN: '-1' }), 5);
  assert.equal(staleMinutes({ AGENT_MANAGER_NODE_STALE_MIN: '0' }), 5);
});

test('node ids are lowercase letters, digits and dashes, at most 31 characters, not starting with a dash', () => {
  for (const ok of ['grimm', 'wok', 'node-2', 'a', '9lives']) assert.equal(isValidNodeId(ok), true, ok);
  for (const bad of ['', '-x', 'Grimm', 'a b', '../x', 'a/b', 'x'.repeat(32), undefined, null, 5]) assert.equal(isValidNodeId(bad), false, String(bad));
});

test('registerNode stores the record, makes a token once, and keeps the token when details are updated', () => {
  const { env } = setup();
  const first = registerNode(spec(), env);
  assert.match(first.token, /^[0-9a-f]{48}$/);
  assert.equal(first.record.id, 'grimm');
  assert.equal(first.record.cores, 4);
  assert.deepEqual(first.record.allowedProviders, ['claude-haiku']);
  assert.equal(first.record.lastSeen, null);
  assert.equal(loadNodes(env).grimm.address, '192.168.40.83');
  assert.equal(loadTokens(env).grimm, first.token);
  const again = registerNode(spec({ cores: 8 }), env);
  assert.equal(again.token, null);
  assert.equal(loadNodes(env).grimm.cores, 8);
  assert.equal(loadTokens(env).grimm, first.token);
});

test('rotate makes a new token; the token never appears in nodes.json', () => {
  const { env, dir } = setup();
  const a = registerNode(spec(), env);
  const b = registerNode(spec(), env, { rotate: true });
  assert.notEqual(b.token, a.token);
  assert.equal(loadTokens(env).grimm, b.token);
  assert.ok(!fs.readFileSync(path.join(dir, 'nodes.json'), 'utf8').includes(b.token));
});

test('the token file is private to the owner (mode 600)', () => {
  const { env, dir } = setup();
  registerNode(spec(), env);
  assert.equal(fs.statSync(path.join(dir, 'nodes-tokens.json')).mode & 0o777, 0o600);
});

test('registering rejects an invalid id and non-positive numbers and writes nothing', () => {
  const { env, dir } = setup();
  assert.throws(() => registerNode(spec({ id: 'Bad Id' }), env), /invalid node id/);
  assert.throws(() => registerNode(spec({ cores: 0 }), env), /cores must be a positive number/);
  assert.throws(() => registerNode(spec({ ramGb: -2 }), env), /ramGb must be a positive number/);
  assert.throws(() => registerNode(spec({ concurrencyCap: 'many' }), env), /concurrencyCap must be a positive number/);
  assert.equal(fs.existsSync(path.join(dir, 'nodes.json')), false);
});

test('verifyToken accepts the node token only', () => {
  const { env } = setup();
  const { token } = registerNode(spec(), env);
  registerNode(spec({ id: 'wok' }), env);
  assert.equal(verifyToken('grimm', token, env), true);
  assert.equal(verifyToken('grimm', token + 'x', env), false);
  assert.equal(verifyToken('grimm', token.slice(1), env), false);
  assert.equal(verifyToken('wok', token, env), false, 'another node token is not accepted');
  assert.equal(verifyToken('nobody', token, env), false);
  for (const bad of ['', undefined, null, 5]) assert.equal(verifyToken('grimm', bad, env), false);
  assert.equal(verifyToken('../x', token, env), false);
});

test('recordHeartbeat refreshes lastSeen, state, load, free RAM, paused and the address seen', () => {
  const { env } = setup();
  registerNode(spec(), env);
  const rec = recordHeartbeat({ id: 'grimm', address: '192.168.40.83', state: 'up', load: 1.5, freeRamGb: 9.25, paused: true }, env, T0);
  assert.equal(rec.lastSeen, '2026-11-11T12:00:00.000Z');
  assert.equal(rec.load, 1.5);
  assert.equal(rec.freeRamGb, 9.25);
  assert.equal(rec.paused, true);
  assert.equal(rec.lastAddress, '192.168.40.83');
  assert.equal(loadNodes(env).grimm.lastSeen, rec.lastSeen);
  assert.equal(rec.cores, 4, 'registration details are kept');
});

test('recordHeartbeat defaults state to up, makes junk numbers null, and rejects an unknown node, a bad state and a non-boolean paused', () => {
  const { env } = setup();
  registerNode(spec(), env);
  const rec = recordHeartbeat({ id: 'grimm', load: 'high', freeRamGb: NaN }, env, T0);
  assert.equal(rec.state, 'up');
  assert.equal(rec.load, null);
  assert.equal(rec.freeRamGb, null);
  assert.equal(rec.paused, false);
  assert.throws(() => recordHeartbeat({ id: 'ghost' }, env, T0), /unknown node/);
  assert.throws(() => recordHeartbeat({ id: 'grimm', state: 'sleeping' }, env, T0), /state must be one of up, off/);
  assert.throws(() => recordHeartbeat({ id: 'grimm', paused: 'yes' }, env, T0), /paused must be true or false/);
});

test('status is up, paused, off or stale, with the stale boundary exactly at the limit', () => {
  const { env } = setup();
  const rec = (over) => ({ lastSeen: new Date(T0).toISOString(), state: 'up', paused: false, ...over });
  assert.equal(statusOf(rec({}), env, T0 + 1000), 'up');
  assert.equal(statusOf(rec({ paused: true }), env, T0 + 1000), 'paused');
  assert.equal(statusOf(rec({ state: 'off' }), env, T0 + 1000), 'off');
  assert.equal(statusOf(rec({}), env, T0 + 5 * MIN), 'up');
  assert.equal(statusOf(rec({}), env, T0 + 5 * MIN + 1), 'stale');
  assert.equal(statusOf(rec({ state: 'off', paused: true }), env, T0 + 6 * MIN), 'stale');
  assert.equal(statusOf(rec({ lastSeen: null }), env, T0), 'stale');
  assert.equal(statusOf(rec({ lastSeen: 'yesterday' }), env, T0), 'stale');
  assert.equal(statusOf(rec({}), { AGENT_MANAGER_NODE_STALE_MIN: '1' }, T0 + 2 * MIN), 'stale');
});

test('listNodes is sorted by id and carries the computed status', () => {
  const { env } = setup();
  registerNode(spec({ id: 'wok' }), env);
  registerNode(spec(), env);
  recordHeartbeat({ id: 'grimm' }, env, T0);
  const list = listNodes(env, T0 + MIN);
  assert.deepEqual(list.map((n) => [n.id, n.status]), [['grimm', 'up'], ['wok', 'stale']]);
});

function fakeSend() {
  const sent = [];
  return { sent, send: async (msg) => { sent.push(msg); } };
}

test('sweepStale raises one urgent message for each node that was seen and has gone stale, and nothing for the rest', async () => {
  const { env } = setup();
  for (const id of ['fresh', 'quiet', 'never', 'parked']) registerNode(spec({ id }), env);
  recordHeartbeat({ id: 'fresh' }, env, T0 + 9 * MIN);
  recordHeartbeat({ id: 'quiet' }, env, T0);
  recordHeartbeat({ id: 'parked', state: 'off' }, env, T0);
  const { sent, send } = fakeSend();
  const raised = await sweepStale(env, T0 + 10 * MIN, send);
  assert.deepEqual(raised, ['quiet']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].level, 'urgent');
  assert.equal(sent[0].key, 'stale-node:quiet');
  assert.match(sent[0].title, /quiet is not answering/);
  assert.match(sent[0].text, /10 minutes/);
});

test('with the real notifier two sweeps send exactly one message (it de-duplicates by key)', async () => {
  const { env, dir } = setup();
  registerNode(spec(), env);
  recordHeartbeat({ id: 'grimm' }, env, T0);
  const calls = [];
  const notifyEnv = { ...env, AGENT_MANAGER_PIPELINE_DIR: dir, AGENT_MANAGER_NOTIFY_URL: 'http://ntfy.test/t' };
  const { notify } = require('./notify.js');
  const send = (msg, opts) => notify(msg, { ...opts, env: notifyEnv, post: async (url, headers, body) => { calls.push({ headers, body }); } });
  await sweepStale(env, T0 + 10 * MIN, send);
  await sweepStale(env, T0 + 11 * MIN, send);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Priority, 'urgent');
});

test('a node that comes back is not reported again until it goes quiet again', async () => {
  const { env } = setup();
  registerNode(spec(), env);
  recordHeartbeat({ id: 'grimm' }, env, T0);
  const { sent, send } = fakeSend();
  await sweepStale(env, T0 + 10 * MIN, send);
  recordHeartbeat({ id: 'grimm' }, env, T0 + 11 * MIN);
  assert.deepEqual(await sweepStale(env, T0 + 12 * MIN, send), []);
  assert.equal(sent.length, 1);
});

test('the CLI registers a node and prints the record and the token once, lists nodes, and rejects bad usage', () => {
  const { env } = setup();
  const out = [];
  const log = (s) => out.push(s);
  assert.equal(main(['register', 'grimm', '--address', '192.168.40.83', '--cores', '4', '--ram-gb', '15', '--gpu', 'RX 580', '--providers', 'claude-haiku, claude-sonnet', '--cap', '3'], env, log), 0);
  const printed = JSON.parse(out[0]);
  assert.match(printed.token, /^[0-9a-f]{48}$/);
  assert.deepEqual(printed.record.allowedProviders, ['claude-haiku', 'claude-sonnet']);
  assert.equal(printed.record.concurrencyCap, 3);
  assert.equal(main(['register', 'grimm'], env, log), 0);
  assert.equal(JSON.parse(out[1]).token, null);
  assert.equal(main(['register', 'grimm', '--rotate'], env, log), 0);
  assert.match(JSON.parse(out[2]).token, /^[0-9a-f]{48}$/);
  assert.equal(main(['list'], env, log), 0);
  assert.deepEqual(JSON.parse(out[3]).map((n) => n.id), ['grimm']);
  const realErr = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(main([], env, log), 2);
    assert.equal(main(['frobnicate'], env, log), 2);
  } finally {
    process.stderr.write = realErr;
  }
  assert.throws(() => main(['register', 'Bad Id'], env, log), /invalid node id/);
});

test('re-registering a node that has been heard from keeps everything it reported, and an over-long address is cut to 64 characters', () => {
  const { env } = setup();
  registerNode(spec(), env);
  recordHeartbeat({ id: 'grimm', address: '192.168.40.83', state: 'off', load: 2.5, freeRamGb: 8, paused: true }, env, T0);
  const { record } = registerNode(spec({ cores: 6 }), env);
  assert.equal(record.cores, 6);
  assert.equal(record.lastSeen, '2026-11-11T12:00:00.000Z');
  assert.equal(record.lastAddress, '192.168.40.83');
  assert.equal(record.state, 'off');
  assert.equal(record.load, 2.5);
  assert.equal(record.freeRamGb, 8);
  assert.equal(record.paused, true);
  const long = recordHeartbeat({ id: 'grimm', address: 'x'.repeat(200) }, env, T0);
  assert.equal(long.lastAddress.length, 64);
});
