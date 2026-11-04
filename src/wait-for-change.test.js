'use strict';

// ADR-0024 S3: src/wait-for-change.js (the waiter) and wait_for_queue_change in scripts/local-worker.sh (the lane's idle wait). Real inotify on temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { waitForChange } = require('./wait-for-change.js');

const SRC = __dirname;
const WORKER = path.join(__dirname, '..', 'scripts', 'local-worker.sh');
const WAKE = path.join(__dirname, '..', 'scripts', 'wake-common.sh');
const REVIEW = path.join(__dirname, '..', 'scripts', 'review-runner.sh');
const APPLY = path.join(__dirname, '..', 'scripts', 'apply-loop.sh');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waitchg-'));
const later = (ms, fn) => setTimeout(fn, ms);

test('an entry added to a watched directory wakes the waiter well before the fallback', async () => {
  const d = tmp();
  later(200, () => fs.writeFileSync(path.join(d, 'task.json'), '{}'));
  const t0 = Date.now();
  const r = await waitForChange({ dirs: [d], timeoutMs: 10000, debounceMs: 100 });
  assert.equal(r.reason, 'event');
  assert.equal(r.dir, d);
  assert.ok(Date.now() - t0 < 9000, `woke after ${Date.now() - t0} ms: it must be the event, not the 10 s fallback`);
});

test('a burst of additions is ONE wake', async () => {
  const d = tmp();
  later(100, () => { for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(d, `t${i}.json`), '{}'); });
  const r = await waitForChange({ dirs: [d], timeoutMs: 5000, debounceMs: 200 });
  assert.equal(r.reason, 'event');
});

test('a REMOVAL does not wake the waiter (another lane claiming a task must not wake idle lanes)', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'claimed.json'), '{}');
  later(150, () => fs.unlinkSync(path.join(d, 'claimed.json')));
  const r = await waitForChange({ dirs: [d], timeoutMs: 900, debounceMs: 100 });
  assert.equal(r.reason, 'timeout');
});

test('nothing changes: the fallback timeout is reported as timeout', async () => {
  const r = await waitForChange({ dirs: [tmp()], timeoutMs: 300, debounceMs: 50 });
  assert.equal(r.reason, 'timeout');
});

test('no watchable directory: waits the full timeout and says sleep (the old behaviour)', async () => {
  const t0 = Date.now();
  const r = await waitForChange({ dirs: ['/nonexistent/aaa', '/nonexistent/bbb'], timeoutMs: 300 });
  assert.equal(r.reason, 'sleep');
  assert.ok(Date.now() - t0 >= 280);
});

test('every watcher is closed when the wait ends', async () => {
  let closed = 0, made = 0;
  const fakeWatch = () => { made++; const w = { on() {}, close() { closed++; } }; return w; };
  const dirs = [tmp(), tmp(), tmp()];
  await waitForChange({ dirs, timeoutMs: 100, watch: fakeWatch });
  assert.equal(made, 3);
  assert.equal(closed, 3);
});

test('CLI: prints "event <dir>" and exits 0 when a task is added', async () => {
  const d = tmp();
  // --since, like the lanes pass it: a task added while the waiter process is still starting up (node start-up is slow on a busy disk) is then caught up instead of missed.
  const since = String(Date.now() - 1000);
  const child = spawn('node', [path.join(SRC, 'wait-for-change.js'), '--timeout', '8', '--since', since, '--debounce', '100', d], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (x) => { out += x; });
  later(300, () => fs.writeFileSync(path.join(d, 'new.json'), '{}'));
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  assert.ok(out.trim() === `event ${d}` || out.trim() === `catchup ${d}`, `got: ${out.trim()}`);
});

test('catch-up: an entry that arrived BEFORE the waiter started (after --since) returns at once as catchup', async () => {
  const d = tmp();
  const since = Date.now() - 1000;
  fs.writeFileSync(path.join(d, 'early.json'), '{}');
  const t0 = Date.now();
  const r = await waitForChange({ dirs: [d], timeoutMs: 10000, sinceMs: since, debounceMs: 100 });
  assert.equal(r.reason, 'catchup');
  assert.ok(Date.now() - t0 < 9000, 'the catch-up returns at once, not at the 10 s fallback');
});

test('catch-up: a file moved in with mv (old mtime, new ctime) counts', async () => {
  const d = tmp(), src = tmp();
  const f = path.join(src, 'moved.json');
  fs.writeFileSync(f, '{}');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(f, old, old);
  const since = Date.now() - 500;
  fs.renameSync(f, path.join(d, 'moved.json'));
  const r = await waitForChange({ dirs: [d], timeoutMs: 5000, sinceMs: since, debounceMs: 100 });
  assert.equal(r.reason, 'catchup');
});

