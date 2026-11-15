'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pullOnce, makeState, startDaemon } = require('./node-pull.js');

// The documented values, written out so a changed constant in node-pull.js fails the tests: 30 s backoff doubling, 2 s debounce.
const BACKOFF_FIRST_MS = 30000;
const DEBOUNCE_MS = 2000;

const NODE_ID = 'grimm';
const TOKEN = 'pull-test-token';

// A claim server on 127.0.0.1 whose answers are scripted: each request takes the next scripted answer (the last one repeats).
async function claimServer(t, answers) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: data ? JSON.parse(data) : null });
      const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
      const reply = () => {
        res.statusCode = answer.status || 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
      };
      if (answer.delayMs) setTimeout(reply, answer.delayMs); else reply();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((done) => server.close(done)));
  return { url: `http://127.0.0.1:${server.address().port}/claim`, requests };
}

function setup(t, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pull-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pipelineDir = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'adhoc'), { recursive: true });
  const tokenFile = path.join(root, 'node-token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const env = {
    HOME: root, AGENT_MANAGER_NODE_ID: NODE_ID, AGENT_MANAGER_PIPELINE_DIR: pipelineDir,
    AGENT_MANAGER_NODE_TOKEN_FILE: tokenFile, ...extraEnv,
  };
  return { root, pipelineDir, env };
}

const noLog = () => {};

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

// A fake timer set: setTimeout stores the callback, fire() runs the one that is armed.
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    live: () => timers.filter((x) => !x.cleared && !x.fired),
    fireLast() {
      const live = this.live();
      const timer = live[live.length - 1];
      assert.ok(timer, 'a timer is armed');
      timer.fired = true;
      timer.fn();
    },
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 20; i += 1) await tick(); }
// Waits until the fake claim server has seen n requests (real loopback sockets need more than a few event-loop turns).
async function waitForRequests(server, n) {
  const deadline = Date.now() + 3000;
  while (server.requests.length < n && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();
}

test('a pull posts {id, classes} with the bearer token and writes the task into queue/adhoc stamped leasedTo the node id', async (t) => {
  const { pipelineDir, env } = setup(t);
  const server = await claimServer(t, [{ body: { ok: true, task: { id: 't-one', title: 'x' }, lease: { taskId: 't-one', nodeId: NODE_ID }, repo: { remoteUrl: 'https://example.invalid/r.git', root: '/never/used' } } }]);
  const ensured = [];
  const out = await pullOnce({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { classes: ['adhoc'], ensureRepo: async (info) => { ensured.push(info); }, log: noLog },
  });
  assert.equal(out.task.id, 't-one');
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, 'POST');
  assert.equal(server.requests[0].auth, `Bearer ${TOKEN}`);
  assert.deepEqual(server.requests[0].body, { id: NODE_ID, classes: ['adhoc'] });
  assert.deepEqual(ensured, [{ remoteUrl: 'https://example.invalid/r.git' }]);
  const written = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'adhoc', 't-one.json'), 'utf8'));
  assert.equal(written.leasedTo, NODE_ID);
  assert.equal(written.id, 't-one');
});

test('a task already queued is not overwritten and counts as an error', async (t) => {
  const { pipelineDir, env } = setup(t);
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'adhoc', 't-dup.json'), JSON.stringify({ id: 't-dup', keep: true }));
  const server = await claimServer(t, [{ body: { ok: true, task: { id: 't-dup' }, repo: { remoteUrl: 'https://example.invalid/r.git' } } }]);
  const out = await pullOnce({ env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url }, deps: { ensureRepo: async () => {}, log: noLog } });
  assert.match(out.error, /already queued/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'adhoc', 't-dup.json'), 'utf8')).keep, true);
});

