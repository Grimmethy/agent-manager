'use strict';

// Unit tests for pipeline-health-audit.js -- see its own header for the real incident
// this automates (a session-long manual investigation that found a structurally-broken
// model profile silently failing every draft of one task type, a masked bash syntax
// error, and orphaned processes holding the GPU lock -- none visible from queue counts
// alone).
//
// Run: node --test src/pipeline-health-audit.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkPipelineHealth, isDue, markChecked,
  countRecentCompletions, countPending, checkDaemonCounts, checkOrphanedModelCalls, tailLogErrorSignatures,
} = require('./pipeline-health-audit.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeDoneTask(doneDir, id, mtime) {
  fs.mkdirSync(doneDir, { recursive: true });
  const p = path.join(doneDir, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify({ id }));
  if (mtime) fs.utimesSync(p, mtime, mtime);
}

function writePendingTask(pendingDir, id) {
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, `${id}.json`), JSON.stringify({ id }));
}

// --- isDue / markChecked -----------------------------------------------------------------

test('isDue is true when the schedule file has never been written', () => {
  const dir = tempDir('health-audit-due-test-');
  assert.equal(isDue(dir), true);
});

test('isDue is false immediately after markChecked, true again once the interval has elapsed', () => {
  const dir = tempDir('health-audit-due-test-');
  const now = new Date('2026-08-24T12:00:00.000Z');
  markChecked(dir, now);
  assert.equal(isDue(dir, new Date('2026-08-24T12:30:00.000Z')), false, 'only 30 minutes elapsed -- not due yet');
  assert.equal(isDue(dir, new Date('2026-08-24T13:00:01.000Z')), true, 'a full hour elapsed -- due again');
});

// --- countRecentCompletions / countPending -----------------------------------------------

test('countRecentCompletions only counts done/ files modified within the window', () => {
  const dir = tempDir('health-audit-count-test-');
  const doneDir = path.join(dir, 'queue', 'done');
  const now = new Date('2026-08-24T12:00:00.000Z');
  writeDoneTask(doneDir, 'recent-1', new Date('2026-08-24T11:30:00.000Z'));
  writeDoneTask(doneDir, 'recent-2', new Date('2026-08-24T11:59:00.000Z'));
  writeDoneTask(doneDir, 'old-1', new Date('2026-08-24T10:00:00.000Z'));

  assert.equal(countRecentCompletions(dir, now, 60 * 60 * 1000), 2);
});

test('countRecentCompletions returns 0, not a throw, when queue/done/ does not exist', () => {
  const dir = tempDir('health-audit-count-test-');
  assert.equal(countRecentCompletions(dir, new Date(), 60 * 60 * 1000), 0);
});

test('countPending counts real pending/ files, 0 when the dir is absent', () => {
  const dir = tempDir('health-audit-count-test-');
  assert.equal(countPending(dir), 0);
  writePendingTask(path.join(dir, 'queue', 'pending'), 'a');
  writePendingTask(path.join(dir, 'queue', 'pending'), 'b');
  assert.equal(countPending(dir), 2);
});

// --- checkDaemonCounts --------------------------------------------------------------------

