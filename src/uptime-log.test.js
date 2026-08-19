'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendSample, pruneOldSamples, readSamplesInWindow, logPath } = require('./uptime-log.js');

function tempInstancesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-log-test-'));
}

function writeHeartbeat(dir, instanceId, overrides = {}) {
  fs.writeFileSync(path.join(dir, `${instanceId}.json`), JSON.stringify({
    instanceId, pid: process.pid, status: 'idle', lastHeartbeat: new Date().toISOString(), ...overrides,
  }));
}

test('appendSample records every non-dotfile instance heartbeat', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1');
  writeHeartbeat(dir, 'reviewer');
  fs.writeFileSync(path.join(dir, '.active-local-model.json'), JSON.stringify({ instanceId: 'worker-1', model: 'x' }));

  appendSample(dir, new Date('2026-08-19T10:00:00.000Z'));
  const lines = fs.readFileSync(logPath(dir), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const sample = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(sample.instances).sort(), ['reviewer', 'worker-1']);
});

test('appendSample marks a worker stale once its pid is gone, using the worker zombie threshold', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1', { pid: 999999, lastHeartbeat: new Date('2026-08-19T09:00:00.000Z').toISOString() });
  appendSample(dir, new Date('2026-08-19T10:00:00.000Z'));
  const sample = JSON.parse(fs.readFileSync(logPath(dir), 'utf8').trim());
  assert.equal(sample.instances['worker-1'].stale, true);
});

test('appendSample does NOT flag a worker stale for a gap under the zombie threshold, even with a dead pid check skipped by a live pid', () => {
  const dir = tempInstancesDir();
  // 10 minutes old (600s) is stale for a non-worker (300s threshold) but NOT for a worker (1200s threshold).
  writeHeartbeat(dir, 'worker-1', { pid: process.pid, lastHeartbeat: new Date('2026-08-19T09:50:00.000Z').toISOString() });
  appendSample(dir, new Date('2026-08-19T10:00:00.000Z'));
  const sample = JSON.parse(fs.readFileSync(logPath(dir), 'utf8').trim());
  assert.equal(sample.instances['worker-1'].stale, false);
});

test('readSamplesInWindow returns samples inside the window plus the one immediately before it', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1');
  appendSample(dir, new Date('2026-08-19T08:00:00.000Z'));
  appendSample(dir, new Date('2026-08-19T10:30:00.000Z'));
  appendSample(dir, new Date('2026-08-19T11:30:00.000Z'));
  appendSample(dir, new Date('2026-08-19T13:00:00.000Z'));

  const samples = readSamplesInWindow(dir, '2026-08-19T10:00:00.000Z', '2026-08-19T12:00:00.000Z');
  const timestamps = samples.map((s) => s.at);
  assert.deepEqual(timestamps, [
    '2026-08-19T08:00:00.000Z', // the one before the window, included so a pre-existing gap is still visible
    '2026-08-19T10:30:00.000Z',
    '2026-08-19T11:30:00.000Z',
  ]);
});

test('pruneOldSamples drops samples older than the retention window and keeps the rest', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1');
  appendSample(dir, new Date('2026-01-01T00:00:00.000Z')); // very old
  appendSample(dir, new Date('2026-08-19T10:00:00.000Z')); // recent

  pruneOldSamples(dir, new Date('2026-08-19T10:00:00.000Z'));
  const lines = fs.readFileSync(logPath(dir), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).at, '2026-08-19T10:00:00.000Z');
});

test('readSamplesInWindow on a missing log file returns an empty array, not a throw', () => {
  const dir = tempInstancesDir();
  assert.deepEqual(readSamplesInWindow(dir, '2026-08-19T00:00:00.000Z', '2026-08-19T01:00:00.000Z'), []);
});
