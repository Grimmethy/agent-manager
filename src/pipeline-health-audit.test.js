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
  countRecentCompletions, countPending, checkDaemonCounts, daemonRoots, checkOrphanedModelCalls, tailLogErrorSignatures,
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

test('countRecentCompletions throws (and logs), not a silent 0, on a real read error other than ENOENT', (t) => {
  // AC-57's sibling gap (2026-09-15): a bare `catch { return 0; }` made an unreadable
  // queue/done/ (permission denied, bad mount, disk I/O) look identical to "0 tasks
  // completed" -- exactly the THROUGHPUT_STALL signal checkPipelineHealth exists to
  // catch, silently masking a real problem instead of flagging it. Only ENOENT (a
  // pipeline that genuinely hasn't shipped anything yet) still returns 0.
  const dir = tempDir('health-audit-count-test-');
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  const err = new Error('permission denied');
  err.code = 'EACCES';
  t.mock.method(fs, 'readdirSync', () => { throw err; });

  assert.throws(() => countRecentCompletions(dir, new Date(), 60 * 60 * 1000), /permission denied/);
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

// 2026-09-18 (brain-dump bd-1789702787675 follow-up): bash forks a plain subshell during
// a daemon's own normal loop body (command substitution, a piped `while read`, ...) with
// no exec, so ps shows a SECOND process with the byte-identical cmdline, parented under
// the daemon's own long-lived pid -- not a genuine second instance. Confirmed live: every
// "N processes running simultaneously" finding this month was exactly this shape.

test('checkDaemonCounts does NOT flag a daemon whose "extra" match is its own subshell fork (real live shape)', () => {
  const findings = checkDaemonCounts([
    { pid: 3597394, ppid: 1560, cmd: 'bash scripts/local-worker.sh worker-1' }, // the real long-lived daemon
    { pid: 352957, ppid: 3597394, cmd: 'bash scripts/local-worker.sh worker-1' }, // its own subshell fork this tick
    { pid: 3597395, ppid: 1560, cmd: 'bash scripts/local-worker.sh worker-reasoning' },
    { pid: 3597399, ppid: 1560, cmd: 'bash scripts/queue-watcher.sh watchdog' },
    { pid: 3597398, ppid: 1560, cmd: 'bash scripts/review-runner.sh reviewer' },
  ]);
  assert.deepEqual(findings, []);
});

test('checkDaemonCounts still flags a REAL duplicate even with an unrelated subshell fork also present', () => {
  const findings = checkDaemonCounts([
    { pid: 100, ppid: 1, cmd: 'bash scripts/local-worker.sh worker-1' }, // first independent daemon
    { pid: 200, ppid: 1, cmd: 'bash scripts/local-worker.sh worker-1' }, // second independent daemon -- a genuine duplicate
    { pid: 201, ppid: 200, cmd: 'bash scripts/local-worker.sh worker-1' }, // the SECOND daemon's own subshell fork -- must not inflate the count further
    { pid: 3, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-reasoning' },
    { pid: 4, ppid: 0, cmd: 'bash scripts/queue-watcher.sh watchdog' },
    { pid: 5, ppid: 0, cmd: 'bash scripts/review-runner.sh reviewer' },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /worker-1: 2 processes/);
  assert.match(findings[0], /pids 100, 200/);
});

test('checkDaemonCounts collapses a chain of several nested subshell forks to one root', () => {
  const findings = checkDaemonCounts([
    { pid: 1, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-1' },
    { pid: 2, ppid: 1, cmd: 'bash scripts/local-worker.sh worker-1' },
    { pid: 3, ppid: 2, cmd: 'bash scripts/local-worker.sh worker-1' }, // nested two levels deep
    { pid: 4, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-reasoning' },
    { pid: 5, ppid: 0, cmd: 'bash scripts/queue-watcher.sh watchdog' },
    { pid: 6, ppid: 0, cmd: 'bash scripts/review-runner.sh reviewer' },
  ]);
  assert.deepEqual(findings, []);
});

// --- daemonRoots --------------------------------------------------------------------------

test('daemonRoots: a single match is trivially its own root (no ancestor walk needed)', () => {
  const ps = [{ pid: 1, ppid: 0, cmd: 'bash scripts/queue-watcher.sh watchdog' }];
  assert.deepEqual(daemonRoots(ps, /queue-watcher\.sh/), ps);
});

test('daemonRoots: zero matches returns an empty array', () => {
  assert.deepEqual(daemonRoots([{ pid: 1, ppid: 0, cmd: 'node something-else.js' }], /queue-watcher\.sh/), []);
});

// 2026-09-18: a hyphen is a non-word character, so a plain `\b` after "worker-reasoning"
// is satisfied at the "-p40" boundary just as it would be at a space -- worker-reasoning's
// pattern wrongly also matched a real, separate worker-reasoning-p40 daemon.

test('checkDaemonCounts does not confuse worker-reasoning with worker-reasoning-p40 (hyphen-suffix overlap)', () => {
  const findings = checkDaemonCounts([
    { pid: 1, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-1' },
    { pid: 2, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-reasoning-p40' },
    { pid: 3, ppid: 0, cmd: 'bash scripts/queue-watcher.sh watchdog' },
    { pid: 4, ppid: 0, cmd: 'bash scripts/review-runner.sh reviewer' },
  ]);
  const wrFinding = findings.find((f) => f.startsWith('worker-reasoning:'));
  assert.ok(wrFinding && wrFinding.includes('no process found'), 'worker-reasoning-p40 process must not count as satisfying worker-reasoning');
});

test('checkDaemonCounts still correctly recognizes a bare worker-reasoning process', () => {
  const findings = checkDaemonCounts([
    { pid: 1, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-1' },
    { pid: 2, ppid: 0, cmd: 'bash scripts/local-worker.sh worker-reasoning' },
    { pid: 3, ppid: 0, cmd: 'bash scripts/queue-watcher.sh watchdog' },
    { pid: 4, ppid: 0, cmd: 'bash scripts/review-runner.sh reviewer' },
  ]);
  assert.deepEqual(findings, []);
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
