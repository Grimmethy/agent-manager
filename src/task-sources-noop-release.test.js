const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDependencySatisfied, isEmptyImplementedNoop } = require('./task-sources.js');

function makePipelineDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noop-release-'));
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  return dir;
}

function writeDone(dir, id, record) {
  fs.writeFileSync(path.join(dir, 'queue', 'done', `${id}.json`), JSON.stringify({ id, ...record }));
}

test('stuck empty implemented noop does not release dependents', () => {
  const dir = makePipelineDir();
  const id = 'HUB-NOOP-RELEASE-STUCK';
  const record = { terminalDisposition: 'noop', adhocResolution: 'implemented', branch: null, mergedAt: null, rawDiff: '' };
  writeDone(dir, id, record);
  assert.strictEqual(isEmptyImplementedNoop(record), true);
  assert.strictEqual(isDependencySatisfied(dir, id), false);
});

test('done record with mergedAt releases dependents', () => {
  const dir = makePipelineDir();
  const id = 'HUB-NOOP-RELEASE-MERGED';
  const record = { terminalDisposition: 'merged', adhocResolution: 'implemented', branch: 'agent/x', mergedAt: '2026-11-01T00:00:00.000Z', rawDiff: '' };
  writeDone(dir, id, record);
  assert.strictEqual(isEmptyImplementedNoop(record), false);
  assert.strictEqual(isDependencySatisfied(dir, id), true);
});

test('no-changes-needed noop still releases dependents', () => {
  const dir = makePipelineDir();
  const id = 'HUB-NOOP-RELEASE-NOCHANGE';
  const record = { terminalDisposition: 'noop', adhocResolution: 'no-changes-needed', branch: null, mergedAt: null, rawDiff: '' };
  writeDone(dir, id, record);
  assert.strictEqual(isEmptyImplementedNoop(record), false);
  assert.strictEqual(isDependencySatisfied(dir, id), true);
});