test('catch-up: a removal after --since does NOT count, and an old directory costs no scan', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.json'), '{}');
  const since = Date.now() + 50;
  await new Promise((r) => setTimeout(r, 120));
  fs.unlinkSync(path.join(d, 'a.json'));
  const r = await waitForChange({ dirs: [d], timeoutMs: 400, sinceMs: since, debounceMs: 50 });
  assert.equal(r.reason, 'timeout');
});

// --- the lane's function, extracted from the real script and run in a throwaway bash ---
function laneWait({ env = {}, addAfterMs = null, tickStartedAgoS = 100, callArgs = '', addSub = 'pending' } = {}) {
  const src = fs.readFileSync(WAKE, 'utf8');
  const start = src.indexOf('wait_for_queue_change() {');
  assert.ok(start > 0, 'function exists in wake-common.sh');
  const end = src.indexOf('\n}\n', start) + 3;
  const q = tmp();
  for (const sub of ['pending', 'review', 'approved']) fs.mkdirSync(path.join(q, sub));
  const script = `set -u\nPACKAGE_SRC_DIR=${JSON.stringify(SRC)}\nQUEUE_DIR=${JSON.stringify(q)}\nONCE=false\nLOG_FILE=/dev/null\nLAST_WAKE=\nLAST_TICK_START=$(( $(date +%s) - ${tickStartedAgoS} ))\nLAST_TICK_START_MS=$(( LAST_TICK_START * 1000 ))\n${src.slice(start, end)}\nt0=$(date +%s%N)\nwait_for_queue_change ${callArgs.replace('@Q', q)}\nt1=$(date +%s%N)\necho "wake=$LAST_WAKE ms=$(( (t1 - t0) / 1000000 ))"\n`;
  const p = spawn('bash', ['-c', script], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), AGENT_MANAGER_PROJECTS_PATH: '/nonexistent/projects.json', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', (x) => { out += x; });
  if (addAfterMs !== null) later(addAfterMs, () => fs.writeFileSync(path.join(q, addSub, 'x.json'), '{}'));
  return new Promise((resolve) => p.on('close', () => { const m = /wake=(\S+) ms=(\d+)/.exec(out) || []; resolve({ wake: m[1], ms: Number(m[2]) }); }));
}

test('lane wait: a task added to pending ends the wait quickly with wake=event', async () => {
  const r = await laneWait({ env: { AGENT_MANAGER_WAKE_FALLBACK_SECS: '20', AGENT_MANAGER_WAKE_MIN_GAP_SECS: '0' }, addAfterMs: 400 });
  assert.match(r.wake, /^(event|catchup)$/, 'event or, when the waiter was still starting, catchup');
  assert.ok(r.ms < 15000, `${r.ms} ms: well before the 20 s fallback`);
});

test('lane wait: a task that landed while the waiter was still starting up is not missed (catch-up)', async () => {
  const r = await laneWait({ env: { AGENT_MANAGER_WAKE_FALLBACK_SECS: '20', AGENT_MANAGER_WAKE_MIN_GAP_SECS: '0' }, addAfterMs: 5, tickStartedAgoS: 0 });
  assert.match(r.wake, /^(event|catchup)$/);
  assert.ok(r.ms < 15000, `${r.ms} ms: well before the 20 s fallback`);
});

test('lane wait: with nothing added the fallback ends it with wake=timeout', async () => {
  const r = await laneWait({ env: { AGENT_MANAGER_WAKE_FALLBACK_SECS: '1', AGENT_MANAGER_WAKE_MIN_GAP_SECS: '0' } });
  assert.equal(r.wake, 'timeout');
});

test('lane wait: AGENT_MANAGER_LANE_WAKE=off is the plain ORC_TICK_SECS sleep', async () => {
  const r = await laneWait({ env: { AGENT_MANAGER_LANE_WAKE: 'off', ORC_TICK_SECS: '1' }, addAfterMs: 100 });
  assert.equal(r.wake, 'sleep');
  assert.ok(r.ms >= 900, `${r.ms} ms: an added task must NOT end the plain sleep early`);
});

test('lane wait: the minimum gap holds a lane back even when a task arrives at once', async () => {
  const r = await laneWait({ env: { AGENT_MANAGER_WAKE_FALLBACK_SECS: '20', AGENT_MANAGER_WAKE_MIN_GAP_SECS: '3' }, addAfterMs: 200, tickStartedAgoS: 0 });
  assert.match(r.wake, /^(event|catchup)$/);
  assert.ok(r.ms >= 1800, `${r.ms} ms`);       // the gap is measured from a tick start stamped in whole seconds, so up to 1 s of the 3 s is already spent
});

