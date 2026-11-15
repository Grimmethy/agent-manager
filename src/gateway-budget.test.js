'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { stateDir, budgetFromMeter, isTokenBudgetRejection, fetchMeter, recordHit, describe, checkEndpoint, main, EXIT_OK, EXIT_USAGE, EXIT_BUDGET } = require('./gateway-budget.js');

const T0 = Date.UTC(2026, 10, 11, 18, 0, 0);
const SPENT = { tokenBudget: { perHour: 1500000, used: 1518237, remaining: -18237, resetsInSec: 1196 } };
const FINE = { tokenBudget: { perHour: 1500000, used: 0, remaining: 1500000, resetsInSec: 0 } };

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-budget-'));
  return { dir, env: { HOME: '/nonexistent-home', AGENT_MANAGER_BUDGET_STATE_DIR: path.join(dir, 'state') } };
}

async function gateway(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const close = () => new Promise((r) => { server.close(r); server.closeAllConnections(); });
  return { url: 'http://127.0.0.1:' + server.address().port, close };
}

test('stateDir defaults under HOME and the override wins', () => {
  assert.equal(stateDir({ HOME: '/home/x' }), '/home/x/.local/state/agent-manager/cloud-budget');
  assert.equal(stateDir({ HOME: '/home/x', AGENT_MANAGER_BUDGET_STATE_DIR: '/tmp/b' }), '/tmp/b');
  assert.equal(stateDir({ HOME: '/home/x', AGENT_MANAGER_BUDGET_STATE_DIR: ' ' }), '/home/x/.local/state/agent-manager/cloud-budget');
});

test('budgetFromMeter reads the gateway token budget and says whether it is spent', () => {
  assert.deepEqual(budgetFromMeter(SPENT), { perHour: 1500000, used: 1518237, remaining: -18237, resetsInSec: 1196, exceeded: true });
  assert.deepEqual(budgetFromMeter(FINE), { perHour: 1500000, used: 0, remaining: 1500000, resetsInSec: 0, exceeded: false });
  assert.equal(budgetFromMeter({ tokenBudget: { perHour: 100, used: 100, remaining: 0, resetsInSec: 5 } }).exceeded, true, 'exactly spent counts as spent');
  assert.equal(budgetFromMeter({ tokenBudget: { perHour: 100, used: 99, remaining: 1, resetsInSec: 5 } }).exceeded, false);
});

test('budgetFromMeter derives the remainder when it is missing, rounds the reset time and never reports a negative one', () => {
  assert.equal(budgetFromMeter({ tokenBudget: { perHour: 100, used: 120 } }).exceeded, true);
  assert.equal(budgetFromMeter({ tokenBudget: { perHour: 100, used: 20 } }).remaining, 80);
  assert.equal(budgetFromMeter({ tokenBudget: { perHour: 100, used: 120, resetsInSec: 59.6 } }).resetsInSec, 60);
  assert.equal(budgetFromMeter({ tokenBudget: { perHour: 100, used: 120, resetsInSec: -4 } }).resetsInSec, 0);
  assert.equal(budgetFromMeter({ tokenBudget: { perHour: 100, used: 120 } }).resetsInSec, 0);
});

test('budgetFromMeter gives null when there is no usable token budget: no cap, not a gateway, junk', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}, { tokenBudget: null }, { tokenBudget: 7 }, { tokenBudget: { perHour: 0, used: 5 } }, { tokenBudget: { perHour: -1, used: 5 } }, { tokenBudget: { perHour: 'many' } }]) {
    assert.equal(budgetFromMeter(bad), null, JSON.stringify(bad));
  }
});

test('describe says how much was used, of how much, and when it resets in whole minutes (at least one)', () => {
  assert.equal(describe(budgetFromMeter(SPENT)), 'token budget reached: 1518237 of 1500000 tokens per hour used; resets in about 20 minutes');
  assert.match(describe({ perHour: 10, used: 10, resetsInSec: 0 }), /resets in about 1 minutes$/);
  assert.match(describe({ perHour: 10, used: 10, resetsInSec: 61 }), /resets in about 2 minutes$/);
});

