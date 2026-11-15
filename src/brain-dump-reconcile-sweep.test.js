'use strict';

// brain-dump-reconcile-sweep.js: the gated caller for the brain-dump reconcile. Injected reconcile, fake clock, a temp pipeline dir.
// Run: node --test src/brain-dump-reconcile-sweep.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sweepBrainDumpReconcile, mode, RECONCILE_EVERY_MS, STATE_FILE } = require('./brain-dump-reconcile-sweep.js');

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 31, 12);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-sweep-'));
  const pipelineDir = path.join(root, 'pipe');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done'), { recursive: true });
  const brainDumpPath = path.join(root, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, '{"entries":[]}');
  const statePath = path.join(pipelineDir, 'queue', STATE_FILE);
  return { root, pipelineDir, brainDumpPath, statePath, calls: [], logs: [] };
}
const fakeReconcile = (f, changes = []) => (opts) => { f.calls.push(opts); return { counts: { checked: 1, actioned: changes.length, possiblyResolved: 0, skipped: 0 }, changes }; };
const run = (f, extra = {}) => sweepBrainDumpReconcile({ reconcile: fakeReconcile(f), env: {}, now: T0, pipelineDir: f.pipelineDir, brainDumpPath: f.brainDumpPath, log: (l) => f.logs.push(l), ...extra });
const touch = (file, ms) => { fs.utimesSync(file, ms / 1000, ms / 1000); };

test('mode: default dry-run, off and on recognised', () => {
  assert.equal(mode({}), 'dry-run');
  assert.equal(mode({ AGENT_MANAGER_BRAIN_DUMP_RECONCILE: 'off' }), 'off');
  assert.equal(mode({ AGENT_MANAGER_BRAIN_DUMP_RECONCILE: 'false' }), 'off');
  assert.equal(mode({ AGENT_MANAGER_BRAIN_DUMP_RECONCILE: 'on' }), 'on');
  assert.equal(mode({ AGENT_MANAGER_BRAIN_DUMP_RECONCILE: 'junk' }), 'dry-run');
});

test('off never calls reconcile and writes no state', () => {
  const f = fixture();
  const out = run(f, { env: { AGENT_MANAGER_BRAIN_DUMP_RECONCILE: 'off' } });
  assert.deepEqual(out, { mode: 'off', ran: false });
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.statePath), false);
});

test('first tick runs and saves the state; an unchanged recent tick does not call reconcile', () => {
  const f = fixture();
  assert.equal(run(f).ran, true);
  assert.equal(f.calls.length, 1);
  assert.ok(fs.existsSync(f.statePath));
  const again = run(f, { now: T0 + 60 * 1000 });
  assert.deepEqual(again, { mode: 'dry-run', ran: false, reason: 'unchanged' });
  assert.equal(f.calls.length, 1, 'reconcile was not called again');
});

test('a file landing in queue/done runs it again', () => {
  const f = fixture();
  run(f);
  touch(path.join(f.pipelineDir, 'queue', 'done'), T0 + 5000);
  const out = run(f, { now: T0 + 120 * 1000 });
  assert.equal(out.ran, true);
  assert.equal(f.calls.length, 2);
});

test('a changed brain dump file runs it again', () => {
  const f = fixture();
  run(f);
  touch(f.brainDumpPath, T0 + 9000);
  assert.equal(run(f, { now: T0 + 120 * 1000 }).ran, true);
  assert.equal(f.calls.length, 2);
});

test('the six hour full run happens with unchanged signals, and changes it finds are counted as reconcileMissed with a warning', () => {
  const f = fixture();
  run(f);
  const out = run(f, { now: T0 + RECONCILE_EVERY_MS + HOUR, reconcile: fakeReconcile(f, [{ entryId: 'bd-1', action: 'actioned', taskId: 't1' }]) });
  assert.equal(out.ran, true);
  assert.equal(out.reconcileMissed, 1);
  assert.ok(f.logs.some((l) => /WARNING: 1 change\(s\)/.test(l)));
  const quiet = run(f, { now: T0 + 2 * RECONCILE_EVERY_MS + 2 * HOUR });
  assert.equal(quiet.reconcileMissed, undefined, 'no changes found, nothing missed');
});

test('a changed signal that finds changes is NOT counted as missed', () => {
  const f = fixture();
  run(f);
  touch(path.join(f.pipelineDir, 'queue', 'done'), T0 + 5000);
  const out = run(f, { now: T0 + 120 * 1000, reconcile: fakeReconcile(f, [{ entryId: 'bd-1', action: 'actioned', taskId: 't1' }]) });
  assert.equal(out.changes, 1);
  assert.equal(out.reconcileMissed, undefined);
});

test('dry-run passes dryRun true and logs each change; on passes dryRun false', () => {
  const f = fixture();
  run(f, { reconcile: fakeReconcile(f, [{ entryId: 'bd-9', action: 'actioned', taskId: 't9' }]) });
  assert.equal(f.calls[0].dryRun, true);
  assert.ok(f.logs.some((l) => /would actioned bd-9 \(t9\)/.test(l)));
  const g = fixture();
  run(g, { env: { AGENT_MANAGER_BRAIN_DUMP_RECONCILE: 'on' } });
  assert.equal(g.calls[0].dryRun, false);
});

test('a throwing reconcile reports the error and leaves the saved state alone, so the next tick retries', () => {
  const f = fixture();
  run(f);
  const before = fs.readFileSync(f.statePath, 'utf8');
  touch(path.join(f.pipelineDir, 'queue', 'done'), T0 + 5000);
  const out = run(f, { now: T0 + 120 * 1000, reconcile: () => { throw new Error('boom'); } });
  assert.equal(out.ran, false);
  assert.equal(out.error, 'boom');
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), before);
  assert.equal(run(f, { now: T0 + 180 * 1000 }).ran, true, 'the retry runs');
});

test('signals are read before the run: a change made inside reconcile triggers the next tick', () => {
  const f = fixture();
  const reconcile = (opts) => { f.calls.push(opts); touch(f.brainDumpPath, T0 + 777000); return { counts: {}, changes: [] }; };
  run(f, { reconcile });
  assert.equal(run(f, { now: T0 + 60 * 1000 }).ran, true);
});

test('the idle path makes exactly two stat calls and no reconcile call', () => {
  const f = fixture();
  run(f);
  const realStat = fs.statSync;
  const stats = [];
  fs.statSync = (p, ...a) => { stats.push(String(p)); return realStat.call(fs, p, ...a); };
  try { run(f, { now: T0 + 1000 }); } finally { fs.statSync = realStat; }
  assert.equal(stats.length, 2);
  assert.ok(stats.some((p) => p.endsWith(path.join('queue', 'done'))));
  assert.ok(stats.some((p) => p === f.brainDumpPath));
  assert.equal(f.calls.length, 1);
});

test('scripts/queue-watcher.sh invokes the sweep exactly once and still parses', () => {
  const sh = path.join(__dirname, '..', 'scripts', 'queue-watcher.sh');
  const text = fs.readFileSync(sh, 'utf8');
  assert.equal((text.match(/brain-dump-reconcile-sweep\.js"/g) || []).length, 1);
  assert.equal(spawnSync('bash', ['-n', sh]).status, 0);
});
