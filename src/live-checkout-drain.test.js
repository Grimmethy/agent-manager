'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requestPipelineRestart, drainStep, pendingPath, PENDING_FILE, DEFAULT_MAX_MIN } = require('./live-checkout-drain.js');

const SHA = 'b'.repeat(40);
const SHA2 = 'c'.repeat(40);
const PIPE = '/pipe';
const FILE = pendingPath(PIPE);
const T0 = Date.UTC(2026, 10, 16, 10, 0, 0);
const MIN = 60000;

function memFs(files = {}) {
  return {
    files,
    mkdirSync() {},
    readFileSync(p) { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFileSync(p, data) { files[p] = String(data); },
    renameSync(from, to) { files[to] = files[from]; delete files[from]; },
    unlinkSync(p) { if (!(p in files)) throw new Error('ENOENT'); delete files[p]; },
  };
}

// An in-memory _pause-node marker with the real semantics we rely on: readPause gives null when there is none.
function fakePauses(initial = null) {
  const state = { marker: initial, sets: [], clears: 0 };
  return {
    state,
    readPause: () => state.marker,
    setPause: (scope, opts) => { state.sets.push({ scope, ...opts }); state.marker = { scope, ...opts }; },
    clearPause: () => { state.clears += 1; state.marker = null; },
  };
}
function notifier() {
  const calls = [];
  const fn = (message) => { calls.push(message); return { sent: true }; };
  fn.calls = calls;
  return fn;
}
function runner(result = { ok: true }) {
  const calls = [];
  const fn = (args) => { calls.push(args); return typeof result === 'function' ? result(args) : result; };
  fn.calls = calls;
  return fn;
}
const request = (fs, extra = {}) => requestPipelineRestart({ pipelineDir: PIPE, newSha: SHA, paths: ['src/a.js'], now: T0, fs, ...extra });
const step = (fs, extra = {}) => drainStep({ pipelineDir: PIPE, repoDir: '/repo', env: {}, now: T0 + MIN, fs, lanes: () => ['idle', 'disabled'], drafts: () => false, ...extra });

test('requestPipelineRestart writes the pending record; a second request keeps since and the flags, takes the new sha and unions the paths', () => {
  const fs = memFs();
  const first = request(fs);
  assert.deepEqual(first, { newSha: SHA, since: new Date(T0).toISOString(), paths: ['src/a.js'], alerted: false, stuckAlerted: false, failedAlerted: false });
  assert.equal(PENDING_FILE, 'live-sync-pending.json');
  fs.files[FILE] = JSON.stringify({ ...first, alerted: true });
  const second = request(fs, { newSha: SHA2, paths: ['scripts/x.sh', 'src/a.js'], now: T0 + 5 * MIN });
  assert.equal(second.since, new Date(T0).toISOString());
  assert.equal(second.alerted, true);
  assert.equal(second.newSha, SHA2);
  assert.deepEqual(second.paths, ['src/a.js', 'scripts/x.sh']);
});

test('requestPipelineRestart refuses a bad sha or no dir and never throws on an unwritable file', () => {
  const fs = memFs();
  assert.equal(request(fs, { newSha: 'abc' }), null);
  assert.equal(requestPipelineRestart({ newSha: SHA, fs }), null);
  fs.renameSync = () => { throw new Error('EROFS'); };
  assert.equal(request(fs), null);
});

test('no pending record: the step does nothing at all (no pause, no lanes read, no notice)', () => {
  const pauses = fakePauses();
  const lanes = () => { throw new Error('must not be read'); };
  const run = runner();
  const notify = notifier();
  assert.equal(step(memFs(), { pauses, lanes, notify, run }), 'none');
  assert.deepEqual(pauses.state.sets, []);
  assert.equal(pauses.state.clears, 0);
  assert.deepEqual(run.calls, []);
  assert.deepEqual(notify.calls, []);
  assert.equal(drainStep({}), 'none');
});

test('while a lane is working the marker is set with source wok, a reason naming the new sha and a short expiry, refreshed on every step, and nothing restarts', () => {
  const fs = memFs();
  request(fs);
  const pauses = fakePauses();
  const run = runner();
  assert.equal(step(fs, { pauses, run, lanes: () => ['idle', 'working'], notify: notifier() }), 'waiting');
  assert.equal(step(fs, { pauses, run, lanes: () => ['idle', 'working'], notify: notifier(), now: T0 + 2 * MIN }), 'waiting');
  assert.equal(pauses.state.sets.length, 2);
  assert.deepEqual(pauses.state.sets[0], { scope: 'node', source: 'wok', reason: 'live-sync restart pending for bbbbbbbb', ttlMin: 5 });
  assert.deepEqual(run.calls, []);
  assert.equal(pauses.state.clears, 0);
});

test('a draft in progress or an unreadable lane heartbeat keeps it waiting', () => {
  const fs = memFs();
  request(fs);
  assert.equal(step(fs, { pauses: fakePauses(), run: runner(), drafts: () => true, notify: notifier() }), 'waiting');
  assert.equal(step(fs, { pauses: fakePauses(), run: runner(), lanes: () => ['idle', null], notify: notifier() }), 'waiting');
});

test('every lane idle or disabled and no draft: the restart runs once, the marker is cleared (it is ours), the record is deleted and one summary notice is sent', () => {
  const fs = memFs();
  request(fs);
  const pauses = fakePauses();
  const run = runner();
  const notify = notifier();
  assert.equal(step(fs, { pauses, run, notify }), 'restarted');
  assert.equal(run.calls.length, 1);
  assert.deepEqual([run.calls[0].repoDir, run.calls[0].newSha], ['/repo', SHA]);
  assert.equal(pauses.state.clears, 1);
  assert.equal(pauses.state.marker, null);
  assert.equal(FILE in fs.files, false);
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].level, 'summary');
  assert.equal(notify.calls[0].key, 'live-sync-restarted:bbbbbbbb');
  assert.equal(step(fs, { pauses, run, notify }), 'none', 'a second step after the restart does nothing');
  assert.equal(run.calls.length, 1);
});

