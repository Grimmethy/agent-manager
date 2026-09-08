'use strict';

// Unit tests for fact-check-gate-audit.js -- the "close the loop" sweep for
// review-task.js's fact-check-audit.log (2026-09-08, Second Brain [[dspy]] research
// applied). See that file's own header for the full incident: this session found 4
// confirmed false positives against fact-checker.js's own "high-precision, almost never
// a false positive" claim, discovered only by manually joining every historical
// hard-block against its real eventual outcome by hand. This sweep automates that join.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { auditFactCheckPrecision, classifyOutcome, readAuditLines } = require('./fact-check-gate-audit.js');

function withPipelineDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-check-gate-audit-test-'));
  return fn(dir);
}

function writeTask(pipelineDir, relDir, id, data = {}) {
  const full = path.join(pipelineDir, 'queue', relDir);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, `${id}.json`), JSON.stringify({ id, ...data }));
}

function writeAuditLog(pipelineDir, entries) {
  const dir = path.join(pipelineDir, 'instances');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'fact-check-audit.log'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

test('readAuditLines returns [] when the log does not exist, without throwing', () => {
  withPipelineDir((dir) => {
    assert.deepEqual(readAuditLines(dir), []);
  });
});

test('readAuditLines skips a malformed line rather than failing the whole read', () => {
  withPipelineDir((dir) => {
    const logDir = path.join(dir, 'instances');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'fact-check-audit.log'), '{"taskId":"t1"}\nnot json\n{"taskId":"t2"}\n');
    const lines = readAuditLines(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].taskId, 't1');
    assert.equal(lines[1].taskId, 't2');
  });
});

test('classifyOutcome: laterSucceeded for merged/applied-direct/pending-merge/approved', () => {
  withPipelineDir((dir) => {
    writeTask(dir, 'done', 'merged-1', { terminalDisposition: 'merged' });
    writeTask(dir, 'done', 'applied-direct-1', { terminalDisposition: 'applied-direct' });
    writeTask(dir, 'done', 'pending-merge-1', { terminalDisposition: 'pending-merge' });
    writeTask(dir, 'done', 'approved-1', { status: 'approved' });
    assert.equal(classifyOutcome(dir, 'merged-1'), 'laterSucceeded');
    assert.equal(classifyOutcome(dir, 'applied-direct-1'), 'laterSucceeded');
    assert.equal(classifyOutcome(dir, 'pending-merge-1'), 'laterSucceeded');
    assert.equal(classifyOutcome(dir, 'approved-1'), 'laterSucceeded');
  });
});

test('classifyOutcome: presumedCorrect for abandoned/dismissed/noop', () => {
  withPipelineDir((dir) => {
    writeTask(dir, 'done', 'abandoned-1', { terminalDisposition: 'abandoned' });
    writeTask(dir, 'done', 'dismissed-1', { terminalDisposition: 'dismissed' });
    writeTask(dir, 'done', 'noop-1', { terminalDisposition: 'noop' });
    assert.equal(classifyOutcome(dir, 'abandoned-1'), 'presumedCorrect');
    assert.equal(classifyOutcome(dir, 'dismissed-1'), 'presumedCorrect');
    assert.equal(classifyOutcome(dir, 'noop-1'), 'presumedCorrect');
  });
});

test('classifyOutcome: stillStuck for a task still sitting blocked/needs-clarification', () => {
  withPipelineDir((dir) => {
    writeTask(dir, 'blocked', 'stuck-1', { status: 'blocked' });
    writeTask(dir, 'needs-clarification', 'stuck-2', { status: 'needs-clarification' });
    assert.equal(classifyOutcome(dir, 'stuck-1'), 'stillStuck');
    assert.equal(classifyOutcome(dir, 'stuck-2'), 'stillStuck');
  });
});

test('classifyOutcome: unknown when the task cannot be found anywhere', () => {
  withPipelineDir((dir) => {
    assert.equal(classifyOutcome(dir, 'never-existed'), 'unknown');
  });
});

