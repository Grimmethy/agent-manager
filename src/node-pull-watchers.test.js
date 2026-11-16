'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pullOnce, startDaemon, DEBOUNCE_MS, SAFETY_RECHECK_MS } = require('./node-pull.js');

// The documented values, written out so a changed constant in node-pull.js fails the tests: 30 s backoff doubling, 2 s debounce.
const BACKOFF_FIRST_MS = 30000;

const NODE_ID = 'grimm';
const TOKEN = 'pull-test-token';

// --- copied helpers from src/node-pull.test.js ---

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
  const port = server.address().port;
  return { url: 'http://127.0.0.1:' + port + '/claim', requests };
}

function setup(t, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pull-watchers-'));
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

// Records every directory the daemon asks to watch, with the callback it registered.
// Each returned handle tracks its own closeCount (incremented by close()) and onCalls
// (an array of {event, handler} registrations). The closeCount is a per-handle closure
// variable that close() increments, NOT a property copied by value.
function recordingWatch() {
  const watched = [];
  const watch = (dir, cb) => {
    let closeCount = 0;
    const onCalls = [];
    const handle = {
      dir,
      cb,
      close() { closeCount += 1; },
      on(event, handler) { onCalls.push({ event, handler }); },
      get closeCount() { return closeCount; },
      get onCalls() { return onCalls; },
    };
    watched.push(handle);
    return handle;
  };
  return { watched, watch };
}

// --- tests (a, b, c, g) ---

// (a) queue/drafting callback registers queue/drafting/w1 once, not twice, after listDirs changes
test('a queue/drafting change registers queue/drafting/w1 once after listDirs grows from [w1] to [w1,w2]', async (t) => {
  const { env, pipelineDir } = setup(t);
  // Pre-seed drafting with only w1 so the initial syncDraftWatchers opens just w1.
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w1'), { recursive: true });
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 0 } }]);
  const timers = fakeTimers();
  const w = recordingWatch();
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { now: clock().now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: w.watch, log: noLog },
  });
  t.after(() => daemon.stop());
  await waitForRequests(server, 1);

  // At this point only w1 should be watched (from initial syncDraftWatchers).
  const w1AtStart = w.watched.filter((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w1'));
  assert.equal(w1AtStart.length, 1, 'w1 is watched once after startup with only w1 in drafting');
  assert.equal(w1AtStart[0].closeCount, 0, 'w1 handle is not closed at startup');

  // Now grow listDirs to include w2 -- this is the key: fire the queue/drafting callback
  // so syncDraftWatchers re-runs and picks up w2.
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w2'), { recursive: true });
  const draftWatch = w.watched.find((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting'));
  assert.ok(draftWatch, 'queue/drafting is watched');
  draftWatch.cb();
  await settle();

  // After the callback: w1 should still be watched once (not twice), w2 should now also be watched once.
  const w1After = w.watched.filter((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w1'));
  const w2After = w.watched.filter((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w2'));
  assert.equal(w1After.length, 1, 'w1 is watched exactly once after listDirs grows');
  assert.equal(w1After[0].closeCount, 0, 'w1 handle is not closed when listDirs grows');
  assert.equal(w2After.length, 1, 'w2 is watched exactly once after listDirs grows');
  assert.equal(w2After[0].closeCount, 0, 'w2 handle is not closed at startup');
  daemon.stop();
});

// (b) queue/drafting callback plus DEBOUNCE_MS advance yields exactly one claim
test('a queue/drafting change debounced 2 s into a single pull produces exactly one claim', async (t) => {
  const { env, pipelineDir } = setup(t);
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 0 } }]);
  const timers = fakeTimers();
  const w = recordingWatch();
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { now: clock().now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: w.watch, log: noLog },
  });
  t.after(() => daemon.stop());
  await waitForRequests(server, 1);
  assert.equal(server.requests.length, 1, 'one pull at start');

  // Fire the queue/drafting callback three times in quick succession.
  const draftWatch = w.watched.find((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting'));
  assert.ok(draftWatch, 'queue/drafting is watched');
  draftWatch.cb();
  draftWatch.cb();
  draftWatch.cb();

  // Only one debounce timer should be armed (three changes collapse into one).
  const debounces = timers.live().filter((x) => x.ms === DEBOUNCE_MS);
  assert.equal(debounces.length, 1, 'three changes leave one armed debounce timer');

  // Advance past the debounce and fire it.
  timers.fireLast();
  await waitForRequests(server, 2);
  assert.equal(server.requests.length, 2, 'one pull for the burst of changes');
});

// (c) startup with ['w1','w2'] opens both worker watchers before any event
test('startup with w1 and w2 in drafting opens both worker watchers before any event', async (t) => {
  const { env, pipelineDir } = setup(t);
  // Pre-create both worker drafting directories so syncDraftWatchers at startup picks them up.
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w1'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w2'), { recursive: true });
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 0 } }]);
  const timers = fakeTimers();
  const w = recordingWatch();
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { now: clock().now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: w.watch, log: noLog },
  });
  t.after(() => daemon.stop());
  await waitForRequests(server, 1);

  // Both worker watchers should be open and neither should have been closed.
  const w1 = w.watched.find((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w1'));
  const w2 = w.watched.find((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w2'));
  assert.ok(w1, 'w1 watcher is open at startup');
  assert.ok(w2, 'w2 watcher is open at startup');
  assert.equal(w1.closeCount, 0, 'w1 watcher has not been closed');
  assert.equal(w2.closeCount, 0, 'w2 watcher has not been closed');
  daemon.stop();
});

// (g) queue/drafting/w1 callback plus debounce yields one claim
test('a queue/drafting/w1 change debounced 2 s into a single pull produces exactly one claim', async (t) => {
  const { env, pipelineDir } = setup(t);
  // Pre-seed drafting with w1 so the w1 subwatcher is registered at startup.
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w1'), { recursive: true });
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 0 } }]);
  const timers = fakeTimers();
  const w = recordingWatch();
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { now: clock().now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: w.watch, log: noLog },
  });
  t.after(() => daemon.stop());
  await waitForRequests(server, 1);
  assert.equal(server.requests.length, 1, 'one pull at start');

  // Find the w1 subwatcher and fire it.
  const w1Watch = w.watched.find((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w1'));
  assert.ok(w1Watch, 'w1 subwatcher is open');
  w1Watch.cb();

  // One debounce timer should be armed.
  const debounces = timers.live().filter((x) => x.ms === DEBOUNCE_MS);
  assert.equal(debounces.length, 1, 'one armed debounce timer after w1 change');

  timers.fireLast();
  await waitForRequests(server, 2);
  assert.equal(server.requests.length, 2, 'one pull for the w1 change');
});

