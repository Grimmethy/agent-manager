'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { config, readToken, freeRamGb, buildPayload, applyReply, runOnce, main, GLOBAL_PAUSE_TTL_MIN } = require('./node-heartbeat.js');
const { readPause, setPause } = require('./worker-switch.js');
const { createServer } = require('./node-registry-server.js');
const { registerNode, loadNodes } = require('./node-registry.js');

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const TOKEN = ['fixture', 'node', 'token', 'value'].join('-');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-heartbeat-'));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`);
  const env = { HOME: '/nonexistent-home', AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch'), AGENT_MANAGER_NODE_ID: 'grimm', AGENT_MANAGER_NODE_URL: 'http://wok.test:7471/heartbeat', AGENT_MANAGER_NODE_TOKEN_FILE: tokenFile, ...extra };
  const sent = [];
  const reply = { status: 200, body: { ok: true, globalPause: false, serverTime: '2026-11-11T12:00:00.000Z' } };
  const post = async (url, token, body) => { sent.push({ url, token, body: JSON.parse(body) }); return { status: reply.status, text: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body) }; };
  const deps = { loadavg: () => [1.234, 0, 0], readMeminfo: () => 'MemTotal: 16000000 kB\nMemAvailable: 8388608 kB\n', freemem: () => 123 };
  return { dir, env, sent, reply, post, deps, run: () => runOnce({ env, now: () => T0, post, deps }) };
}

test('config reads the settings, trims them and defaults the timeout', () => {
  const c = config({ AGENT_MANAGER_NODE_ID: ' grimm ', AGENT_MANAGER_NODE_URL: ' http://x/heartbeat ', AGENT_MANAGER_NODE_TOKEN_FILE: '/t', AGENT_MANAGER_NODE_ADDRESS: ' 10.0.0.2 ' });
  assert.deepEqual(c, { id: 'grimm', url: 'http://x/heartbeat', tokenFile: '/t', address: '10.0.0.2', timeoutMs: 5000 });
  assert.equal(config({ AGENT_MANAGER_NODE_TIMEOUT_MS: '900' }).timeoutMs, 900);
  assert.equal(config({ AGENT_MANAGER_NODE_TIMEOUT_MS: '-1' }).timeoutMs, 5000);
  assert.equal(config({ AGENT_MANAGER_NODE_TIMEOUT_MS: '0' }).timeoutMs, 5000);
});

test('freeRamGb uses MemAvailable, falls back to os.freemem, and rounds to two places', () => {
  assert.equal(freeRamGb(() => 'MemAvailable:    8388608 kB\n', () => 1), 8);
  assert.equal(freeRamGb(() => 'MemAvailable: 1000000 kB', () => 1), 0.95);
  assert.equal(freeRamGb(() => { throw new Error('no proc'); }, () => 2 * 1024 * 1024 * 1024), 2);
  assert.equal(freeRamGb(() => 'MemTotal: 1 kB', () => 1024 * 1024 * 1024), 1);
});

test('the payload has the id, state up, load, free RAM, the paused flag and the time; address only when configured', () => {
  const t = setup();
  const p = buildPayload(config(t.env), t.env, T0, t.deps);
  assert.deepEqual(p, { id: 'grimm', state: 'up', load: 1.23, freeRamGb: 8, paused: false, at: '2026-11-11T12:00:00.000Z' });
  setPause('node', { ttlMin: 5 }, t.env, T0);
  assert.equal(buildPayload(config(t.env), t.env, T0 + 1000, t.deps).paused, true);
  assert.equal(buildPayload(config(t.env), t.env, T0 + 10 * 60 * 1000, t.deps).paused, false, 'an expired node pause is not reported');
  assert.equal(buildPayload(config({ ...t.env, AGENT_MANAGER_NODE_ADDRESS: '192.168.40.83' }), t.env, T0, t.deps).address, '192.168.40.83');
});

test('readToken trims the file and refuses an empty one', () => {
  const t = setup();
  assert.equal(readToken(t.env.AGENT_MANAGER_NODE_TOKEN_FILE), TOKEN);
  fs.writeFileSync(t.env.AGENT_MANAGER_NODE_TOKEN_FILE, '  \n');
  assert.throws(() => readToken(t.env.AGENT_MANAGER_NODE_TOKEN_FILE), /empty/);
});