// --- the reconcile counter in end_of_tick_pause, extracted from the real script ---
function pauseAfterWork(lastWake) {
  const src = fs.readFileSync(WORKER, 'utf8');
  const start = src.indexOf('end_of_tick_pause() {');
  assert.ok(start > 0, 'function exists in local-worker.sh');
  const end = src.indexOf('\n}\n', start) + 3;
  const script = `set -u\nINSTANCE_ID=worker-t\nLAST_WAKE=${lastWake}\nWAKE_RECONCILE_HITS=0\nCONSECUTIVE_INFRA_FAILURES=0\ndid_work=true\nTICK_HAD_INFRA_FAILURE=false\n${src.slice(start, end)}\nend_of_tick_pause\necho "hits=$WAKE_RECONCILE_HITS last=[$LAST_WAKE]"\n`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
}

test('a tick that found work right after a TIMEOUT wake is logged and counted as a reconcile hit', () => {
  const r = pauseAfterWork('timeout');
  assert.match(r.stderr, /\[worker-worker-t\] wake reconcile: found work after a TIMEOUT wake \(hit 1\)/);
  assert.match(r.stdout, /hits=1 last=\[\]/);
});

test('a tick that found work after an event wake is not a reconcile hit', () => {
  const r = pauseAfterWork('event');
  assert.doesNotMatch(r.stderr, /wake reconcile/);
  assert.match(r.stdout, /hits=0 last=\[\]/);
});

// --- the same wait for the review daemon (queue/review) and the apply loop (queue/approved) ---
test('lane wait with subdirs: an entry added to review/ wakes a review-style wait, one added to pending/ does not', async () => {
  const env = { AGENT_MANAGER_WAKE_FALLBACK_SECS: '2', AGENT_MANAGER_WAKE_MIN_GAP_SECS: '0' };
  const envHit = { AGENT_MANAGER_WAKE_FALLBACK_SECS: '20', AGENT_MANAGER_WAKE_MIN_GAP_SECS: '0' };
  const hit = await laneWait({ env: envHit, callArgs: 'review @Q', addAfterMs: 400, addSub: 'review' });
  assert.match(hit.wake, /^(event|catchup)$/);
  assert.ok(hit.ms < 15000, `${hit.ms} ms: well before the 20 s fallback`);
  const miss = await laneWait({ env, callArgs: 'review @Q', addAfterMs: 300, addSub: 'pending' });
  assert.equal(miss.wake, 'timeout');
});

test('lane wait with subdirs: approved/ for the apply loop, and the default stays pending,adhoc', async () => {
  const env = { AGENT_MANAGER_WAKE_FALLBACK_SECS: '20', AGENT_MANAGER_WAKE_MIN_GAP_SECS: '0' };
  const hit = await laneWait({ env, callArgs: 'approved @Q', addAfterMs: 400, addSub: 'approved' });
  assert.match(hit.wake, /^(event|catchup)$/);
  const dflt = await laneWait({ env, callArgs: '', addAfterMs: 400, addSub: 'pending' });
  assert.match(dflt.wake, /^(event|catchup)$/);
});

test('CLI --subdirs picks the sub-directory that is watched under --pool-queues', async () => {
  const q = tmp();
  fs.mkdirSync(path.join(q, 'review'));
  fs.mkdirSync(path.join(q, 'pending'));
  const since = String(Date.now() - 1000);
  const child = spawn('node', [path.join(SRC, 'wait-for-change.js'), '--timeout', '6', '--since', since, '--debounce', '100', '--subdirs', 'review', '--pool-queues', q], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, AGENT_MANAGER_PROJECTS_PATH: '/nonexistent/projects.json' } });
  let out = '';
  child.stdout.on('data', (x) => { out += x; });
  later(300, () => fs.writeFileSync(path.join(q, 'review', 'r.json'), '{}'));
  await new Promise((r) => child.on('close', r));
  assert.match(out.trim(), /^(event|catchup) .*\/review$/);
});

// The daemons themselves cannot be run in a test; these assert they are wired to the shared function with the right sub-directory and still keep the plain-sleep recovery waits.
test('review-runner.sh, apply-loop.sh and local-worker.sh source the shared wait and call it with the right queue sub-directory', () => {
  const rv = fs.readFileSync(REVIEW, 'utf8'), ap = fs.readFileSync(APPLY, 'utf8'), lw = fs.readFileSync(WORKER, 'utf8');
  assert.match(rv, /source "\$\{SCRIPT_DIR\}\/wake-common\.sh"/);
  assert.match(rv, /wait_for_queue_change review "\$QUEUE_DIR"/);
  assert.match(rv, /wake reconcile: found work after a TIMEOUT wake/);
  assert.match(ap, /source "\$\{SCRIPT_DIR\}\/wake-common\.sh"/);
  assert.match(ap, /wait_for_queue_change approved "\$home_queue"/);
  assert.match(lw, /source "\$\{SCRIPT_DIR\}\/wake-common\.sh"/);
  assert.equal(/^wait_for_queue_change\(\) \{/m.test(lw), false, 'the function lives in wake-common.sh only');
  assert.match(rv, /sleep "\$\{ORC_TICK_SECS:-30\}"/, 'review-runner keeps its recovery sleeps');
});