test('fetchMeter reads /meter from the endpoint origin and returns the parsed JSON', async () => {
  const seen = [];
  const g = await gateway((req, res) => { seen.push(req.url); res.end(JSON.stringify(SPENT)); });
  try {
    assert.deepEqual(await fetchMeter(`${g.url}/some/path`), SPENT);
    assert.deepEqual(seen, ['/meter']);
  } finally { await g.close(); }
});

test('fetchMeter answers null for a 404, a 500, junk, an oversized body, a closed port, a bad URL, a timeout and an https URL', async () => {
  const cases = [
    (req, res) => { res.statusCode = 404; res.end('no'); },
    (req, res) => { res.statusCode = 500; res.end('{}'); },
    (req, res) => res.end('<html>'),
    (req, res) => res.end(`{"x":"${'a'.repeat(70000)}"}`),
  ];
  for (const h of cases) {
    const g = await gateway(h);
    try { assert.equal(await fetchMeter(g.url), null); } finally { await g.close(); }
  }
  const closed = await gateway((req, res) => res.end('{}'));
  const url = closed.url;
  await closed.close();
  assert.equal(await fetchMeter(url), null);
  assert.equal(await fetchMeter('not a url'), null);
  assert.equal(await fetchMeter('https://127.0.0.1:1'), null);
  const plain = await gateway((req, res) => res.end(JSON.stringify(SPENT)));
  try { assert.equal(await fetchMeter(plain.url.replace('http:', 'https:')), null, 'only plain http is spoken'); } finally { await plain.close(); }
  const slow = await gateway(() => {});
  try { assert.equal(await fetchMeter(slow.url, 150), null); } finally { await slow.close(); }
});

test('recordHit starts an episode, logs the observed ceiling once, and a second sight inside the episode records nothing', () => {
  const { env, dir } = tmpEnv();
  const budget = budgetFromMeter(SPENT);
  assert.equal(recordHit(budget, env, T0), true);
  assert.equal(recordHit(budget, env, T0 + 600 * 1000), false);
  assert.equal(recordHit(budget, env, T0 + 1195 * 1000), false);
  const lines = fs.readFileSync(path.join(dir, 'state', 'hits.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ at: '2026-11-11T18:00:00.000Z', perHour: 1500000, used: 1518237, resetsInSec: 1196 }]);
  const episode = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'episode.json'), 'utf8'));
  assert.equal(episode.resetsAt, new Date(T0 + 1196 * 1000).toISOString());
  assert.equal(episode.startedAt, '2026-11-11T18:00:00.000Z');
});

