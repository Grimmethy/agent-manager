'use strict';

// FF-8/8b: one summary notice per behind episode and one on recovery (src/node-registry.js behindTooLong, src/node-registry-server.js heartbeat handler).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('./node-registry-server.js');
const { registerNode, loadNodes, behindTooLong, markBehindNotified } = require('./node-registry.js');

const T0 = Date.UTC(2026, 10, 16, 10, 0, 0);
const MIN = 60000;
const WOK = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

test('behindTooLong: under N minutes is null, over N gives the whole minutes, exactly N is still null', () => {
  const stamp = new Date(T0).toISOString();
  assert.equal(behindTooLong(stamp, T0 + 29 * MIN, {}), null);
  assert.equal(behindTooLong(stamp, T0 + 30 * MIN, {}), null);
  assert.equal(behindTooLong(stamp, T0 + 30 * MIN + 1, {}), 30);
  assert.equal(behindTooLong(stamp, T0 + 95 * MIN + 59000, {}), 95);
});

test('behindTooLong: N comes from AGENT_MANAGER_NODE_BEHIND_MIN and a bad value falls back to 30', () => {
  const stamp = new Date(T0).toISOString();
  assert.equal(behindTooLong(stamp, T0 + 6 * MIN, { AGENT_MANAGER_NODE_BEHIND_MIN: '5' }), 6);
  assert.equal(behindTooLong(stamp, T0 + 4 * MIN, { AGENT_MANAGER_NODE_BEHIND_MIN: '5' }), null);
  for (const bad of ['0', '-3', 'x', '']) {
    assert.equal(behindTooLong(stamp, T0 + 20 * MIN, { AGENT_MANAGER_NODE_BEHIND_MIN: bad }), null, bad);
    assert.equal(behindTooLong(stamp, T0 + 31 * MIN, { AGENT_MANAGER_NODE_BEHIND_MIN: bad }), 31, bad);
  }
});

test('behindTooLong: a missing, junk or non-string stamp and a bad clock give null', () => {
  for (const bad of [undefined, null, '', 'soon', 12345, {}]) assert.equal(behindTooLong(bad, T0 + 99 * MIN, {}), null, String(bad));
  assert.equal(behindTooLong(new Date(T0).toISOString(), NaN, {}), null);
  assert.equal(behindTooLong(new Date(T0), T0 + 99 * MIN, {}), null, 'a Date object is not a stamp');
});

