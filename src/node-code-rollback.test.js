'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { recordApply, markRestartDone, judge, restorePrevious, markerPath, DEFAULT_MINUTES } = require('./node-code-rollback.js');

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const PIPE = '/pipe';
const MARKER = markerPath(PIPE);
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
    appendFileSync(p, data) { files[p] = (files[p] || '') + String(data); },
  };
}
const apply = (fs, extra = {}) => recordApply({ pipelineDir: PIPE, previous: OLD, target: NEW, env: {}, now: T0, fs, ...extra });
const ask = (fs, extra = {}) => judge({ pipelineDir: PIPE, heartbeatOk: true, reportedSha: NEW, now: T0 + MIN, fs, ...extra });

test('recordApply writes the marker with the default 10 minute deadline, restartDone false and state applying', () => {
  const fs = memFs();
  const marker = apply(fs);
  assert.equal(DEFAULT_MINUTES, 10);
  assert.deepEqual(marker, { previous: OLD, target: NEW, deadline: new Date(T0 + 10 * MIN).toISOString(), restartDone: false, state: 'applying' });
  assert.deepEqual(JSON.parse(fs.files[MARKER]), marker);
  assert.equal(Object.keys(fs.files).length, 1);
});

test('AGENT_MANAGER_CODE_ROLLBACK_MIN sets the deadline; a bad value falls back to 10', () => {
  assert.equal(apply(memFs(), { env: { AGENT_MANAGER_CODE_ROLLBACK_MIN: '3' } }).deadline, new Date(T0 + 3 * MIN).toISOString());
  for (const bad of ['0', '-5', 'x', '']) {
    assert.equal(apply(memFs(), { env: { AGENT_MANAGER_CODE_ROLLBACK_MIN: bad } }).deadline, new Date(T0 + 10 * MIN).toISOString(), bad);
  }
});

test('recordApply refuses a missing pipeline dir and shas that are not 40 lowercase hex', () => {
  const fs = memFs();
  assert.throws(() => apply(fs, { pipelineDir: '' }), /pipelineDir/);
  assert.throws(() => apply(fs, { previous: 'abc' }), /previous/);
  assert.throws(() => apply(fs, { target: OLD.toUpperCase() }), /target/);
  assert.throws(() => apply(fs, { target: undefined }), /target/);
  assert.deepEqual(fs.files, {});
});

test('no marker gives none', () => {
  assert.deepEqual(ask(memFs()), { decision: 'none' });
  assert.deepEqual(ask(memFs({ [MARKER]: '{not json' })), { decision: 'none' });
  assert.deepEqual(ask(memFs({ [MARKER]: '[1]' })), { decision: 'none' });
});

test('good: restart done, heartbeat ok and the target sha reported; the marker is deleted', () => {
  const fs = memFs();
  apply(fs);
  assert.equal(markRestartDone({ pipelineDir: PIPE, fs }), true);
  assert.deepEqual(ask(fs), { decision: 'good', previous: OLD, target: NEW, deadline: new Date(T0 + 10 * MIN).toISOString() });
  assert.equal(MARKER in fs.files, false);
  assert.deepEqual(ask(fs), { decision: 'none' });
});

test('a heartbeat before the restart is done never counts as good, even with the right sha', () => {
  const fs = memFs();
  apply(fs);
  assert.equal(ask(fs).decision, 'waiting');
  assert.equal(MARKER in fs.files, true);
});

test('a wrong sha waits, then rolls back after the deadline', () => {
  const fs = memFs();
  apply(fs);
  markRestartDone({ pipelineDir: PIPE, fs });
  assert.equal(ask(fs, { reportedSha: OTHER }).decision, 'waiting');
  assert.equal(ask(fs, { reportedSha: OTHER, now: T0 + 10 * MIN }).decision, 'waiting');
  const late = ask(fs, { reportedSha: OTHER, now: T0 + 10 * MIN + 1 });
  assert.deepEqual(late, { decision: 'rollback', previous: OLD, target: NEW, deadline: new Date(T0 + 10 * MIN).toISOString() });
  assert.equal(MARKER in fs.files, true);
});

