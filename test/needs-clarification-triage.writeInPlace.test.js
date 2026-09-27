'use strict';

// writeInPlace regression tests (HUB0038 · 2/2).
// Contract under test (verified against src/needs-clarification-triage.js):
//   writeInPlace(file, task, summary?) is module-scoped and exported, and its
//   existsSync guard is the FIRST executable statement:
//     - file exists  -> it is overwritten in place with the (mutated) task object;
//     - file missing -> it is NOT re-created. A concurrent /done delete (or a prior
//       bucket's unlink of the same file) can remove the file between the sweep's
//       readdirSync and this write -- writing it back would resurrect a task that
//       was just intentionally deleted.
// The test drives the REAL exported function (no mock/re-implementation of the
// guard) against an isolated workspace under os.tmpdir() that mirrors the
// production layout queue/needs-clarification/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeInPlace } = require('../src/needs-clarification-triage.js');

// writeInPlace re-reads DRY_RUN via cfgEnv() per call; make sure it is off so the
// happy path really writes.
delete process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wip-guard-'));
const queueDir = path.join(tmpRoot, 'queue', 'needs-clarification');
fs.mkdirSync(queueDir, { recursive: true });

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('writeInPlace overwrites an existing file with the mutated task', () => {
  const taskPath = path.join(queueDir, 'task-001.json');
  const original = { id: 'task-001', status: 'open', notes: 'first' };
  fs.writeFileSync(taskPath, JSON.stringify(original, null, 2));

  const mutated = { ...original, status: 'triaged', notes: 'updated' };
  writeInPlace(taskPath, mutated);

  assert.ok(fs.existsSync(taskPath), 'file must still exist after writeInPlace');
  const parsed = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  assert.equal(parsed.status, 'triaged');
  assert.equal(parsed.notes, 'updated');
  assert.equal(parsed.id, 'task-001');
});

test('writeInPlace does NOT re-create a missing file', () => {
  const taskPath = path.join(queueDir, 'task-002.json');
  const task = { id: 'task-002', status: 'open', notes: 'first' };
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  assert.ok(fs.existsSync(taskPath), 'precondition: file existed before unlink');

  // Simulate the concurrent /done delete that races the sweep.
  fs.unlinkSync(taskPath);
  assert.ok(!fs.existsSync(taskPath), 'precondition: file is gone after unlink');

  const mutated = { ...task, status: 'triaged', notes: 'updated' };
  writeInPlace(taskPath, mutated);

  assert.ok(!fs.existsSync(taskPath), 'writeInPlace must not re-create a deleted file');
});