async function start({ notify, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-behind-'));
  const pub = path.join(dir, 'pub');
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'latest.json'), JSON.stringify([{ repo: 'agent-manager', sha: WOK, bundle: 'x.bundle', branch: 'master' }]));
  const env = { HOME: '/nonexistent-home', AGENT_MANAGER_NODES_DIR: path.join(dir, 'nodes'), AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch'), AGENT_MANAGER_CODE_PUBLISH_DIR: pub, ...extraEnv };
  const { token } = registerNode({ id: 'grimm', address: '127.0.0.1', cores: 4 }, env);
  const clock = { now: T0 };
  const notices = [];
  const send = notify || (async (msg, opts) => { notices.push({ msg, opts }); });
  const server = createServer({ env, now: () => clock.now, sweep: async () => {}, notify: send });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const beat = (codeSha) => new Promise((resolve, reject) => {
    const data = JSON.stringify({ id: 'grimm', state: 'up', load: 0.1, freeRamGb: 8, paused: false, ...(codeSha === undefined ? {} : { codeSha }) });
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/heartbeat', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data);
  });
  return { env, clock, notices, beat, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

test('under N minutes behind sends nothing; over N sends once and not on the next heartbeat', async () => {
  const s = await start();
  try {
    await s.beat(OLD);
    s.clock.now = T0 + 29 * MIN;
    await s.beat(OLD);
    assert.equal(s.notices.length, 0);
    s.clock.now = T0 + 31 * MIN;
    await s.beat(OLD);
    assert.equal(s.notices.length, 1);
    const { msg, opts } = s.notices[0];
    assert.equal(msg.level, 'summary');
    assert.equal(msg.key, `node-behind:grimm:${new Date(T0).toISOString()}`);
    assert.match(msg.title, /grimm/);
    assert.match(msg.text, /bbbbbbbb/);
    assert.match(msg.text, /aaaaaaaa/);
    assert.match(msg.text, /31 minutes/);
    assert.equal(opts.env, s.env);
    s.clock.now = T0 + 50 * MIN;
    await s.beat(OLD);
    assert.equal(s.notices.length, 1);
    assert.equal(loadNodes(s.env).grimm.behindNotified, new Date(T0).toISOString());
  } finally { await s.close(); }
});

test('recovery after an announced episode sends one recovered notice and clears the marker; a new episode announces again', async () => {
  const s = await start();
  try {
    await s.beat(OLD);
    s.clock.now = T0 + 31 * MIN;
    await s.beat(OLD);
    s.clock.now = T0 + 40 * MIN;
    await s.beat(WOK);
    assert.equal(s.notices.length, 2);
    assert.equal(s.notices[1].msg.key, `node-behind-recovered:grimm:${new Date(T0).toISOString()}`);
    assert.equal(s.notices[1].msg.level, 'summary');
    assert.equal('behindNotified' in loadNodes(s.env).grimm, false);
    s.clock.now = T0 + 41 * MIN;
    await s.beat(WOK);
    assert.equal(s.notices.length, 2, 'a matching heartbeat after recovery sends nothing');
    s.clock.now = T0 + 50 * MIN;
    await s.beat(OLD);
    s.clock.now = T0 + 90 * MIN;
    await s.beat(OLD);
    assert.equal(s.notices.length, 3);
    assert.equal(s.notices[2].msg.key, `node-behind:grimm:${new Date(T0 + 50 * MIN).toISOString()}`);
  } finally { await s.close(); }
});

test('a short episode that was never announced sends no recovered notice', async () => {
  const s = await start();
  try {
    await s.beat(OLD);
    s.clock.now = T0 + 5 * MIN;
    await s.beat(WOK);
    assert.deepEqual(s.notices, []);
  } finally { await s.close(); }
});

test('a node with no codeSha or no published list is never noticed', async () => {
  const s = await start();
  try {
    await s.beat(undefined);
    s.clock.now = T0 + 90 * MIN;
    await s.beat(undefined);
    assert.deepEqual(s.notices, []);
  } finally { await s.close(); }
  const t = await start({ extraEnv: { AGENT_MANAGER_CODE_PUBLISH_DIR: path.join(os.tmpdir(), 'no-such-publish-dir') } });
  try {
    await t.beat(OLD);
    t.clock.now = T0 + 90 * MIN;
    await t.beat(OLD);
    assert.deepEqual(t.notices, []);
  } finally { await t.close(); }
});

test('a throwing notifier still returns the normal reply and is retried by the next heartbeat', async () => {
  let calls = 0;
  const s = await start({ notify: async () => { calls += 1; if (calls === 1) throw new Error('ntfy down'); return { sent: true }; } });
  try {
    await s.beat(OLD);
    s.clock.now = T0 + 31 * MIN;
    const r = await s.beat(OLD);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal('behindNotified' in loadNodes(s.env).grimm, false);
    s.clock.now = T0 + 32 * MIN;
    await s.beat(OLD);
    assert.equal(calls, 2);
    assert.equal(loadNodes(s.env).grimm.behindNotified, new Date(T0).toISOString());
  } finally { await s.close(); }
});

test('N comes from AGENT_MANAGER_NODE_BEHIND_MIN in the server environment', async () => {
  const s = await start({ extraEnv: { AGENT_MANAGER_NODE_BEHIND_MIN: '5' } });
  try {
    await s.beat(OLD);
    s.clock.now = T0 + 6 * MIN;
    await s.beat(OLD);
    assert.equal(s.notices.length, 1);
    assert.match(s.notices[0].msg.text, /6 minutes/);
  } finally { await s.close(); }
});

test('markBehindNotified sets and clears the stamp on a known node and refuses an unknown one without writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-behind-mark-'));
  const env = { HOME: '/nonexistent-home', AGENT_MANAGER_NODES_DIR: dir };
  registerNode({ id: 'grimm', address: '127.0.0.1', cores: 4 }, env);
  assert.equal(markBehindNotified('grimm', '2026-11-16T10:00:00.000Z', env), true);
  assert.equal(loadNodes(env).grimm.behindNotified, '2026-11-16T10:00:00.000Z');
  assert.equal(markBehindNotified('grimm', null, env), true);
  assert.equal('behindNotified' in loadNodes(env).grimm, false);
  assert.equal(markBehindNotified('nobody', '2026-11-16T10:00:00.000Z', env), false);
  assert.deepEqual(Object.keys(loadNodes(env)), ['grimm']);
});

test('the heartbeat reply waits for the notice: a slow notifier has finished and marked the episode when the reply arrives', async () => {
  const s = await start({ notify: async () => { await new Promise((r) => setTimeout(r, 60)); return { sent: true }; } });
  try {
    await s.beat(OLD);
    s.clock.now = T0 + 31 * MIN;
    await s.beat(OLD);
    assert.equal(loadNodes(s.env).grimm.behindNotified, new Date(T0).toISOString());
  } finally { await s.close(); }
});