test('a failed or missing heartbeat rolls back only after the deadline', () => {
  const fs = memFs();
  apply(fs);
  markRestartDone({ pipelineDir: PIPE, fs });
  assert.equal(ask(fs, { heartbeatOk: false }).decision, 'waiting');
  assert.equal(ask(fs, { heartbeatOk: false, now: T0 + 11 * MIN }).decision, 'rollback');
  assert.equal(ask(fs, { heartbeatOk: undefined, reportedSha: undefined, now: T0 + 11 * MIN }).decision, 'rollback');
});

test('past the deadline with a restart that never finished is a rollback', () => {
  const fs = memFs();
  apply(fs);
  assert.equal(ask(fs, { now: T0 + 11 * MIN }).decision, 'rollback');
});

test('a late but good confirmation still wins over the deadline', () => {
  const fs = memFs();
  apply(fs);
  markRestartDone({ pipelineDir: PIPE, fs });
  assert.equal(ask(fs, { now: T0 + 60 * MIN }).decision, 'good');
});

test('a marker with an unusable deadline is treated as expired', () => {
  const fs = memFs({ [MARKER]: JSON.stringify({ previous: OLD, target: NEW, deadline: 'soon', restartDone: false, state: 'applying' }) });
  assert.equal(ask(fs).decision, 'rollback');
});

test('markRestartDone with no marker or an unwritable one returns false and changes nothing', () => {
  assert.equal(markRestartDone({ pipelineDir: PIPE, fs: memFs() }), false);
  const fs = memFs();
  apply(fs);
  fs.renameSync = () => { throw new Error('EROFS'); };
  assert.equal(markRestartDone({ pipelineDir: PIPE, fs }), false);
  assert.equal(JSON.parse(fs.files[MARKER]).restartDone, false);
});

test('a second apply over an unconfirmed marker keeps the first previous sha and restarts the clock', () => {
  const fs = memFs();
  apply(fs);
  const second = recordApply({ pipelineDir: PIPE, previous: NEW, target: OTHER, env: {}, now: T0 + 5 * MIN, fs });
  assert.equal(second.previous, OLD);
  assert.equal(second.target, OTHER);
  assert.equal(second.deadline, new Date(T0 + 15 * MIN).toISOString());
  assert.equal(second.restartDone, false);
});

test('a bad previous in an old marker is not kept', () => {
  const fs = memFs({ [MARKER]: JSON.stringify({ previous: 'junk', target: NEW }) });
  assert.equal(apply(fs, { target: OTHER, previous: NEW }).previous, NEW);
});

test('with the real fs the marker lands in instances/code-rollback.json and is removed on good', () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'rollback-'));
  recordApply({ pipelineDir: dir, previous: OLD, target: NEW, env: {}, now: T0 });
  assert.equal(JSON.parse(nodeFs.readFileSync(path.join(dir, 'instances', 'code-rollback.json'), 'utf8')).target, NEW);
  assert.equal(nodeFs.readdirSync(path.join(dir, 'instances')).length, 1);
  markRestartDone({ pipelineDir: dir });
  assert.equal(judge({ pipelineDir: dir, heartbeatOk: true, reportedSha: NEW, now: T0 + MIN }).decision, 'good');
  assert.deepEqual(nodeFs.readdirSync(path.join(dir, 'instances')), []);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

// FF-10/10c: restorePrevious.
const REPO = '/repo';
const BAD = path.join(PIPE, 'instances', 'code-bad-sha.json');
const AUDIT = path.join(PIPE, 'instances', 'code-rollback.log');
const PENDING = path.join(PIPE, 'instances', 'code-restart-pending.json');

