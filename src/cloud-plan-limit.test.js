'use strict';

// src/cloud-plan-limit.js: the plan-limit probe (limited only for HTTP 200 + a planLimit object, every other outcome fails open) and its CLI decision.
// No network: fetch is injected. Run: node --test src/cloud-plan-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isPlanLimited, cliIsLimited } = require('./cloud-plan-limit.js');

const NOW = Date.parse('2026-11-22T06:00:00.000Z');
const FUTURE = '2026-11-22T09:00:00.000Z';
const PAST = '2026-11-22T04:00:00.000Z';
const OPEN = { limited: false, resetsAt: null };

// A fetch that answers one canned response and records the urls it was asked for.
function cannedFetch(status, body, { badJson = false } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { status, json: async () => { if (badJson) throw new SyntaxError('bad json'); return body; } };
  };
  impl.calls = calls;
  return impl;
}

test('HTTP 200 with planLimit and a future resetsAt is limited and carries the reset time', async () => {
  const f = cannedFetch(200, { ok: true, planLimit: { window: 'five-hour', resetsAt: FUTURE } });
  assert.deepEqual(await isPlanLimited('http://gw:7477/', { fetchImpl: f, now: NOW }), { limited: true, resetsAt: FUTURE });
  assert.deepEqual(f.calls, ['http://gw:7477/health']);
});

test('planLimit with no resetsAt is limited until unknown', async () => {
  const f = cannedFetch(200, { planLimit: { window: 'five-hour' } });
  assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: f, now: NOW }), { limited: true, resetsAt: null });
});

test('a past resetsAt fails open (the limit has already lifted)', async () => {
  const f = cannedFetch(200, { planLimit: { resetsAt: PAST } });
  assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: f, now: NOW }), OPEN);
});

test('an unparseable resetsAt fails open', async () => {
  const f = cannedFetch(200, { planLimit: { resetsAt: 'soon' } });
  assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: f, now: NOW }), OPEN);
});

test('no planLimit key means not limited', async () => {
  assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: cannedFetch(200, { ok: true }), now: NOW }), OPEN);
});

test('planLimit that is not a plain object fails open', async () => {
  for (const planLimit of ['yes', 1, true, [], null]) {
    assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: cannedFetch(200, { planLimit }), now: NOW }), OPEN, JSON.stringify(planLimit));
  }
});

test('a body that is not a JSON object fails open', async () => {
  for (const body of [null, [], 'ok', 7]) {
    assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: cannedFetch(200, body), now: NOW }), OPEN, JSON.stringify(body));
  }
});

test('a non-200 answer fails open even when its body says limited', async () => {
  for (const status of [204, 404, 429, 500, 503]) {
    const f = cannedFetch(status, { planLimit: { resetsAt: FUTURE } });
    assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: f, now: NOW }), OPEN, String(status));
  }
});

test('unparseable JSON fails open', async () => {
  assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: cannedFetch(200, null, { badJson: true }), now: NOW }), OPEN);
});

test('a thrown fetch fails open and never rejects', async () => {
  const f = async () => { throw new Error('ECONNREFUSED'); };
  assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: f, now: NOW }), OPEN);
});

test('a fetch that never answers (and ignores the abort signal) is cut off by the timeout and fails open', async () => {
  const f = () => new Promise(() => {});
  const t0 = Date.now();
  assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: f, now: NOW, timeoutMs: 30 }), OPEN);
  assert.ok(Date.now() - t0 < 2000);
});

test('a bad base url or a missing fetch fails open without a call', async () => {
  const f = cannedFetch(200, { planLimit: {} });
  for (const bad of [undefined, null, 5, '', '   ']) assert.deepEqual(await isPlanLimited(bad, { fetchImpl: f, now: NOW }), OPEN);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await isPlanLimited('http://gw:7477', { fetchImpl: 'nope', now: NOW }), OPEN);
});

// A private lanes.json with one cloud lane and one local GPU lane, reached through AGENT_MANAGER_LANES_PATH.
function lanesEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-plan-limit-'));
  const lanesPath = path.join(dir, 'lanes.json');
  fs.writeFileSync(lanesPath, JSON.stringify([
    { gpu: 'cloud', ollamaUrl: 'http://127.0.0.1:1', model: 'haiku', provider: 'cloud', preempt: 'never' },
    { gpu: '3090', ollamaUrl: 'http://127.0.0.1:11434', model: 'ornith' },
  ]));
  return { ...process.env, AGENT_MANAGER_LANES_PATH: lanesPath };
}

test('cliIsLimited probes an enabled cloud lane endpoint (trailing slash ignored)', async () => {
  const env = lanesEnv();
  const f = cannedFetch(200, { planLimit: { resetsAt: FUTURE } });
  assert.deepEqual(await cliIsLimited('http://127.0.0.1:1/', { env, fetchImpl: f, now: NOW }), { limited: true, resetsAt: FUTURE });
  assert.equal(f.calls.length, 1);
});

test('cliIsLimited answers not-limited WITHOUT any fetch for a local GPU endpoint or an unknown url', async () => {
  const env = lanesEnv();
  const f = cannedFetch(200, { planLimit: { resetsAt: FUTURE } });
  for (const url of ['http://127.0.0.1:11434', 'http://elsewhere:1', '', undefined]) {
    assert.deepEqual(await cliIsLimited(url, { env, fetchImpl: f, now: NOW }), OPEN, String(url));
  }
  assert.equal(f.calls.length, 0);
});

test('the CLI exits 1 printing nothing for a non-cloud url and exit 2 for a bad command', () => {
  const env = lanesEnv();
  const cli = path.join(__dirname, 'cloud-plan-limit.js');
  const a = spawnSync('node', [cli, 'is-limited', 'http://127.0.0.1:11434'], { encoding: 'utf8', env });
  assert.equal(a.status, 1);
  assert.equal(a.stdout, '');
  const b = spawnSync('node', [cli, 'nonsense'], { encoding: 'utf8', env });
  assert.equal(b.status, 2);
  const c = spawnSync('node', [cli, 'is-limited'], { encoding: 'utf8', env });
  assert.equal(c.status, 1);
});

test('the CLI exits 1 printing nothing when the cloud gateway is unreachable (fails open)', () => {
  const env = lanesEnv();
  // Port 7477 is the lane's configured endpoint; nothing listens in the sandbox, or the answer carries no planLimit: either way not limited.
  const r = spawnSync('node', [path.join(__dirname, 'cloud-plan-limit.js'), 'is-limited', 'http://127.0.0.1:1'], { encoding: 'utf8', env, timeout: 15000 });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});