test('a run posts the payload to the intake URL with the node token as a Bearer token', async () => {
  const t = setup();
  const r = await t.run();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].url, 'http://wok.test:7471/heartbeat');
  assert.equal(t.sent[0].token, TOKEN);
  assert.equal(t.sent[0].body.id, 'grimm');
  assert.deepEqual(r, { sent: true, applied: 'none', status: 200, globalPause: false });
});

test('globalPause true sets a global pause from wok with a 3 minute expiry, and every heartbeat refreshes it', async () => {
  const t = setup();
  t.reply.body.globalPause = true;
  assert.equal((await t.run()).applied, 'set');
  const marker = readPause('global', t.env, T0 + 1000);
  assert.equal(marker.source, 'wok');
  assert.equal(marker.reason, 'global pause from wok');
  assert.equal(marker.expiresAt, new Date(T0 + GLOBAL_PAUSE_TTL_MIN * 60 * 1000).toISOString());
  assert.equal(GLOBAL_PAUSE_TTL_MIN, 3);
  const later = await runOnce({ env: t.env, now: () => T0 + 2 * 60 * 1000, post: t.post, deps: t.deps });
  assert.equal(later.applied, 'set');
  assert.notEqual(readPause('global', t.env, T0 + 4 * 60 * 1000), null, 'refreshed past the first expiry');
});

test('the pause ends by itself when wok stops answering', async () => {
  const t = setup();
  t.reply.body.globalPause = true;
  await t.run();
  t.post = async () => { throw new Error('connection refused'); };
  const r = await runOnce({ env: t.env, now: () => T0 + 60 * 1000, post: t.post, deps: t.deps });
  assert.equal(r.sent, false);
  assert.notEqual(readPause('global', t.env, T0 + 2 * 60 * 1000), null, 'one missed heartbeat changes nothing');
  assert.equal(readPause('global', t.env, T0 + 4 * 60 * 1000), null, 'and the expiry ends it');
});

test('globalPause false clears a pause that came from wok, and only that', async () => {
  const t = setup();
  setPause('global', { source: 'wok', ttlMin: 3 }, t.env, T0);
  assert.equal((await t.run()).applied, 'cleared');
  assert.equal(readPause('global', t.env, T0), null);
  setPause('global', { source: 'dashboard' }, t.env, T0);
  assert.equal((await t.run()).applied, 'none');
  assert.equal(readPause('global', t.env, T0).source, 'dashboard');
});

test('a global pause set here by someone else is not overwritten by a pause from wok', async () => {
  const t = setup();
  setPause('global', { source: 'operator', reason: 'mine' }, t.env, T0);
  t.reply.body.globalPause = true;
  assert.equal((await t.run()).applied, 'none');
  const marker = readPause('global', t.env, T0);
  assert.equal(marker.source, 'operator');
  assert.equal(marker.expiresAt, null);
});

test('a node pause is never touched by the heartbeat', async () => {
  const t = setup();
  setPause('node', { source: 'site-traffic', ttlMin: 10 }, t.env, T0);
  t.reply.body.globalPause = true;
  await t.run();
  t.reply.body.globalPause = false;
  await t.run();
  assert.equal(readPause('node', t.env, T0 + 1000).source, 'site-traffic');
});

test('an unreachable wok, a non-2xx answer and a reply that is not JSON change nothing and are reported', async () => {
  const t = setup();
  setPause('global', { source: 'wok', ttlMin: 3 }, t.env, T0);
  const down = await runOnce({ env: t.env, now: () => T0, post: async () => { throw new Error('connection refused'); }, deps: t.deps });
  assert.deepEqual([down.sent, down.applied], [false, 'none']);
  assert.match(down.reason, /could not reach wok: connection refused/);
  t.reply.status = 401;
  t.reply.body = { ok: false, error: 'bad or missing token' };
  const denied = await t.run();
  assert.deepEqual([denied.sent, denied.applied, denied.status], [false, 'none', 401]);
  t.reply.status = 200;
  t.reply.body = '<html>';
  const junk = await t.run();
  assert.deepEqual([junk.sent, junk.applied], [true, 'none']);
  assert.match(junk.reason, /not JSON/);
  assert.notEqual(readPause('global', t.env, T0), null, 'none of these touched the pause');
});