test('checkDaemonCounts flags a missing daemon', () => {
  const findings = checkDaemonCounts([
    { pid: 1, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-reasoning' },
  ]);
  assert.ok(findings.some((f) => f.includes('worker-1') && f.includes('no process found')));
});

test('checkDaemonCounts flags a duplicated daemon', () => {
  const findings = checkDaemonCounts([
    { pid: 1, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-1' },
    { pid: 2, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-1' },
    { pid: 3, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-reasoning' },
    { pid: 4, ppid: 0, cmd: 'bash scripts/queue-watcher.sh watchdog' },
    { pid: 5, ppid: 0, cmd: 'bash scripts/review-runner.sh reviewer' },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /worker-1.*2 processes/);
});

test('checkDaemonCounts finds nothing wrong when every daemon has exactly one process', () => {
  const findings = checkDaemonCounts([
    { pid: 1, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-1' },
    { pid: 2, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-reasoning' },
    { pid: 3, ppid: 0, cmd: 'bash scripts/queue-watcher.sh watchdog' },
    { pid: 4, ppid: 0, cmd: 'bash scripts/review-runner.sh reviewer' },
  ]);
  assert.deepEqual(findings, []);
});

test('checkDaemonCounts does not confuse worker-1 with worker-reasoning (substring overlap)', () => {
  const findings = checkDaemonCounts([
    { pid: 1, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-reasoning' },
  ]);
  const worker1Finding = findings.find((f) => f.startsWith('worker-1:'));
  assert.ok(worker1Finding && worker1Finding.includes('no process found'), 'worker-reasoning process must not count as satisfying worker-1');
});

// --- checkOrphanedModelCalls ---------------------------------------------------------------

test('checkOrphanedModelCalls finds a local-draft.js process reparented to pid 1', () => {
  const orphans = checkOrphanedModelCalls([
    { pid: 100, ppid: 1, cmd: 'node src/local-draft.js queue/drafting/worker-1/x.json' },
    { pid: 200, ppid: 555, cmd: 'node src/local-draft.js queue/drafting/worker-reasoning/y.json' },
  ]);
  assert.deepEqual(orphans.map((o) => o.pid), [100]);
});

// --- tailLogErrorSignatures ----------------------------------------------------------------

test('tailLogErrorSignatures finds a known bad signature in a recent log line', () => {
  const dir = tempDir('health-audit-logs-test-');
  fs.writeFileSync(path.join(dir, 'worker-1.log'), 'some normal line\n[[: operand expected\nanother normal line\n');
  const findings = tailLogErrorSignatures(dir);
  assert.ok(findings.some((f) => f.includes('worker-1.log') && f.includes('ansi-color-broke-numeric-test')));
});

test('tailLogErrorSignatures finds nothing in a clean log', () => {
  const dir = tempDir('health-audit-logs-test-');
  fs.writeFileSync(path.join(dir, 'worker-1.log'), 'tick at 2026-08-24\nclaiming some-task\nclaimed successfully\n');
  assert.deepEqual(tailLogErrorSignatures(dir), []);
});

test('tailLogErrorSignatures does not throw when the log dir does not exist -- it reports the unreadable dir as a finding', () => {
  // An observability fix (2026-09) changed this from a silent empty array to a single
  // diagnostic finding so an operator sees WHY the log scan produced nothing.
  const out = tailLogErrorSignatures('/nonexistent/path/xyz');
  assert.equal(out.length, 1);
  assert.match(out[0], /unreadable/);
});

// --- checkPipelineHealth (integration) ------------------------------------------------------

test('checkPipelineHealth reports the throughput-stall anomaly when real backlog exists but nothing completed', () => {
  const dir = tempDir('health-audit-integration-test-');
  const now = new Date('2026-08-24T12:00:00.000Z');
  for (let i = 0; i < 10; i++) writePendingTask(path.join(dir, 'queue', 'pending'), `p-${i}`);
  // Only OLD completions -- outside the window.
  writeDoneTask(path.join(dir, 'queue', 'done'), 'old', new Date('2026-08-24T08:00:00.000Z'));

  const result = checkPipelineHealth({ pipelineDir: dir, instancesDir: dir, logDir: dir, now, listProcessesFn: () => [] });

  assert.ok(result.anomalies.some((a) => a.includes('throughput has stalled')));
  assert.equal(result.evidence.recentCompletions, 0);
  assert.equal(result.evidence.pending, 10);
});

test('checkPipelineHealth does NOT flag a quiet-but-empty pipeline (no pending work, daemons genuinely idle) as a throughput stall', () => {
  const dir = tempDir('health-audit-integration-test-');
  const ps = [
    { pid: 1, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-1' },
    { pid: 2, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-reasoning' },
    { pid: 3, ppid: 0, cmd: 'bash scripts/queue-watcher.sh watchdog' },
    { pid: 4, ppid: 0, cmd: 'bash scripts/review-runner.sh reviewer' },
  ];
  const result = checkPipelineHealth({ pipelineDir: dir, instancesDir: dir, logDir: dir, now: new Date(), listProcessesFn: () => ps });
  assert.deepEqual(result.anomalies, [], 'zero pending, zero completions is a healthy idle state, not an anomaly, as long as the daemons themselves are actually there');
});

test('checkPipelineHealth returns zero anomalies for a fully healthy snapshot', () => {
  const dir = tempDir('health-audit-integration-test-');
  const now = new Date('2026-08-24T12:00:00.000Z');
  writeDoneTask(path.join(dir, 'queue', 'done'), 'recent', new Date('2026-08-24T11:45:00.000Z'));
  const ps = [
    { pid: 1, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-1' },
    { pid: 2, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-reasoning' },
    { pid: 3, ppid: 0, cmd: 'bash scripts/queue-watcher.sh watchdog' },
    { pid: 4, ppid: 0, cmd: 'bash scripts/review-runner.sh reviewer' },
  ];
  const result = checkPipelineHealth({ pipelineDir: dir, instancesDir: dir, logDir: dir, now, listProcessesFn: () => ps });
  assert.deepEqual(result.anomalies, []);
});

test('checkPipelineHealth never throws when listProcessesFn itself fails (ps unavailable)', () => {
  const dir = tempDir('health-audit-integration-test-');
  const listProcessesFn = () => { throw new Error('ps: command not found'); };
  assert.doesNotThrow(() => checkPipelineHealth({ pipelineDir: dir, instancesDir: dir, logDir: dir, now: new Date(), listProcessesFn }));
});
