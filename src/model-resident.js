'use strict';
// Residency gate (owner decision 2026-11-06, disk-I/O pass). A cold load of the 21 GB local model takes ~2m20s-2m30s on this box while it saturates
// the SSD, and callers' request timeouts (gpu-capacity.js MIN_TIMEOUT_MS = 150 s) fired mid-load: Ollama threw the half-loaded model away ("Load
// failed ... context canceled", HTTP 499) and the next request started the 21 GB read again, 29 times in 3 hours. The rule here: never send work
// to a model that is not resident. ensureResident() asks GET /api/ps; if the model is not there at the wanted context it takes ONE cross-process
// warm-up lock (single-flight-lock.js, key 'model-warmup'), sends a one-token warm-up whose client timeout is the load timeout (30 min, the same
// as the server's OLLAMA_LOAD_TIMEOUT), and releases. Every other process waits on the lock, then finds the model resident and skips. The caller's
// own request timeout therefore only ever covers real work, never a load. It never unloads anything and never throws: any trouble degrades to the
// old behaviour (send the request anyway).
const sfl = require('./single-flight-lock.js');
const { postJson } = require('./ollama-http.js');
const { NEVER_EXPIRE } = require('./keep-alive.js');

const WARM_LOCK_KEY = 'model-warmup';
const WARM_REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // = OLLAMA_LOAD_TIMEOUT=30m in the ollama systemd override
const PS_TIMEOUT_MS = 5000;
const RESIDENT_CACHE_MS = 30 * 1000; // a positive answer is trusted this long so a burst of calls costs one /api/ps, not one each
const cache = new Map(); // `${url}|${model}|${numCtx}` -> expiresAt (ms)

// Returns the array of loaded models from GET /api/ps, or null when Ollama cannot be asked.
async function readPs(url, fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn(`${String(url).replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(PS_TIMEOUT_MS) });
    if (!res || !res.ok) return null;
    const body = await res.json();
    return Array.isArray(body.models) ? body.models : [];
  } catch {
    return null;
  }
}

// True when `model` is loaded and (if /api/ps reports a context length) at the wanted numCtx: a different context is a different runner.
function isResident(models, model, numCtx) {
  return models.some((m) => (m.name === model || m.model === model) && (!numCtx || !m.context_length || m.context_length === numCtx));
}

async function ensureResident({ url, model, numCtx, instancesDir, fetchFn, post = postJson, withLock = sfl.withLock, now = Date.now, log = console.error }) {
  if (!instancesDir || !model || !url) return { skipped: 'not-configured' };
  const key = `${url}|${model}|${numCtx || ''}`;
  if ((cache.get(key) || 0) > now()) return { resident: true, waitedMs: 0, cached: true };
  const first = await readPs(url, fetchFn);
  if (first === null) return { skipped: 'ps-unreachable' };
  if (isResident(first, model, numCtx)) { cache.set(key, now() + RESIDENT_CACHE_MS); return { resident: true, waitedMs: 0 }; }
  const t0 = now();
  try {
    await withLock(instancesDir, async () => {
      const again = await readPs(url, fetchFn); // another process may have finished the load while this one waited for the lock
      if (again && isResident(again, model, numCtx)) return;
      await post(`${String(url).replace(/\/$/, '')}/api/generate`, {
        model, prompt: 'hi', stream: false, keep_alive: NEVER_EXPIRE, options: { num_ctx: numCtx, num_predict: 1 },
      }, WARM_REQUEST_TIMEOUT_MS);
    }, WARM_LOCK_KEY, { skipPriorityBackoff: true });
  } catch (e) {
    log(`[model-resident] warm-up of ${model} did not complete (${e.message}); sending the request anyway`);
    return { resident: false, waitedMs: now() - t0, error: e.message };
  }
  cache.set(key, now() + RESIDENT_CACHE_MS);
  const waitedMs = now() - t0;
  if (waitedMs > 1000) log(`[model-resident] waited ${(waitedMs / 1000).toFixed(1)}s for ${model} (numCtx=${numCtx}) to become resident before sending work`);
  return { resident: true, waitedMs };
}

function clearCache() { cache.clear(); }

module.exports = { ensureResident, isResident, readPs, clearCache, WARM_LOCK_KEY, WARM_REQUEST_TIMEOUT_MS };