test('a reply without a boolean globalPause, or a JSON value that is not an object, changes nothing', async () => {
  const t = setup();
  setPause('global', { source: 'wok', ttlMin: 3 }, t.env, T0);
  for (const body of [{ ok: true }, { ok: true, globalPause: 'yes' }, null, 5, '"x"']) {
    t.reply.body = typeof body === 'string' ? body : JSON.stringify(body);
    const r = await t.run();
    assert.equal(r.applied, 'none', JSON.stringify(body));
    assert.equal(r.globalPause, null, `${JSON.stringify(body)} reports no usable globalPause`);
  }
  assert.equal(readPause('global', t.env, T0).source, 'wok');
});

test('missing settings and an unreadable or empty token file are usage errors, not network calls', async () => {
  const t = setup();
  const none = await runOnce({ env: {}, now: () => T0, post: t.post, deps: t.deps });
  assert.equal(none.usage, true);
  assert.match(none.error, /AGENT_MANAGER_NODE_ID, AGENT_MANAGER_NODE_URL, AGENT_MANAGER_NODE_TOKEN_FILE/);
  const gone = await runOnce({ env: { ...t.env, AGENT_MANAGER_NODE_TOKEN_FILE: '/nonexistent/token' }, now: () => T0, post: t.post, deps: t.deps });
  assert.match(gone.error, /cannot read the token file: ENOENT/);
  fs.writeFileSync(t.env.AGENT_MANAGER_NODE_TOKEN_FILE, '\n');
  assert.match((await t.run()).error, /empty/);
  assert.equal(t.sent.length, 0);
});

test('the token never appears in the printed result or in an error', async () => {
  const t = setup();
  const lines = [];
  const errs = [];
  t.env.AGENT_MANAGER_NODE_URL = 'http://127.0.0.1:1/heartbeat';
  assert.equal(await main(t.env, (s) => lines.push(s), (s) => errs.push(s)), 0);
  assert.ok(!lines.join('').includes(TOKEN) && !errs.join('').includes(TOKEN));
  assert.match(lines[0], /could not reach wok/);
  const bad = { ...t.env, AGENT_MANAGER_NODE_TOKEN_FILE: '/nonexistent/token' };
  assert.equal(await main(bad, (s) => lines.push(s), (s) => errs.push(s)), 2);
  assert.ok(!errs.join('').includes(TOKEN));
});

test('main prints one JSON line and exits 0 for a refused or unreachable wok, and 2 for missing settings', async () => {
  const out = [];
  const err = [];
  assert.equal(await main({}, (s) => out.push(s), (s) => err.push(s)), 2);
  assert.match(err[0], /missing settings/);
  assert.equal(out.length, 0);
});

test('end to end: the real client against the real intake registers a heartbeat and receives a global pause', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-heartbeat-e2e-'));
  const wokEnv = { HOME: '/nonexistent-home', AGENT_MANAGER_NODES_DIR: path.join(dir, 'nodes'), AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'wok-switch') };
  const { token } = registerNode({ id: 'grimm', address: '127.0.0.1', cores: 4 }, wokEnv);
  const server = createServer({ env: wokEnv, now: () => Date.now(), sweep: async () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, token);
  const nodeEnv = { HOME: '/nonexistent-home', AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'grimm-switch'), AGENT_MANAGER_NODE_ID: 'grimm', AGENT_MANAGER_NODE_URL: `http://127.0.0.1:${server.address().port}/heartbeat`, AGENT_MANAGER_NODE_TOKEN_FILE: tokenFile };
  try {
    const first = await runOnce({ env: nodeEnv });
    assert.deepEqual([first.sent, first.status, first.globalPause, first.applied], [true, 200, false, 'none']);
    assert.notEqual(loadNodes(wokEnv).grimm.lastSeen, null);
    assert.equal(loadNodes(wokEnv).grimm.state, 'up');
    setPause('global', { source: 'dashboard' }, wokEnv, Date.now());
    const second = await runOnce({ env: nodeEnv });
    assert.deepEqual([second.globalPause, second.applied], [true, 'set']);
    assert.equal(readPause('global', nodeEnv, Date.now()).source, 'wok');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('applyReply ignores a missing reply', () => {
  const t = setup();
  assert.equal(applyReply(null, t.env, T0), 'none');
  assert.equal(applyReply(undefined, t.env, T0), 'none');
  assert.equal(applyReply({}, t.env, T0), 'none');
});

test('an invalid intake URL is reported as could not reach wok and changes nothing', async () => {
  const t = setup({ AGENT_MANAGER_NODE_URL: 'not a url' });
  const r = await runOnce({ env: t.env, now: () => T0, deps: t.deps });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'could not reach wok: invalid AGENT_MANAGER_NODE_URL');
});