test('a foreign pause is never overwritten or cleared: one summary notice, blocked, the restart waits; once it clears the drain proceeds', () => {
  const fs = memFs();
  request(fs);
  const pauses = fakePauses({ scope: 'node', source: 'site-traffic', reason: 'site busy' });
  const run = runner();
  const notify = notifier();
  assert.equal(step(fs, { pauses, run, notify }), 'blocked');
  assert.equal(step(fs, { pauses, run, notify, now: T0 + 2 * MIN }), 'blocked');
  assert.deepEqual(pauses.state.sets, []);
  assert.equal(pauses.state.clears, 0);
  assert.equal(pauses.state.marker.source, 'site-traffic');
  assert.deepEqual(run.calls, []);
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].key, 'live-sync-blocked:bbbbbbbb');
  pauses.state.marker = null;
  assert.equal(step(fs, { pauses, run, notify, now: T0 + 3 * MIN }), 'restarted');
});

test('the marker is cleared only when its source is still wok: another source that took over during the restart is left alone', () => {
  const fs = memFs();
  request(fs);
  const pauses = fakePauses();
  const run = runner(() => { pauses.state.marker = { scope: 'node', source: 'operator', reason: 'by hand' }; return { ok: true }; });
  assert.equal(step(fs, { pauses, run, notify: notifier() }), 'restarted');
  assert.equal(pauses.state.clears, 0);
  assert.equal(pauses.state.marker.source, 'operator');
});

