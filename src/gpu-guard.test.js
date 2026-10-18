'use strict';

// Unit tests for gpu-guard.js's ensureGpuHeadroom() -- uses injected fakes for both
// readFreeVram (real one shells out to nvidia-smi) and fetchJsonFn (real one hits
// TheAgent's local HTTP API), same pattern connectivity-check.test.js uses for its own
// injected probe: deterministic and instant, no dependency on this machine actually
// having an NVIDIA GPU or TheAgent running.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureGpuHeadroom: realEnsureGpuHeadroom } = require('./gpu-guard.js');

// ensureGpuHeadroom's default leaseHeld reads the REAL ~/.local/state/agent-manager/comfyui-lease.json, so
// these tests failed (12 of 18) whenever PromptForge happened to hold a lease while the suite ran. Default it
// to "not held"; the lease tests below pass their own leaseHeld and still override this.
const ensureGpuHeadroom = (opts = {}) => realEnsureGpuHeadroom({ leaseHeld: () => false, ...opts });

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
      if (url.endsWith('/free')) return { ok: false }; // no standalone ComfyUI in this scenario
      if (url.endsWith('/api/ps')) return { ok: true, body: { models: [] } }; // no Ollama model resident
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
      if (url.endsWith('/free')) return { ok: false };
      if (url.endsWith('/api/ps')) return { ok: true, body: { models: [] } };
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
      if (url.endsWith('/free')) return { ok: false };
      if (url.endsWith('/api/ps')) return { ok: true, body: { models: [] } };
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

test('starved: hits a standalone ComfyUI POST /free first; if that recovers the VRAM, no TheAgent call', async () => {
  const calls = [];
  let free = 1500;
  const result = await ensureGpuHeadroom({
    minFreeMb: 4096,
    readFreeVram: () => free,
    fetchJsonFn: async (url, options) => {
      calls.push({ url, method: options && options.method, body: options && options.body });
      if (url.endsWith('/free')) { free = 12000; return { ok: true }; } // ComfyUI unloaded its models
      throw new Error(`must not reach TheAgent once /free recovered the GPU: ${url}`);
    },
  });
  assert.equal(result.starved, false);
  assert.deepEqual(result.freed, ['comfyui']);
  assert.equal(result.freeMb, 12000);
  const freeCall = calls.find((c) => c.url.endsWith('/free'));
  assert.equal(freeCall.method, 'POST');
  assert.match(freeCall.body, /unload_models/);
  assert.equal(calls.filter((c) => c.url.includes('/api/automation/apps')).length, 0);
});

test('starved: /free is tried but does not free enough -> still falls through to the TheAgent /stop path, reporting both', async () => {
  const calls = [];
  const result = await ensureGpuHeadroom({
    minFreeMb: 4096,
    readFreeVram: () => 1500, // stays low even after /free
    fetchJsonFn: async (url) => {
      calls.push(url);
      if (url.endsWith('/free')) return { ok: true };
      if (url.endsWith('/api/ps')) return { ok: true, body: { models: [] } };
      if (url.endsWith('/api/automation/apps')) return { ok: true, body: { apps: [{ id: 'n8n', running: true }] } };
      if (url.endsWith('/api/automation/apps/n8n/stop')) return { ok: true };
      throw new Error(`unexpected url: ${url}`);
    },
  });
  assert.equal(result.starved, true);
  assert.deepEqual(result.freed, ['comfyui']);
  assert.deepEqual(result.yielded, ['n8n']);
  assert.match(result.note, /comfyui \(\/free\)/);
  assert.match(result.note, /n8n/);
});

test('starved: no standalone ComfyUI (/free unreachable) and TheAgent unreachable -> honest "no control surface" note, never throws', async () => {
  const result = await ensureGpuHeadroom({
    minFreeMb: 4096,
    readFreeVram: () => 1500,
    fetchJsonFn: async () => ({ ok: false, error: 'ECONNREFUSED' }),
  });
  assert.equal(result.starved, true);
  assert.deepEqual(result.freed, []);
  assert.deepEqual(result.yielded, []);
});