// (d) stop() closes every watcher handle (queue and per-worker) exactly once
test('stop() closes every watcher handle (queue and per-worker) exactly once', async (t) => {
  const { env, pipelineDir } = setup(t);
  // Pre-create both worker drafting directories so syncDraftWatchers at startup opens them.
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w1'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w2'), { recursive: true });
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 0 } }]);
  const timers = fakeTimers();
  const w = recordingWatch();
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { now: clock().now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: w.watch, log: noLog },
  });
  t.after(() => daemon.stop());
  await waitForRequests(server, 1);

  // Before stop: every handle is open, none closed.
  for (const handle of w.watched) {
    assert.equal(handle.closeCount, 0, `pre-stop: ${handle.dir} is not closed`);
  }
  const beforeStopCount = w.watched.length;

  // Stop the daemon.
  daemon.stop();

  // Every handle, including per-worker ones, must have close() called exactly once.
  assert.equal(w.watched.length, beforeStopCount, 'stop() does not drop handles from the recording');
  for (const handle of w.watched) {
    assert.equal(handle.closeCount, 1, `post-stop: ${handle.dir} close() called exactly once`);
  }
});

// (e) the safety timer's delay is 600_000 ms (literal, not the constant)
test('the safety timer armed after a successful pull fires at 600_000 ms', async (t) => {
  const { env, pipelineDir } = setup(t);
  // Pre-seed drafting with w1 so the initial syncDraftWatchers opens just w1.
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w1'), { recursive: true });
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 0 } }]);
  const timers = fakeTimers();
  const w = recordingWatch();
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { now: clock().now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: w.watch, log: noLog },
  });
  t.after(() => daemon.stop());
  await waitForRequests(server, 1);

  // After the first successful pull, exactly one safety timer should be armed at the documented 600_000 ms delay.
  const safety = timers.live().filter((x) => x.ms === 600_000);
  assert.equal(safety.length, 1, 'one safety timer armed after a successful pull');
  assert.equal(safety[0].ms, 600_000, 'safety timer delay is the literal 600_000 ms');
});