test('errors back off 30 s then 60 s and a success resets the backoff', async (t) => {
  const { env } = setup(t);
  const c = clock();
  const server = await claimServer(t, [{ status: 500, body: {} }, { status: 500, body: {} }, { body: { ok: true, task: null, retryAfterSec: 5 } }, { status: 500, body: {} }]);
  const state = makeState();
  const deps = { now: c.now, log: noLog, ensureRepo: async () => {} };
  const e = { ...env, AGENT_MANAGER_CLAIM_URL: server.url };
  const first = await pullOnce({ env: e, deps, state });
  assert.equal(first.nextAllowedAt - c.now(), BACKOFF_FIRST_MS);
  const second = await pullOnce({ env: e, deps, state });
  assert.equal(second.nextAllowedAt - c.now(), BACKOFF_FIRST_MS * 2);
  const ok = await pullOnce({ env: e, deps, state });
  assert.equal(ok.task, null);
  assert.equal(state.backoffMs, 0);
  const again = await pullOnce({ env: e, deps, state });
  assert.equal(again.nextAllowedAt - c.now(), BACKOFF_FIRST_MS, 'after a success the next error starts at 30 s again');
});

test('network errors (nothing listening) back off too', async (t) => {
  const { env } = setup(t, { AGENT_MANAGER_CLAIM_URL: 'http://127.0.0.1:1/claim' });
  const c = clock();
  const state = makeState();
  const out = await pullOnce({ env, deps: { now: c.now, log: noLog }, state });
  assert.ok(out.error);
  assert.equal(out.nextAllowedAt - c.now(), BACKOFF_FIRST_MS);
});

test('pullOnce never throws: missing settings, unreadable token, bad JSON, a failing ensureRepo and a throwing fetch all return {error}', async (t) => {
  const { env } = setup(t);
  const base = { ...env, AGENT_MANAGER_CLAIM_URL: 'http://127.0.0.1:1/claim' };
  const deps = { log: noLog, ensureRepo: async () => {} };
  for (const missing of ['AGENT_MANAGER_CLAIM_URL', 'AGENT_MANAGER_PIPELINE_DIR', 'AGENT_MANAGER_NODE_ID']) {
    const e = { ...base }; delete e[missing];
    const out = await pullOnce({ env: e, deps });
    assert.ok(out.error, missing);
  }
  assert.ok((await pullOnce({ env: { ...base, AGENT_MANAGER_NODE_TOKEN_FILE: '/nonexistent/token' }, deps })).error);
  assert.ok((await pullOnce({ env: base, deps: { ...deps, fetch: async () => { throw new Error('boom'); } } })).error);
  assert.ok((await pullOnce({ env: base, deps: { ...deps, fetch: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) } })).error);
  assert.ok((await pullOnce({ env: base, deps: { ...deps, fetch: async () => ({ ok: true, json: async () => ({ ok: true, task: { id: 'x' }, repo: { remoteUrl: 'u' } }) }), ensureRepo: async () => { throw new Error('clone failed'); } } })).error);
  assert.ok((await pullOnce({ env: base, deps: { ...deps, fetch: async () => ({ ok: true, json: async () => ({ ok: true, task: { id: 'x' } }) }) } })).error, 'no repo.remoteUrl');
});

test('no request before retryAfterSec expires and one after', async (t) => {
  const { env } = setup(t);
  const c = clock();
  const timers = fakeTimers();
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 60 } }]);
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { now: c.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: () => ({ close() {}, on() {} }), log: noLog },
  });
  t.after(() => daemon.stop());
  await waitForRequests(server, 1);
  assert.equal(server.requests.length, 1, 'one pull at start');
  daemon.trigger();
  c.advance(59_000);
  daemon.trigger();
  await settle();
  assert.equal(server.requests.length, 1, 'still inside retryAfterSec');
  c.advance(1_000);
  daemon.trigger();
  await waitForRequests(server, 2);
  assert.equal(server.requests.length, 2, 'one request once retryAfterSec has passed');
});

test('the retry timer is armed for the remaining wait and fires one more pull', async (t) => {
  const { env } = setup(t);
  const c = clock();
  const timers = fakeTimers();
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 30 } }]);
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { now: c.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: () => ({ close() {}, on() {} }), log: noLog },
  });
  t.after(() => daemon.stop());
  await waitForRequests(server, 1);
  const armed = timers.live();
  assert.equal(armed.length, 1);
  assert.equal(armed[0].ms, 30_000);
  c.advance(30_000);
  timers.fireLast();
  await waitForRequests(server, 2);
  assert.equal(server.requests.length, 2);
});