// The real incident this sweep exists to automate: fact-checker.js flagged a genuine
// verification marker as fabricated, the task got manually requeued straight to review,
// and it merged cleanly once the underlying grounding gap was fixed. This is exactly the
// laterSucceeded shape a human auditing by hand (like this session did) would have to
// discover manually without this sweep.
test('auditFactCheckPrecision: a real echo-marker false positive that later merged tallies as laterSucceeded', () => {
  withPipelineDir((dir) => {
    writeAuditLog(dir, [
      { at: '2026-09-08T02:35:19.000Z', taskId: 'decompose-task-1', source: 'adhoc', flags: [{ type: 'ungrounded-field', detail: 'NEWFILE_SYNTAX_OK' }] },
    ]);
    writeTask(dir, 'done', 'decompose-task-1', { terminalDisposition: 'merged' });

    const summary = auditFactCheckPrecision(dir);
    assert.equal(summary.totalEvents, 1);
    assert.equal(summary.uniqueTasks, 1);
    assert.equal(summary.byType['ungrounded-field'].total, 1);
    assert.equal(summary.byType['ungrounded-field'].laterSucceeded, 1);
    assert.equal(summary.bySource.adhoc.laterSucceeded, 1);
  });
});

test('auditFactCheckPrecision: a genuinely abandoned fabrication tallies as presumedCorrect, not laterSucceeded', () => {
  withPipelineDir((dir) => {
    writeAuditLog(dir, [
      { at: '2026-09-08T00:00:00.000Z', taskId: 'real-fabrication-1', source: 'deep_dive', flags: [{ type: 'ungrounded-field', detail: 'MADE_UP_CONST' }] },
    ]);
    writeTask(dir, 'done', 'real-fabrication-1', { terminalDisposition: 'abandoned' });

    const summary = auditFactCheckPrecision(dir);
    assert.equal(summary.byType['ungrounded-field'].presumedCorrect, 1);
    assert.equal(summary.byType['ungrounded-field'].laterSucceeded, 0);
  });
});

test('auditFactCheckPrecision: the same task re-blocked across 2 retries counts as 2 events but 1 unique task', () => {
  withPipelineDir((dir) => {
    writeAuditLog(dir, [
      { at: '2026-09-08T02:35:19.000Z', taskId: 'retried-task-1', source: 'adhoc', flags: [{ type: 'ungrounded-field', detail: 'MARKER_A' }] },
      { at: '2026-09-08T03:02:48.000Z', taskId: 'retried-task-1', source: 'adhoc', flags: [{ type: 'ungrounded-field', detail: 'MARKER_B' }] },
    ]);
    writeTask(dir, 'done', 'retried-task-1', { terminalDisposition: 'merged' });

    const summary = auditFactCheckPrecision(dir);
    assert.equal(summary.totalEvents, 2);
    assert.equal(summary.uniqueTasks, 1);
    assert.equal(summary.byType['ungrounded-field'].total, 2);
    assert.equal(summary.byType['ungrounded-field'].laterSucceeded, 2);
  });
});

test('auditFactCheckPrecision: a task no longer findable anywhere counts as unknown, not a throw', () => {
  withPipelineDir((dir) => {
    writeAuditLog(dir, [
      { at: '2026-09-08T00:00:00.000Z', taskId: 'long-gone-1', source: 'manual', flags: [{ type: 'ungrounded-url', detail: 'https://fake.example.test' }] },
    ]);
    const summary = auditFactCheckPrecision(dir);
    assert.equal(summary.byType['ungrounded-url'].unknown, 1);
  });
});

test('auditFactCheckPrecision: breaks out separate tallies per flag type', () => {
  withPipelineDir((dir) => {
    writeAuditLog(dir, [
      { at: '2026-09-08T00:00:00.000Z', taskId: 'field-task', source: 'manual', flags: [{ type: 'ungrounded-field', detail: 'X' }] },
      { at: '2026-09-08T00:01:00.000Z', taskId: 'url-task', source: 'manual', flags: [{ type: 'ungrounded-url', detail: 'https://x.test' }] },
    ]);
    writeTask(dir, 'done', 'field-task', { terminalDisposition: 'merged' });
    writeTask(dir, 'done', 'url-task', { terminalDisposition: 'abandoned' });

    const summary = auditFactCheckPrecision(dir);
    assert.equal(summary.byType['ungrounded-field'].laterSucceeded, 1);
    assert.equal(summary.byType['ungrounded-url'].presumedCorrect, 1);
  });
});

test('auditFactCheckPrecision: an empty/missing log returns an all-zero summary, not a throw', () => {
  withPipelineDir((dir) => {
    const summary = auditFactCheckPrecision(dir);
    assert.equal(summary.totalEvents, 0);
    assert.equal(summary.uniqueTasks, 0);
    assert.deepEqual(summary.byType, {});
    assert.deepEqual(summary.bySource, {});
  });
});