// (f) shrinking listDirs closes removed workers; growing it re-opens them
test('shrinking listDirs closes removed workers and growing it re-opens them', async (t) => {
  const { env, pipelineDir } = setup(t);
  // Pre-create both worker drafting directories so they exist on disk.
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w1'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w2'), { recursive: true });
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 0 } }]);
  const timers = fakeTimers();
  const w = recordingWatch();

  // listDirs starts returning both workers, then we shrink it to ['w2'], then grow it back.
  let dirs = ['w1', 'w2'];
  const customListDirs = () => dirs.slice();
  const daemon = startDaemon({
    env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
    deps: { now: clock().now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: w.watch, listDirs: customListDirs, log: noLog },
  });
  t.after(() => daemon.stop());
  await waitForRequests(server, 1);

  // Initial sync opens both w1 and w2 watchers.
  const w1Initial = w.watched.filter((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w1'));
  const w2Initial = w.watched.filter((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w2'));
  assert.equal(w1Initial.length, 1, 'w1 watcher is open at startup');
  assert.equal(w2Initial.length, 1, 'w2 watcher is open at startup');
  assert.equal(w1Initial[0].closeCount, 0, 'w1 is not closed at startup');
  assert.equal(w2Initial[0].closeCount, 0, 'w2 is not closed at startup');

  // Shrink listDirs to ['w2'] and fire the queue/drafting callback so syncDraftWatchers re-runs.
  dirs = ['w2'];
  const draftWatch = w.watched.find((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting'));
  assert.ok(draftWatch, 'queue/drafting is watched');
  draftWatch.cb();
  await settle();

  // w1's original handle must have been closed exactly once; w2's must not have been closed.
  const w1AfterShrink = w.watched.filter((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w1'));
  const w2AfterShrink = w.watched.filter((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w2'));
  assert.equal(w1AfterShrink.length, 1, 'w1 handle is still recorded after shrink (closed)');
  assert.equal(w1AfterShrink[0].closeCount, 1, 'w1 close() called exactly once on shrink');
  assert.equal(w2AfterShrink.length, 1, 'w2 handle is still recorded after shrink (kept)');
  assert.equal(w2AfterShrink[0].closeCount, 0, 'w2 close() not called on shrink');

  // Grow listDirs back to ['w1','w2'] and fire the callback again: w1 should be re-registered.
  dirs = ['w1', 'w2'];
  draftWatch.cb();
  await settle();

  const w1AfterGrow = w.watched.filter((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w1'));
  assert.equal(w1AfterGrow.length, 2, 'two w1 handles after grow (original closed + new registered)');
  assert.ok(w1AfterGrow.some((h) => h.closeCount === 0), 'the new w1 handle is not closed');
});

// (h) every watcher gets an 'error' listener that logs 'watch error'; a throwing deps.watch logs 'cannot watch' and the daemon still starts
test('(h) watcher error listeners log watch error, and a throwing deps.watch logs cannot watch while the daemon still starts', async (t) => {
  const { env, pipelineDir } = setup(t);
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w1'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting', 'w2'), { recursive: true });
  const server = await claimServer(t, [{ body: { ok: true, task: null, retryAfterSec: 0 } }]);

  // Part one: every fake handle has an 'error' listener, and invoking it logs 'watch error' with the message.
  {
    const timers = fakeTimers();
    const w = recordingWatch();
    const logs = [];
    const daemon = startDaemon({
      env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
      deps: { now: clock().now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: w.watch, log: (line) => logs.push(String(line)) },
    });
    t.after(() => daemon.stop());
    await settle();
    assert.ok(w.watched.length > 0, 'at least one watcher is open');
    for (const handle of w.watched) {
      const errorRegs = handle.onCalls.filter((c) => c.event === 'error');
      assert.equal(errorRegs.length, 1, `${handle.dir} has exactly one error listener`);
      errorRegs[0].handler(new Error('boom'));
    }
    assert.ok(logs.some((l) => l.includes('watch error') && l.includes('boom')), 'error listener logs a watch error line containing boom');
    daemon.stop();
  }

  // Part two: deps.watch throws for w1; the log names it as cannot watch and the daemon still starts with w2 watched.
  {
    const timers = fakeTimers();
    const w = recordingWatch();
    const logs = [];
    const throwDir = path.join(pipelineDir, 'queue', 'drafting', 'w1');
    const watch = (dir, cb) => {
      if (dir === throwDir) throw new Error('EACCES');
      return w.watch(dir, cb);
    };
    const daemon = startDaemon({
      env: { ...env, AGENT_MANAGER_CLAIM_URL: server.url },
      deps: { now: clock().now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch, log: (line) => logs.push(String(line)) },
    });
    t.after(() => daemon.stop());
    await settle();
    assert.ok(logs.some((l) => l.includes('cannot watch') && l.includes('queue/drafting/w1')), 'log names the directory that could not be watched');
    assert.ok(w.watched.some((h) => h.dir === path.join(pipelineDir, 'queue', 'drafting', 'w2')), 'w2 is still watched after w1 failed');
    assert.equal(typeof daemon.stop, 'function', 'daemon started and returned a handle');
    daemon.stop();
  }
});