test('a spent budget after the announced reset time is a new episode with its own line', () => {
  const { env, dir } = tmpEnv();
  const budget = budgetFromMeter(SPENT);
  recordHit(budget, env, T0);
  assert.equal(recordHit(budget, env, T0 + 1196 * 1000), true);
  assert.equal(fs.readFileSync(path.join(dir, 'state', 'hits.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('a damaged episode file is treated as no episode', () => {
  const { env, dir } = tmpEnv();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'episode.json'), '{oops');
  assert.equal(recordHit(budgetFromMeter(SPENT), env, T0), true);
});

function harness(meter) {
  const { env, dir } = tmpEnv();
  const t = { env, dir, out: [], sent: [], clock: T0 };
  t.asked = [];
  t.run = () => checkEndpoint('http://127.0.0.1:7450', { env, now: () => t.clock, get: async (u) => { t.asked.push(u); return meter; }, send: async (m, o) => { t.sent.push({ m, o }); }, out: (s) => t.out.push(s) });
  return t;
}

test('checkEndpoint is fine and silent when the budget is not spent', async () => {
  const t = harness(FINE);
  assert.equal(await t.run(), EXIT_OK);
  assert.deepEqual(t.asked, ['http://127.0.0.1:7450'], 'asks the endpoint it was given');
  assert.deepEqual([t.out, t.sent], [[], []]);
  assert.equal(fs.existsSync(path.join(t.dir, 'state')), false);
});

test('checkEndpoint fails open for an endpoint that is not a gateway or has no cap', async () => {
  for (const meter of [null, {}, { tokenBudget: { perHour: 0, used: 9 } }]) {
    const t = harness(meter);
    assert.equal(await t.run(), EXIT_OK);
    assert.deepEqual([t.out, t.sent], [[], []]);
  }
});

test('a spent budget exits 3, prints one line, records the episode and sends one summary-level notice naming the reset', async () => {
  const t = harness(SPENT);
  assert.equal(await t.run(), EXIT_BUDGET);
  assert.deepEqual(t.out, ['token budget reached: 1518237 of 1500000 tokens per hour used; resets in about 20 minutes']);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].m.level, 'summary');
  assert.equal(t.sent[0].m.key, 'cloud-budget-reached');
  assert.match(t.sent[0].m.text, /1518237 of 1500000 tokens per hour/);
  assert.match(t.sent[0].m.text, /claims nothing until then/);
  assert.equal(fs.readFileSync(path.join(t.dir, 'state', 'hits.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('every probe inside the episode still exits 3 but notifies and records only once', async () => {
  const t = harness(SPENT);
  for (let i = 0; i < 5; i += 1) { t.clock = T0 + i * 30 * 1000; assert.equal(await t.run(), EXIT_BUDGET); }
  assert.equal(t.sent.length, 1);
  assert.equal(fs.readFileSync(path.join(t.dir, 'state', 'hits.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(t.out.length, 5);
});

test('a failing notifier or an unwritable state directory never changes the exit code', async () => {
  const { env, dir } = tmpEnv();
  const code = await checkEndpoint('http://x', { env, now: () => T0, get: async () => SPENT, send: async () => { throw new Error('ntfy down'); }, out: () => {} });
  assert.equal(code, EXIT_BUDGET);
  fs.writeFileSync(path.join(dir, 'a-file'), 'x');
  const blocked = { ...env, AGENT_MANAGER_BUDGET_STATE_DIR: path.join(dir, 'a-file', 'state') };
  assert.equal(await checkEndpoint('http://x', { env: blocked, now: () => T0, get: async () => SPENT, send: async () => {}, out: () => {} }), EXIT_BUDGET);
});

test('main: usage errors exit 2 and a real gateway over budget exits 3', async () => {
  const realErr = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await main([], {}), EXIT_USAGE);
    assert.equal(await main(['check'], {}), EXIT_USAGE);
    assert.equal(await main(['status', 'http://x'], {}), EXIT_USAGE);
  } finally { process.stderr.write = realErr; }
  const g = await gateway((req, res) => res.end(JSON.stringify(SPENT)));
  const { env } = tmpEnv();
  try {
    assert.equal(await main(['check', g.url], env, { send: async () => {}, out: () => {} }), EXIT_BUDGET);
  } finally { await g.close(); }
});

test('isTokenBudgetRejection reads resetsInSec from the body tokenBudget', () => {
  const body = 'ollama http 429: ' + JSON.stringify({ error: 'hourly token budget reached', tokenBudget: { resetsInSec: 42 } });
  assert.deepEqual(isTokenBudgetRejection(body), { budget: true, resetsInSec: 42 });
});

test('isTokenBudgetRejection falls back to retry-after when the body has no tokenBudget resetsInSec', () => {
  const body = 'ollama http 429: ' + JSON.stringify({ error: 'hourly token budget reached', 'retry-after': 17 });
  assert.deepEqual(isTokenBudgetRejection(body), { budget: true, resetsInSec: 17 });
});

test('isTokenBudgetRejection rejects a wrong prefix', () => {
  const reason = 'ollama http 500: ' + JSON.stringify({ error: 'hourly token budget reached' });
  assert.deepEqual(isTokenBudgetRejection(reason), { budget: false });
});

test('isTokenBudgetRejection rejects a different error value', () => {
  const reason = 'ollama http 429: ' + JSON.stringify({ error: 'rate limited' });
  assert.deepEqual(isTokenBudgetRejection(reason), { budget: false });
});

test('isTokenBudgetRejection rejects malformed JSON without throwing', () => {
  assert.deepEqual(isTokenBudgetRejection('ollama http 429: {oops'), { budget: false });
});

test('isTokenBudgetRejection rejects non-string input without throwing', () => {
  for (const bad of [undefined, null, 5, {}]) assert.deepEqual(isTokenBudgetRejection(bad), { budget: false });
});

test('isTokenBudgetRejection with neither numeric source reports budget but an undefined resetsInSec', () => {
  const r = isTokenBudgetRejection('ollama http 429: ' + JSON.stringify({ error: 'hourly token budget reached' }));
  assert.equal(r.budget, true);
  assert.equal(r.resetsInSec, undefined);
});
