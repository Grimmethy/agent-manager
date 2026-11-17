'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordApply, markRestartDone, judge, markerPath, DEFAULT_MINUTES } = require('./node-code-rollback.js');

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