test('below the target but Ollama has a model resident -> not starved (expected occupancy), no TheAgent call', async () => {
  const calls = [];
  const result = await ensureGpuHeadroom({
    minFreeMb: 18000,
    readFreeVram: () => 7000, // model is loaded, so free is well under target -- normal
    fetchJsonFn: async (url) => {
      calls.push(url);
      if (url.endsWith('/free')) return { ok: false }; // no standalone ComfyUI
      if (url.endsWith('/api/ps')) return { ok: true, body: { models: [{ name: 'qwen3.8:27b-q4_K_M', size_vram: 16 * 1024 * 1024 * 1024 }] } };
      throw new Error(`must not reach TheAgent when the shortfall is Ollama's own model: ${url}`);
    },
  });
  assert.equal(result.starved, false);
  assert.match(result.note, /Ollama's own resident model/);
  assert.match(result.note, /16384MB/);
  assert.equal(calls.filter((c) => c.includes('/api/automation/apps')).length, 0);
});

test('below the target, freed ComfyUI, and Ollama model also resident -> not starved, note mentions both', async () => {
  const result = await ensureGpuHeadroom({
    minFreeMb: 18000,
    readFreeVram: () => 9000,
    fetchJsonFn: async (url) => {
      if (url.endsWith('/free')) return { ok: true }; // standalone ComfyUI unloaded
      if (url.endsWith('/api/ps')) return { ok: true, body: { models: [{ size_vram: 15 * 1024 * 1024 * 1024 }] } };
      throw new Error(`unexpected: ${url}`);
    },
  });
  assert.equal(result.starved, false);
  assert.deepEqual(result.freed, ['comfyui']);
  assert.match(result.note, /freed comfyui/);
});

test('a tiny /api/ps size_vram (rounding artefact) is not treated as a resident model', async () => {
  const result = await ensureGpuHeadroom({
    minFreeMb: 4096,
    readFreeVram: () => 1500,
    fetchJsonFn: async (url) => {
      if (url.endsWith('/free')) return { ok: false };
      if (url.endsWith('/api/ps')) return { ok: true, body: { models: [{ size_vram: 4 * 1024 * 1024 }] } }; // 4MB
      if (url.endsWith('/api/automation/apps')) return { ok: true, body: { apps: [] } };
      throw new Error(`unexpected: ${url}`);
    },
  });
  assert.equal(result.starved, true); // 4MB isn't "the model is resident"
});

// --- ComfyUI GPU lease (2026-08-30) -------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { comfyuiLeaseHeld } = require('./gpu-guard.js');

function withLeaseFile(contents, fn) {
  const p = path.join(os.tmpdir(), `comfyui-lease-test-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(contents));
  try { return fn(p); } finally { try { fs.unlinkSync(p); } catch (e) {} }
}

test('lease held (fresh): ensureGpuHeadroom does nothing -- no VRAM read, no /free', async () => {
  let touched = false;
  const result = await ensureGpuHeadroom({
    leaseHeld: () => true,
    readFreeVram: () => { touched = true; return 100; },
    fetchJsonFn: async () => { touched = true; return { ok: true }; },
  });
  assert.equal(touched, false, 'must not probe VRAM or hit ComfyUI while the lease is held');
  assert.equal(result.starved, false);
  assert.deepEqual(result.freed, []);
  assert.deepEqual(result.yielded, []);
  assert.match(result.note, /comfyui-lease held/);
});

test('lease absent: the normal /free reclaim path still runs', async () => {
  const calls = [];
  await ensureGpuHeadroom({
    leaseHeld: () => false,
    minFreeMb: 4096,
    readFreeVram: () => 1500,
    fetchJsonFn: async (url) => {
      calls.push(url);
      if (url.endsWith('/free')) return { ok: true };
      if (url.endsWith('/api/ps')) return { ok: true, body: { models: [] } };
      if (url.endsWith('/api/automation/apps')) return { ok: true, body: { apps: [] } };
      throw new Error(`unexpected: ${url}`);
    },
  });
  assert.ok(calls.some((u) => u.endsWith('/free')), 'the reclaim /free call must still happen with no lease');
});

test('comfyuiLeaseHeld: fresh refreshedAt + acquiredAt -> true', () => {
  const now = new Date().toISOString();
  withLeaseFile({ holder: 'promptforge', acquiredAt: now, refreshedAt: now }, (p) => {
    assert.equal(comfyuiLeaseHeld(p), true);
  });
});

test('comfyuiLeaseHeld: refreshedAt older than TTL -> false (stale)', () => {
  const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  withLeaseFile({ holder: 'promptforge', acquiredAt: old, refreshedAt: old }, (p) => {
    assert.equal(comfyuiLeaseHeld(p), false);
  });
});

test('comfyuiLeaseHeld: acquiredAt past MAX_S even with a fresh refreshedAt -> false (anti-starvation ceiling)', () => {
  const acquired = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago, past 900s
  const refreshed = new Date().toISOString();
  withLeaseFile({ holder: 'promptforge', acquiredAt: acquired, refreshedAt: refreshed }, (p) => {
    assert.equal(comfyuiLeaseHeld(p), false);
  });
});

test('comfyuiLeaseHeld: missing file -> false (fails open)', () => {
  assert.equal(comfyuiLeaseHeld(path.join(os.tmpdir(), 'definitely-not-a-lease-file-xyz.json')), false);
});

// ---- Forge family exclusion: with no lease, a ComfyUI that is still up is asked to yield via PromptForge ----

const { yieldForgeToPipeline } = require('./gpu-guard.js');

test('yieldForgeToPipeline: ComfyUI not running -> nothing to do, PromptForge never called', async () => {
  const urls = [];
  const r = await yieldForgeToPipeline({ fetchJsonFn: async (u) => { urls.push(u); return { ok: false }; } });
  assert.equal(r.acted, false);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/system_stats$/);
});

test('yieldForgeToPipeline: ComfyUI up, PromptForge grants -> acted, POSTs /api/gpu/yield', async () => {
  const calls = [];
  const r = await yieldForgeToPipeline({
    promptforgeUrl: 'http://pf:7430',
    fetchJsonFn: async (u, o) => {
      calls.push([u, o && o.method]);
      if (u.endsWith('/system_stats')) return { ok: true, body: {} };
      return { ok: true, body: { yielded: true, reason: 'forge session ended' } };
    },
  });
  assert.equal(r.acted, true);
  assert.deepEqual(calls[1], ['http://pf:7430/api/gpu/yield', 'POST']);
  assert.match(r.note, /stopped it/);
});

test('yieldForgeToPipeline: PromptForge declines (a Forge job is running) -> not acted, says why', async () => {
  const r = await yieldForgeToPipeline({
    fetchJsonFn: async (u) => (u.endsWith('/system_stats') ? { ok: true, body: {} } : { ok: true, body: { yielded: false, reason: 'a Forge job is running' } }),
  });
  assert.equal(r.acted, false);
  assert.match(r.note, /declined to yield: a Forge job is running/);
});

test('yieldForgeToPipeline: PromptForge down or the fetch throws -> never throws, falls back to the existing path', async () => {
  const down = await yieldForgeToPipeline({ fetchJsonFn: async (u) => (u.endsWith('/system_stats') ? { ok: true, body: {} } : { ok: false, error: 'refused' }) });
  assert.equal(down.acted, false);
  const boom = await yieldForgeToPipeline({ fetchJsonFn: async () => { throw new Error('boom'); } });
  assert.deepEqual(boom, { acted: false, note: '' });
});

test('ensureGpuHeadroom with forgeYield: no lease -> yields first and the note says so; plenty of VRAM afterwards = not starved', async () => {
  let yielded = 0;
  const r = await ensureGpuHeadroom({
    minFreeMb: 4096, leaseHeld: () => false, readFreeVram: () => 20000,
    forgeYield: async () => { yielded++; return { acted: true, note: 'ComfyUI stopped' }; },
  });
  assert.equal(yielded, 1);
  assert.equal(r.starved, false);
  assert.equal(r.note, 'ComfyUI stopped');
});

test('ensureGpuHeadroom with forgeYield: lease held -> the Forge family owns the card, yield is NOT attempted', async () => {
  let yielded = 0;
  const r = await ensureGpuHeadroom({
    leaseHeld: () => true, forgeYield: async () => { yielded++; return { acted: true, note: 'x' }; },
  });
  assert.equal(yielded, 0);
  assert.match(r.note, /comfyui-lease held/);
});

test('ensureGpuHeadroom without forgeYield (the default, and every existing caller): behaviour unchanged', async () => {
  const r = await ensureGpuHeadroom({ minFreeMb: 4096, leaseHeld: () => false, readFreeVram: () => 20000, fetchJsonFn: async () => { throw new Error('must not be called'); } });
  assert.equal(r.starved, false);
  assert.equal(r.note, '');
});

// ---- endpoint-scoped lease (2026-10-18): a plugin reserving ONE card holds off that card's callers only -------------------------------------------
const { leaseHeldFor, leaseCovers, normalizeEndpoint } = require('./gpu-guard.js');

const P40 = 'http://192.168.122.29:11434';
const HOST = 'http://localhost:11434';
const freshLease = (extra = {}) => { const now = new Date().toISOString(); return { holder: 'kaggleforge', acquiredAt: now, refreshedAt: now, ...extra }; };

test('normalizeEndpoint: localhost, 127.0.0.1 and ::1 are one host; a missing port means 11434; junk is null', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.1:11434'), 'localhost:11434');
  assert.equal(normalizeEndpoint('http://[::1]:11434/'), 'localhost:11434');
  assert.equal(normalizeEndpoint('localhost'), 'localhost:11434');
  assert.equal(normalizeEndpoint('HTTP://LocalHost:11434'), 'localhost:11434');
  assert.equal(normalizeEndpoint('http://192.168.122.29:11434/api'), '192.168.122.29:11434');
  assert.equal(normalizeEndpoint('http://192.168.122.29'), '192.168.122.29:11434');
  assert.equal(normalizeEndpoint(''), null);
  assert.equal(normalizeEndpoint(undefined), null);
});

test('leaseCovers: no endpoints field (PromptForge) or an empty list = the whole pipeline, for any endpoint', () => {
  assert.equal(leaseCovers({ holder: 'promptforge' }, P40), true);
  assert.equal(leaseCovers({ holder: 'promptforge', endpoints: [] }, HOST), true);
  assert.equal(leaseCovers({ endpoints: 'not-an-array' }, HOST), true, 'a malformed field is not a scope: stay held');
});

test('leaseCovers: a scoped lease covers only the endpoints it lists', () => {
  assert.equal(leaseCovers({ endpoints: [P40] }, P40), true);
  assert.equal(leaseCovers({ endpoints: [P40] }, HOST), false);
  assert.equal(leaseCovers({ endpoints: [HOST] }, 'http://127.0.0.1:11434'), true, 'localhost and 127.0.0.1 are the same card');
  assert.equal(leaseCovers({ endpoints: [P40, HOST] }, HOST), true);
  assert.equal(leaseCovers({ endpoints: [P40] }, 'http://192.168.122.29:11435'), false, 'same host, other port, other server');
});

test('leaseCovers: a caller whose endpoint cannot be parsed stays held (the safe side)', () => {
  assert.equal(leaseCovers({ endpoints: [P40] }, ''), true);
});

test('leaseHeldFor: an unscoped fresh lease is held for every endpoint (existing behaviour)', () => {
  withLeaseFile(freshLease({ holder: 'promptforge' }), (p) => {
    assert.equal(leaseHeldFor(P40, p), true);
    assert.equal(leaseHeldFor(HOST, p), true);
  });
});

test('leaseHeldFor: a scoped fresh lease is held for its endpoint and NOT for the other card', () => {
  withLeaseFile(freshLease({ endpoints: [P40] }), (p) => {
    assert.equal(leaseHeldFor(P40, p), true);
    assert.equal(leaseHeldFor(HOST, p), false);
  });
});

test('leaseHeldFor: staleness and the MAX ceiling still apply to a scoped lease', () => {
  const now = new Date().toISOString();
  const staleRefresh = new Date(Date.now() - 600 * 1000).toISOString();   // past the 90 s TTL
  const pastCeiling = new Date(Date.now() - 1000 * 1000).toISOString();   // past the 900 s MAX
  withLeaseFile({ holder: 'kaggleforge', endpoints: [P40], acquiredAt: now, refreshedAt: staleRefresh }, (p) => assert.equal(leaseHeldFor(P40, p), false, 'refreshedAt past the TTL'));
  withLeaseFile({ holder: 'kaggleforge', endpoints: [P40], acquiredAt: pastCeiling, refreshedAt: now }, (p) => assert.equal(leaseHeldFor(P40, p), false, 'acquiredAt past the MAX ceiling'));
});

test('leaseHeldFor: missing or malformed file -> not held (fails open)', () => {
  assert.equal(leaseHeldFor(P40, path.join(os.tmpdir(), 'definitely-not-a-lease-file-xyz.json')), false);
  const p = path.join(os.tmpdir(), `comfyui-lease-bad-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, '{not json');
  try { assert.equal(leaseHeldFor(P40, p), false); } finally { fs.unlinkSync(p); }
});

test('comfyuiLeaseHeld keeps its whole-pipeline meaning for a scoped lease (ensureGpuHeadroom and the Forge paths see "some lease is held")', () => {
  withLeaseFile(freshLease({ endpoints: [P40] }), (p) => assert.equal(comfyuiLeaseHeld(p), true));
});
