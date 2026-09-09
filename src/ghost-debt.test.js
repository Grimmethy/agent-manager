'use strict';

// Unit tests for ghost-debt.js -- the register that records "this failure class has no
// deterministic recovery" as a side-finding tagged to concept-ghost-in-the-machine-0dbeea,
// deduped by failure signature.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fileGhostDebt, statePath } = require('./ghost-debt.js');

function freshPipelineDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-debt-test-'));
  fs.mkdirSync(path.join(d, 'queue'), { recursive: true });
  return d;
}
function inboxFiles(dir) {
  try { return fs.readdirSync(path.join(dir, 'queue', 'side-findings-inbox')); } catch { return []; }
}

test('files one side-finding tagged to the ghost concept, with stage "ghost-debt"', () => {
  const dir = freshPipelineDir();
  const r = fileGhostDebt({
    task: { id: 't1', blockedReason: 'BLOCKER-TYPE: infra-error the git index was locked' },
    reasonText: 'BLOCKER-TYPE: infra-error the git index was locked',
    site: 'reject-retry-check:retry-cap-exhausted',
    pipelineDir: dir,
  });
  assert.equal(r.filed, true);
  assert.ok(r.signature);
  const files = inboxFiles(dir);
  assert.equal(files.length, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'side-findings-inbox', files[0]), 'utf8'));
  assert.equal(rec.conceptId, 'concept-ghost-in-the-machine-0dbeea');
  assert.equal(rec.stage, 'ghost-debt');
  assert.equal(rec.taskId, 't1');
  assert.match(rec.title, /Ghost debt/);
  // state file records the signature -> lastFiledAt
  const state = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  assert.ok(state[r.signature]);
});

test('a second task with the same normalized failure signature is deduped, not refiled', () => {
  const dir = freshPipelineDir();
  const a = fileGhostDebt({
    task: { id: 'a', blockedReason: 'BLOCKER-TYPE: infra-error failed at line 42 on 2026-09-09T00:00:00Z' },
    reasonText: 'BLOCKER-TYPE: infra-error failed at line 42 on 2026-09-09T00:00:00Z',
    site: 's', pipelineDir: dir,
  });
  const b = fileGhostDebt({
    task: { id: 'b', blockedReason: 'BLOCKER-TYPE: infra-error failed at line 999 on 2026-09-10T11:11:11Z' },
    reasonText: 'BLOCKER-TYPE: infra-error failed at line 999 on 2026-09-10T11:11:11Z',
    site: 's', pipelineDir: dir,
  });
  assert.equal(a.filed, true);
  assert.equal(b.filed, false);
  assert.equal(b.deduped, 'signature');
  assert.equal(a.signature, b.signature, 'line numbers + timestamps normalized out of the signature');
  assert.equal(inboxFiles(dir).length, 1);
});

test('the same signature IS refiled once the refile window has passed', () => {
  const dir = freshPipelineDir();
  const task = { id: 't', blockedReason: 'some unclassified stuck reason' };
  const first = fileGhostDebt({ task, reasonText: task.blockedReason, site: 's', pipelineDir: dir, now: 0 });
  assert.equal(first.filed, true);
  const soon = fileGhostDebt({ task, reasonText: task.blockedReason, site: 's', pipelineDir: dir, now: 3 * 24 * 3600_000 });
  assert.equal(soon.filed, false);
  const later = fileGhostDebt({ task, reasonText: task.blockedReason, site: 's', pipelineDir: dir, now: 8 * 24 * 3600_000 });
  assert.equal(later.filed, true);
  assert.equal(inboxFiles(dir).length, 2);
});

test('never throws / returns {filed:false} for a missing pipelineDir or task id', () => {
  assert.deepEqual(fileGhostDebt({ task: { id: 'x' }, reasonText: 'r', site: 's' }), { filed: false });
  assert.deepEqual(fileGhostDebt({ task: {}, reasonText: 'r', site: 's', pipelineDir: '/tmp' }), { filed: false });
});
