'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ollamaHangCheck } = require('./ollama-hang-check.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-hang-check-test-'));
}

function paths(dir) {
  return { suspectPath: path.join(dir, '.ollama-watchdog-suspect.json'), cooldownPath: path.join(dir, '.ollama-watchdog-cooldown.json') };
}

function holdingTicket(overrides = {}) {
  return { holding: true, pid: 12345, taskId: 'brain-dump-sort-bd-1', model: 'qwen2.5:3b', startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), ...overrides };
}

test('no holding ticket at all -> no action, no suspect state written', () => {
  const dir = tempDir();
  const action = ollamaHangCheck({
    instancesDir: dir, ...paths(dir),
    readTickets: () => [{ holding: false, pid: 1, taskId: 'x', startedAt: new Date().toISOString() }],
    readGpuUtil: () => 0,
  });
  assert.equal(action, null);
  assert.equal(fs.existsSync(paths(dir).suspectPath), false);
});

test('a freshly-held ticket (younger than the hang threshold) is not suspicious yet', () => {
  const dir = tempDir();
  const action = ollamaHangCheck({
    instancesDir: dir, ...paths(dir),
    readTickets: () => [holdingTicket({ startedAt: new Date().toISOString() })],
    readGpuUtil: () => 0,
  });
  assert.equal(action, null);
});

test('an old held ticket with the GPU busy is a real long call, not a hang', () => {
  const dir = tempDir();
  const action = ollamaHangCheck({
    instancesDir: dir, ...paths(dir),
    readTickets: () => [holdingTicket()],
    readGpuUtil: () => 87,
  });
  assert.equal(action, null);
});

test('nvidia-smi unavailable -> refuses to act even with an old held ticket', () => {
  const dir = tempDir();
  const action = ollamaHangCheck({
    instancesDir: dir, ...paths(dir),
    readTickets: () => [holdingTicket()],
    readGpuUtil: () => null,
  });
  assert.equal(action, null);
});

test('first sighting of an old+idle ticket only records a suspect, does not act yet', () => {
  const dir = tempDir();
  const ticket = holdingTicket();
  const action = ollamaHangCheck({
    instancesDir: dir, ...paths(dir),
    readTickets: () => [ticket],
    readGpuUtil: () => 0,
  });
  assert.equal(action, null);
  const suspect = JSON.parse(fs.readFileSync(paths(dir).suspectPath, 'utf8'));
  assert.equal(suspect.key, `12345:brain-dump-sort-bd-1:${ticket.startedAt}`);
});

test('the SAME suspicious ticket confirmed on a second tick past the confirm window triggers a restart action', () => {
  const dir = tempDir();
  const ticket = holdingTicket();
  const t0 = Date.now();
  const first = ollamaHangCheck({
    instancesDir: dir, ...paths(dir), now: t0,
    readTickets: () => [ticket],
    readGpuUtil: () => 0,
  });
  assert.equal(first, null);

  const second = ollamaHangCheck({
    instancesDir: dir, ...paths(dir), now: t0 + 91 * 1000, confirmWindowMs: 90 * 1000,
    readTickets: () => [ticket],
    readGpuUtil: () => 0,
  });
  assert.equal(second.action, 'restart-ollama');
  assert.match(second.reason, /wedged/);
  assert.equal(second.evidence.holderPid, 12345);

  // Cooldown is now recorded -- an immediate third tick with the same conditions must not fire again.
  const third = ollamaHangCheck({
    instancesDir: dir, ...paths(dir), now: t0 + 92 * 1000,
    readTickets: () => [ticket],
    readGpuUtil: () => 0,
  });
  assert.equal(third, null);
});

test('a suspicious ticket seen again before the confirm window elapses does not fire early', () => {
  const dir = tempDir();
  const ticket = holdingTicket();
  const t0 = Date.now();
  ollamaHangCheck({ instancesDir: dir, ...paths(dir), now: t0, readTickets: () => [ticket], readGpuUtil: () => 0 });

  const stillWaiting = ollamaHangCheck({
    instancesDir: dir, ...paths(dir), now: t0 + 30 * 1000, confirmWindowMs: 90 * 1000,
    readTickets: () => [ticket],
    readGpuUtil: () => 0,
  });
  assert.equal(stillWaiting, null);
});

test('the holder changing between ticks (real progress) resets suspicion instead of accumulating toward a restart', () => {
  const dir = tempDir();
  const t0 = Date.now();
  const first = holdingTicket({ pid: 111, taskId: 'task-a' });
  ollamaHangCheck({ instancesDir: dir, ...paths(dir), now: t0, readTickets: () => [first], readGpuUtil: () => 0 });

  const second = holdingTicket({ pid: 222, taskId: 'task-b' });
  const result = ollamaHangCheck({
    instancesDir: dir, ...paths(dir), now: t0 + 91 * 1000, confirmWindowMs: 90 * 1000,
    readTickets: () => [second],
    readGpuUtil: () => 0,
  });
  // A different holder is a fresh sighting, not a confirmation of the first -- must wait again.
  assert.equal(result, null);
});

test('GPU turning busy between the two ticks clears suspicion (no restart)', () => {
  const dir = tempDir();
  const ticket = holdingTicket();
  const t0 = Date.now();
  ollamaHangCheck({ instancesDir: dir, ...paths(dir), now: t0, readTickets: () => [ticket], readGpuUtil: () => 0 });

  const result = ollamaHangCheck({
    instancesDir: dir, ...paths(dir), now: t0 + 91 * 1000, confirmWindowMs: 90 * 1000,
    readTickets: () => [ticket],
    readGpuUtil: () => 40,
  });
  assert.equal(result, null);
  assert.equal(fs.existsSync(paths(dir).suspectPath), false);
});

test('restart cooldown blocks a second restart even for a brand-new stuck ticket', () => {
  const dir = tempDir();
  const t0 = Date.now();
  fs.writeFileSync(paths(dir).cooldownPath, JSON.stringify({ lastRestartAt: t0 - 60 * 1000 }));

  const action = ollamaHangCheck({
    instancesDir: dir, ...paths(dir), now: t0, restartCooldownMs: 10 * 60 * 1000,
    readTickets: () => [holdingTicket()],
    readGpuUtil: () => 0,
  });
  assert.equal(action, null);
});

test('readTickets throwing is treated as a benign no-op, not a crash', () => {
  const dir = tempDir();
  const action = ollamaHangCheck({
    instancesDir: dir, ...paths(dir),
    readTickets: () => { throw new Error('instances dir gone'); },
    readGpuUtil: () => 0,
  });
  assert.equal(action, null);
});