test('no request while the worker is busy or the pause is set, one pull per idle worker when it frees up', async (t) => {
  const { env } = setup(t);
  const c = clock();
  const timers = fakeTimers();
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 0 } }]);
  let paused = true;
  let free = true;
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: {
      now: c.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: () => ({ close() {}, on() {} }), log: noLog,
      isPaused: () => paused, isWorkerFree: () => free,
    },
  });
  t.after(() => daemon.stop());
  await settle();
  assert.equal(server.requests.length, 0, 'paused: no request at start');
  daemon.trigger();
  await settle();
  assert.equal(server.requests.length, 0, 'still paused');
  paused = false;
  free = false;
  daemon.trigger();
  await settle();
  assert.equal(server.requests.length, 0, 'worker busy: no request');
  free = true;
  daemon.trigger();
  await waitForRequests(server, 1);
  assert.equal(server.requests.length, 1, 'one pull for the idle worker');
});

test('a change in queue/adhoc is debounced 2 s into a single pull, and stop() clears the timers and closes the watcher', async (t) => {
  const { env, pipelineDir } = setup(t);
  const c = clock();
  const timers = fakeTimers();
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 0 } }]);
  const watched = [];
  let closed = false;
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: {
      now: c.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, log: noLog,
      watch: (dir, cb) => { watched.push({ dir, cb }); return { close() { closed = true; }, on() {} }; },
    },
  });
  await waitForRequests(server, 1);
  assert.equal(watched[0].dir, path.join(pipelineDir, 'queue', 'adhoc'));
  assert.equal(server.requests.length, 1);
  watched[0].cb();
  watched[0].cb();
  watched[0].cb();
  const debounces = timers.live().filter((x) => x.ms === DEBOUNCE_MS);
  assert.equal(debounces.length, 1, 'three changes leave one armed debounce timer');
  c.advance(DEBOUNCE_MS);
  timers.fireLast();
  await waitForRequests(server, 2);
  assert.equal(server.requests.length, 2, 'one pull for the burst of changes');
  daemon.stop();
  assert.equal(closed, true);
  assert.equal(timers.live().length, 0);
  daemon.trigger();
  await pause(150);
  assert.equal(server.requests.length, 2, 'no pull after stop');
});

test('pulls are serialized: a trigger while a pull is in flight waits and then runs exactly one more', async (t) => {
  const { env } = setup(t);
  const c = clock();
  const timers = fakeTimers();
  const server = await claimServer(t, [{ delayMs: 200, body: { ok: true, task: null, retryAfterSec: 0 } }]);
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { now: c.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: () => ({ close() {}, on() {} }), log: noLog },
  });
  t.after(() => daemon.stop());
  await waitForRequests(server, 1);
  daemon.trigger();
  daemon.trigger();
  await pause(60);
  assert.equal(server.requests.length, 1, 'the first pull is still in flight: no second request');
  await waitForRequests(server, 2);
  await pause(60);
  assert.equal(server.requests.length, 2, 'the triggers made while in flight collapse into one more pull');
});

test('consecutive errors double the backoff up to a 10 minute cap and stay there', async (t) => {
  const { env } = setup(t, { AGENT_MANAGER_CLAIM_URL: 'http://127.0.0.1:1/claim' });
  const c = clock();
  const state = makeState();
  const deps = { now: c.now, log: noLog, fetch: async () => ({ ok: false, status: 503 }) };
  const waits = [];
  for (let i = 0; i < 8; i += 1) {
    const out = await pullOnce({ env, deps, state });
    waits.push(out.nextAllowedAt - c.now());
  }
  assert.deepEqual(waits, [30000, 60000, 120000, 240000, 480000, 600000, 600000, 600000]);
});