function fakeRun({ status = '', head = NEW, paths = ['src/a.js'], failReset = false, failStatus = false } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const sub = args.slice(2);
    if (sub[0] === 'status') { if (failStatus) throw new Error('not a git repo'); return status; }
    if (sub[0] === 'rev-parse') return `${head}\n`;
    if (sub[0] === 'reset') { if (failReset) throw new Error('cannot lock ref'); return ''; }
    if (sub[0] === 'diff') return `${paths.join('\n')}\n`;
    throw new Error(`unexpected git call ${args.join(' ')}`);
  };
  run.calls = calls;
  return run;
}
function notifier(failFirst = false) {
  const calls = [];
  const fn = async (message, opts) => { calls.push({ message, opts }); if (failFirst && calls.length === 1) throw new Error('ntfy down'); return { sent: true }; };
  fn.calls = calls;
  return fn;
}
const restore = (fs, run, notify, extra = {}) => restorePrevious({ repoDir: REPO, pipelineDir: PIPE, run, notify, now: T0 + 12 * MIN, env: {}, fs, ...extra });
const armed = () => { const fs = memFs(); apply(fs); return fs; };

test('restorePrevious on a clean checkout still at the target resets once, records the bad sha, plans the restart, deletes the marker and notifies once', async () => {
  const fs = armed();
  const run = fakeRun();
  const notify = notifier();
  const r = await restore(fs, run, notify);
  assert.equal(r.action, 'restored');
  assert.deepEqual([r.previous, r.target], [OLD, NEW]);
  assert.equal(run.calls.filter((c) => c[3] === 'reset').length, 1);
  assert.deepEqual(run.calls.find((c) => c[3] === 'reset'), ['git', '-C', REPO, 'reset', '--hard', OLD]);
  assert.deepEqual(run.calls.find((c) => c[3] === 'status'), ['git', '-C', REPO, 'status', '--porcelain=v1', '-uno']);
  const bad = JSON.parse(fs.files[BAD]);
  assert.deepEqual([bad.target, bad.previous, bad.at], [NEW, OLD, new Date(T0 + 12 * MIN).toISOString()]);
  const plan = JSON.parse(fs.files[PENDING]);
  assert.deepEqual([plan.oldSha, plan.newSha, plan.units, plan.pipeline], [NEW, OLD, true, true]);
  assert.equal(MARKER in fs.files, false);
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].message.key, 'code-rollback:bbbbbbbb');
  assert.equal(notify.calls[0].message.level, 'summary');
  assert.match(notify.calls[0].message.text, /bbbbbbbb/);
  assert.match(notify.calls[0].message.text, /aaaaaaaa/);
  assert.match(fs.files[AUDIT], /"action":"restored"/);
});

test('a second call after the marker is gone does nothing: no git, no notice', async () => {
  const fs = armed();
  await restore(fs, fakeRun(), notifier());
  const run = fakeRun();
  const notify = notifier();
  assert.deepEqual(await restore(fs, run, notify), { action: 'none' });
  assert.deepEqual(run.calls, []);
  assert.equal(notify.calls.length, 0);
});

test('a dirty checkout refuses: no reset, the marker stays, one refusal notice even when asked twice', async () => {
  const fs = armed();
  const run = fakeRun({ status: ' M src/a.js' });
  const notify = notifier();
  const r = await restore(fs, run, notify);
  assert.deepEqual([r.action, r.reason], ['refused', 'the checkout has local changes']);
  assert.equal(run.calls.some((c) => c[3] === 'reset'), false);
  assert.equal(MARKER in fs.files, true);
  assert.equal(BAD in fs.files, false);
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].message.key, 'code-rollback-refused:bbbbbbbb');
  await restore(fs, run, notify);
  assert.equal(notify.calls.length, 1, 'the second refusal is audited but not announced again');
  assert.equal(fs.files[AUDIT].trim().split('\n').length, 2);
});

