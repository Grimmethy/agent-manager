'use strict';

// Unit tests for mem-guard.js -- injected fakes for /proc/meminfo and the ComfyUI call,
// same pattern as gpu-guard.test.js: deterministic, no dependency on this box's real RAM.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureRamHeadroom, assessMemory, parseMeminfo } = require('./mem-guard.js');

const mem = (availableMb, swapFreeMb = 6000, swapTotalMb = 6144) => ({ availableMb, swapFreeMb, swapTotalMb });

test('parseMeminfo reads MemAvailable and swap in MB', () => {
  const text = 'MemTotal:       20400000 kB\nMemAvailable:    4096000 kB\nSwapTotal:       6291448 kB\nSwapFree:         524288 kB\n';
  assert.deepEqual(parseMeminfo(text), { availableMb: 4000, swapFreeMb: 512, swapTotalMb: 6143 });
});

test('parseMeminfo returns null when MemAvailable is missing', () => {
  assert.equal(parseMeminfo('MemTotal: 1 kB\n'), null);
});

test('assessMemory: plenty of RAM is not pressure', () => {
  assert.equal(assessMemory(mem(8000)).pressure, false);
});

test('assessMemory: available RAM under the floor is pressure', () => {
  assert.equal(assessMemory(mem(900)).pressure, true);
});

test('assessMemory: swap exhausted with modest RAM is pressure (the 2026-10-12 freeze state)', () => {
  assert.equal(assessMemory(mem(3000, 0)).pressure, true);
});

test('assessMemory: swap exhausted but RAM plentiful is not pressure', () => {
  assert.equal(assessMemory(mem(9000, 0)).pressure, false);
});

test('assessMemory: no swap configured is judged on RAM alone', () => {
  assert.equal(assessMemory(mem(3000, 0, 0)).pressure, false);
});

test('ok: no ComfyUI call when memory is fine', async () => {
  let called = false;
  const r = await ensureRamHeadroom({ readMem: () => mem(8000), fetchJsonFn: async () => { called = true; return { ok: true }; } });
  assert.equal(r.pressure, false);
  assert.equal(called, false);
});

test('pressure recovered by ComfyUI /free: not reported as pressure', async () => {
  const reads = [mem(800), mem(5000)];
  const r = await ensureRamHeadroom({
    readMem: () => reads.shift(), fetchJsonFn: async () => ({ ok: true }), sleep: async () => {},
  });
  assert.equal(r.pressure, false);
  assert.deepEqual(r.freed, ['comfyui']);
  assert.match(r.note, /recovered/);
});

test('pressure with ComfyUI unreachable: still pressure, does not throw', async () => {
  const r = await ensureRamHeadroom({
    readMem: () => mem(800), fetchJsonFn: async () => ({ ok: false, error: 'connection refused' }), sleep: async () => {},
  });
  assert.equal(r.pressure, true);
  assert.deepEqual(r.freed, []);
});

test('pressure that /free does not fix is reported as pressure', async () => {
  const r = await ensureRamHeadroom({
    readMem: () => mem(800), fetchJsonFn: async () => ({ ok: true }), sleep: async () => {},
  });
  assert.equal(r.pressure, true);
  assert.deepEqual(r.freed, ['comfyui']);
});

test('meminfo unavailable: not checked, not pressure (fail open)', async () => {
  const r = await ensureRamHeadroom({ readMem: () => null });
  assert.equal(r.checked, false);
  assert.equal(r.pressure, false);
});

// ---- the two real incidents, so this guard and the gpu-broker's classifier (server/core/mem_pressure.py, tests/test_mem_pressure.py) agree --------
// 2026-11-01: MemAvailable 274 MB, swap 0 MB free of 6143. Both implementations call it pressure/critical.
// 2026-10-12: swap 0 kB free with RAM still modest (about 3 GB). Both call it pressure (the swap rule is the BACKSTOP here and in the classifier).
// A healthy box (6.5 GB available, 3.1 GB swap free of 6 GB): neither calls it pressure.
// Where they intentionally differ: this guard only reads meminfo; a disk-stall-only incident (plenty of RAM, io full 57) is seen by the classifier
// through kernel pressure stall information, which is why lanes now read the broker's marker first and run this guard only as the fallback.
test('incident 2026-11-01 (274 MB available, no swap free) is pressure', () => {
  const r = assessMemory(mem(274, 0, 6143));
  assert.equal(r.pressure, true);
  assert.match(r.note, /only 274MB RAM available/);
});

test('incident 2026-10-12 (swap exhausted, RAM about 3 GB) is pressure by the swap backstop', () => {
  const r = assessMemory(mem(3000, 0, 6144));
  assert.equal(r.pressure, true);
  assert.match(r.note, /swap nearly exhausted/);
});

test('a healthy box (6.5 GB available, 3.1 GB swap free of 6 GB) is not pressure', () => {
  assert.equal(assessMemory(mem(6506, 3177, 6143)).pressure, false);
});

test('the boundaries the classifier shares: 2048 MB available is fine, 2047 is pressure; swap 128 MB free with modest RAM follows the configured floor', () => {
  assert.equal(assessMemory(mem(2048, 6000)).pressure, false);
  assert.equal(assessMemory(mem(2047, 6000)).pressure, true);
  assert.equal(assessMemory(mem(3000, 127), { minSwapFreeMb: 128 }).pressure, true);
  assert.equal(assessMemory(mem(3000, 128), { minSwapFreeMb: 128 }).pressure, false);
  assert.equal(assessMemory(mem(4096, 127), { minSwapFreeMb: 128 }).pressure, false);     // RAM at twice the floor: the swap rule no longer applies
});

test('a disk-stall-only incident (plenty of RAM) is invisible to this guard, which is why the marker is read first', () => {
  assert.equal(assessMemory(mem(6000, 3000)).pressure, false);
});
