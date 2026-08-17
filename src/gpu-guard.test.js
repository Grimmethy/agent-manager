'use strict';

// Unit tests for gpu-guard.js's ensureGpuHeadroom() -- uses injected fakes for both
// readFreeVram (real one shells out to nvidia-smi) and fetchJsonFn (real one hits
// TheAgent's local HTTP API), same pattern connectivity-check.test.js uses for its own
// injected probe: deterministic and instant, no dependency on this machine actually
// having an NVIDIA GPU or TheAgent running.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureGpuHeadroom } = require('./gpu-guard.js');

test('reports not-checked when nvidia-smi is unavailable (CPU-only box) rather than treating it as starved', async () => {
  const result = await ensureGpuHeadroom({ readFreeVram: () => null, fetchJsonFn: async () => { throw new Error('should not be called'); } });
  assert.equal(result.checked, false);
  assert.equal(result.starved, false);
});

test('reports ok, no TheAgent call, when free VRAM already meets the minimum', async () => {
  let fetchCalled = false;
  const result = await ensureGpuHeadroom({
    minFreeMb: 4096,
    readFreeVram: () => 8000,
    fetchJsonFn: async () => { fetchCalled = true; return { ok: true, body: { apps: [] } }; },
  });
  assert.equal(result.starved, false);
  assert.equal(result.freeMb, 8000);
  assert.equal(fetchCalled, false, 'must not call TheAgent when headroom is already sufficient');
});

test('starved + TheAgent unreachable: reports starved with no yielded apps, does not throw', async () => {
  const result = await ensureGpuHeadroom({
    minFreeMb: 4096,
    readFreeVram: () => 1500,
    fetchJsonFn: async () => ({ ok: false, error: 'connection refused' }),
  });
  assert.equal(result.starved, true);
  assert.deepEqual(result.yielded, []);
  assert.match(result.note, /could not reach TheAgent/);
});

test('starved + a yieldable app IS running: stops it via TheAgent\'s own /stop endpoint, not a raw kill', async () => {
  const calls = [];
  const result = await ensureGpuHeadroom({
    minFreeMb: 4096,
    readFreeVram: () => 1500,
    fetchJsonFn: async (url, options) => {
      calls.push({ url, method: options && options.method });
      if (url.endsWith('/api/automation/apps')) {
        return { ok: true, body: { apps: [{ id: 'comfyui', running: true }, { id: 'n8n', running: false }] } };
      }
      if (url.endsWith('/api/automation/apps/comfyui/stop')) {
        return { ok: true, body: { ok: true } };
      }
      throw new Error(`unexpected url in test: ${url}`);
    },
  });
  assert.equal(result.starved, true);
  assert.deepEqual(result.yielded, ['comfyui']);
  // Only the running, allowlisted app gets a stop call -- n8n (not running) must not.
  assert.equal(calls.filter((c) => c.url.includes('/stop')).length, 1);
  assert.equal(calls.find((c) => c.url.includes('/stop')).method, 'POST');
});

test('starved but no allowlisted app is running: reports starved with an explanatory note, yields nothing', async () => {
  const result = await ensureGpuHeadroom({
    minFreeMb: 4096,
    readFreeVram: () => 1500,
    fetchJsonFn: async (url) => {
      if (url.endsWith('/api/automation/apps')) return { ok: true, body: { apps: [{ id: 'comfyui', running: false }] } };
      throw new Error(`unexpected url in test: ${url}`);
    },
  });
  assert.equal(result.starved, true);
  assert.deepEqual(result.yielded, []);
  assert.match(result.note, /no allowlisted app/);
});

test('only stops apps in the yieldAppIds allowlist, even if TheAgent reports other apps running', async () => {
  const stopped = [];
  const result = await ensureGpuHeadroom({
    minFreeMb: 4096,
    yieldAppIds: ['comfyui'],
    readFreeVram: () => 1500,
    fetchJsonFn: async (url) => {
      if (url.endsWith('/api/automation/apps')) {
        return { ok: true, body: { apps: [{ id: 'comfyui', running: true }, { id: 'some-other-app', running: true }] } };
      }
      if (url.includes('/stop')) {
        stopped.push(url);
        return { ok: true, body: {} };
      }
      throw new Error(`unexpected url in test: ${url}`);
    },
  });
  assert.deepEqual(result.yielded, ['comfyui']);
  assert.equal(stopped.length, 1);
  assert.match(stopped[0], /comfyui\/stop/);
});
