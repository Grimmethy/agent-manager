'use strict';

// Host-RAM headroom guard: the system-memory counterpart to gpu-guard.js's VRAM check.
// Added 2026-10-12 after a live freeze on the 20 GB pipeline box: ComfyUI (~7.7 GB incl.
// swap), the P40 VM (5 GB, pinned), and Ollama's runner (~4.7 GB incl. swap) together
// exhausted RAM *and* all 6 GB of swap. The kernel then thrashed for 20+ minutes with five
// OOM kills (it kept picking ~50 MB Brave helpers, never a real consumer) until the
// machine had to be power-cycled. Nothing in this pipeline looked at host RAM -- gpu-guard
// only ever measured VRAM, and the pipeline kept starting local-model work into a box that
// had no memory left to give it.
//
// Same charter as gpu-guard.js: act only on a MEASURED shortage, only through sanctioned
// control surfaces, never block a tick because the check itself failed.
//   1. Measure MemAvailable / SwapFree from /proc/meminfo.
//   2. On pressure, ask ComfyUI to unload via its own POST /free (frees host RAM as well as
//      VRAM; same as its "Unload Models" button) and re-measure.
//   3. Still under pressure -> report it, and the local-model lanes (local-worker.sh,
//      review-runner.sh) yield this tick instead of starting more model work. The pipeline
//      does NOT evict its own resident Ollama model or touch the VM -- they are expected
//      occupancy; the lanes simply stop adding load until RAM recovers.
//
// CLI: node mem-guard.js
//   exit 0  -- ok (or the check itself failed: fail open)
//   exit 3  -- host memory still under pressure after relief; callers should yield the tick

const fs = require('fs');

const MIN_AVAILABLE_MB = Number(process.env.AGENT_MANAGER_MIN_AVAILABLE_RAM_MB) || 2048;
const MIN_SWAP_FREE_MB = Number(process.env.AGENT_MANAGER_MIN_SWAP_FREE_MB) || 512;
const COMFY_URL = process.env.AGENT_MANAGER_COMFY_URL || process.env.COMFY_URL || 'http://127.0.0.1:8188';
const EXIT_PRESSURE = 3;

function parseMeminfo(text) {
  const kb = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  };
  const availableMb = kb('MemAvailable');
  if (availableMb === null) return null;
  return { availableMb, swapFreeMb: kb('SwapFree'), swapTotalMb: kb('SwapTotal') };
}

function readMemory(readFile = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    return parseMeminfo(readFile('/proc/meminfo'));
  } catch (e) {
    return null; // not Linux / unreadable -- nothing to guard
  }
}

// Pressure when available RAM is under the floor, or when swap is nearly gone while RAM is
// not plentiful (the exact state before the 2026-10-12 freeze: swap 0 kB free).
function assessMemory(mem, { minAvailableMb = MIN_AVAILABLE_MB, minSwapFreeMb = MIN_SWAP_FREE_MB } = {}) {
  if (!mem) return { pressure: false, note: 'meminfo unavailable' };
  if (mem.availableMb < minAvailableMb) {
    return { pressure: true, note: `only ${mem.availableMb}MB RAM available (need ${minAvailableMb}MB)` };
  }
  if (mem.swapTotalMb > 0 && mem.swapFreeMb !== null && mem.swapFreeMb < minSwapFreeMb
      && mem.availableMb < minAvailableMb * 2) {
    return { pressure: true, note: `swap nearly exhausted (${mem.swapFreeMb}MB free) with ${mem.availableMb}MB RAM available` };
  }
  return { pressure: false, note: '' };
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

// Returns { checked, pressure, freed: [ids], availableMb, note }. Never throws.
async function ensureRamHeadroom({
  readMem = readMemory,
  fetchJsonFn = fetchJson,
  comfyUrl = COMFY_URL,
  thresholds = {},
  settleMs = 2000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const before = readMem();
  if (!before) return { checked: false, pressure: false, freed: [], availableMb: null, note: 'meminfo unavailable' };
  const first = assessMemory(before, thresholds);
  if (!first.pressure) return { checked: true, pressure: false, freed: [], availableMb: before.availableMb, note: '' };

  const freed = [];
  const res = await fetchJsonFn(
    `${comfyUrl}/free`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) },
    10000,
  );
  if (res && res.ok) freed.push('comfyui');

  let after = before;
  if (freed.length) {
    await sleep(settleMs);
    after = readMem() || before;
  }
  const second = assessMemory(after, thresholds);
  if (!second.pressure) {
    return { checked: true, pressure: false, freed, availableMb: after.availableMb, note: `host RAM was low (${first.note}) -- ComfyUI /free recovered it to ${after.availableMb}MB` };
  }
  return {
    checked: true,
    pressure: true,
    freed,
    availableMb: after.availableMb,
    note: `host RAM pressure: ${second.note}${freed.length ? ' (ComfyUI /free did not recover enough)' : ''} -- local-model lanes yield this tick`,
  };
}

module.exports = { ensureRamHeadroom, assessMemory, parseMeminfo, readMemory, EXIT_PRESSURE };

if (require.main === module) {
  ensureRamHeadroom().then((r) => {
    if (r.note) console.error(`[mem-guard] ${r.note}`);
    process.exit(r.pressure ? EXIT_PRESSURE : 0);
  }).catch((e) => {
    // Fail open: a broken check must never be the reason a tick stops.
    console.error(`[mem-guard] check failed (non-fatal): ${e.message}`);
    process.exit(0);
  });
}