test('a HEAD that moved off the target refuses with both shas in the reason', async () => {
  const fs = armed();
  const run = fakeRun({ head: OTHER });
  const notify = notifier();
  const r = await restore(fs, run, notify);
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /cccccccc/);
  assert.match(r.reason, /bbbbbbbb/);
  assert.equal(run.calls.some((c) => c[3] === 'reset'), false);
  assert.equal(notify.calls.length, 1);
});

test('a git failure on status or on the reset refuses, keeps the marker and records no bad sha', async () => {
  for (const opts of [{ failStatus: true }, { failReset: true }]) {
    const fs = armed();
    const notify = notifier();
    const r = await restore(fs, fakeRun(opts), notify);
    assert.equal(r.action, 'refused', JSON.stringify(opts));
    assert.equal(MARKER in fs.files, true);
    assert.equal(BAD in fs.files, false);
    assert.equal(PENDING in fs.files, false);
    assert.equal(notify.calls.length, 1);
  }
});

test('a marker with unusable shas refuses without any git call', async () => {
  const fs = memFs({ [MARKER]: JSON.stringify({ previous: 'x', target: NEW, deadline: 'd' }) });
  const run = fakeRun();
  const r = await restore(fs, run, notifier());
  assert.equal(r.action, 'refused');
  assert.deepEqual(run.calls, []);
});

test('a failing notifier never undoes the restore', async () => {
  const fs = armed();
  const r = await restore(fs, fakeRun(), notifier(true));
  assert.equal(r.action, 'restored');
  assert.equal(MARKER in fs.files, false);
});

test('a docs-only difference restores without a restart plan', async () => {
  const fs = armed();
  const r = await restore(fs, fakeRun({ paths: ['docs/x.md'] }), notifier());
  assert.equal(r.action, 'restored');
  assert.equal(r.restart, null);
  assert.equal(PENDING in fs.files, false);
});

test('the only reset this module runs is the one in restorePrevious, and it is never forced onto a dirty tree', () => {
  const source = nodeFs.readFileSync(path.join(__dirname, 'node-code-rollback.js'), 'utf8');
  assert.equal((source.match(/'reset'/g) || []).length, 1);
  assert.equal((source.match(/--force|clean'|checkout'|stash/g) || []).length, 0);
});

test('with a real git repo the checkout goes back to the previous sha and the bad sha is recorded', async () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'restore-real-'));
  const repo = path.join(dir, 'repo');
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, ...a], { encoding: 'utf8' });
  nodeFs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master', repo]);
  nodeFs.writeFileSync(path.join(repo, 'src', 'a.js'), '1\n');
  git('add', '-A'); git('commit', '-q', '-m', 'one');
  const first = git('rev-parse', 'HEAD').stdout.trim();
  nodeFs.writeFileSync(path.join(repo, 'src', 'a.js'), '2\n');
  git('add', '-A'); git('commit', '-q', '-m', 'two');
  const second = git('rev-parse', 'HEAD').stdout.trim();
  const pipe = path.join(dir, 'pipe');
  recordApply({ pipelineDir: pipe, previous: first, target: second, env: {}, now: T0 });
  const notify = notifier();
  const r = await restorePrevious({ repoDir: repo, pipelineDir: pipe, notify, now: T0 + MIN, env: {} });
  assert.equal(r.action, 'restored');
  assert.equal(git('rev-parse', 'HEAD').stdout.trim(), first);
  assert.equal(nodeFs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8'), '1\n');
  assert.equal(JSON.parse(nodeFs.readFileSync(path.join(pipe, 'instances', 'code-bad-sha.json'), 'utf8')).target, second);
  assert.equal(JSON.parse(nodeFs.readFileSync(path.join(pipe, 'instances', 'code-restart-pending.json'), 'utf8')).units, true);
  assert.equal(nodeFs.existsSync(path.join(pipe, 'instances', 'code-rollback.json')), false);
  assert.equal(notify.calls.length, 1);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});