test('past the limit: nothing is cleared or started, one urgent alert, the record stays; the limit comes from the env', () => {
  const fs = memFs();
  request(fs);
  const pauses = fakePauses();
  const run = runner();
  const notify = notifier();
  assert.equal(DEFAULT_MAX_MIN, 30);
  assert.equal(step(fs, { pauses, run, notify, now: T0 + 30 * MIN }), 'restarted', 'exactly at the limit is still inside it');
  request(fs);
  assert.equal(step(fs, { pauses, run, notify, now: T0 + 31 * MIN }), 'stuck');
  assert.equal(step(fs, { pauses, run, notify, now: T0 + 45 * MIN }), 'stuck');
  assert.equal(run.calls.length, 1, 'no restart past the limit');
  const alerts = notify.calls.filter((m) => m.key === 'live-sync-stuck:bbbbbbbb');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'urgent');
  assert.equal(FILE in fs.files, true);
  assert.equal(JSON.parse(fs.files[FILE]).stuckAlerted, true);
  const fs2 = memFs();
  request(fs2);
  assert.equal(step(fs2, { pauses: fakePauses(), run, notify: notifier(), env: { AGENT_MANAGER_LIVE_SYNC_DRAIN_MAX_MIN: '1' }, now: T0 + 2 * MIN }), 'stuck');
  for (const bad of ['0', '-4', 'x', '']) {
    const fs3 = memFs();
    request(fs3);
    assert.equal(step(fs3, { pauses: fakePauses(), run: runner(), notify: notifier(), env: { AGENT_MANAGER_LIVE_SYNC_DRAIN_MAX_MIN: bad }, now: T0 + 20 * MIN }), 'restarted', bad);
  }
});

test('a restart that fails (a false result or a throw) alerts once, keeps the record and the marker, and is tried again next step', () => {
  for (const result of [{ ok: false, error: 'spawn bash ENOENT' }, () => { throw new Error('boom'); }]) {
    const fs = memFs();
    request(fs);
    const pauses = fakePauses();
    const notify = notifier();
    const run = runner(result);
    assert.equal(step(fs, { pauses, run, notify }), 'failed');
    assert.equal(step(fs, { pauses, run, notify, now: T0 + 2 * MIN }), 'failed');
    assert.equal(run.calls.length, 2);
    assert.equal(notify.calls.filter((m) => m.key === 'live-sync-failed:bbbbbbbb').length, 1);
    assert.equal(pauses.state.clears, 0);
    assert.equal(FILE in fs.files, true);
  }
});

test('a throwing notifier never changes the outcome', () => {
  const fs = memFs();
  request(fs);
  const notify = () => { throw new Error('ntfy down'); };
  assert.equal(step(fs, { pauses: fakePauses(), run: runner(), notify }), 'restarted');
});

test('the default restart is one detached bash that stops (keeping the dashboard and plugins) and then launches', () => {
  const source = nodeFs.readFileSync(path.join(__dirname, 'live-checkout-drain.js'), 'utf8');
  assert.match(source, /scripts\/stop\.sh --keep-dashboard --keep-plugins; scripts\/launch\.sh/);
  assert.match(source, /detached: true/);
  assert.equal(/set(Interval|Timeout)/.test(source), false, 'no timer');
});

test('with the real files: the record and the real worker-switch marker round-trip in a temp dir', () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'live-drain-real-'));
  const env = { HOME: dir, AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch') };
  requestPipelineRestart({ pipelineDir: dir, newSha: SHA, paths: ['src/a.js'], now: T0 });
  const run = runner();
  assert.equal(drainStep({ pipelineDir: dir, repoDir: '/repo', env, now: T0 + MIN, lanes: () => ['working'], drafts: () => false, run, notify: notifier() }), 'waiting');
  assert.equal(nodeFs.existsSync(path.join(dir, 'switch', '_pause-node')), true);
  assert.equal(drainStep({ pipelineDir: dir, repoDir: '/repo', env, now: T0 + 2 * MIN, lanes: () => ['idle'], drafts: () => false, run, notify: notifier() }), 'restarted');
  assert.equal(nodeFs.existsSync(path.join(dir, 'switch', '_pause-node')), false);
  assert.equal(nodeFs.existsSync(path.join(dir, 'instances', PENDING_FILE)), false);
  assert.equal(run.calls.length, 1);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});
