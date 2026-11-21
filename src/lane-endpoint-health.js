'use strict';

// Lane endpoint reachability probe. Read-only: one GET per Ollama server's model-list
// endpoint, with a short per-endpoint timeout. It never runs inference, never loads a
// model into VRAM, and never repeats on a timer. The caller decides when to ask.

const PROBE_PATH = '/api/tags';
const DEFAULT_TIMEOUT_MS = 3000;

async function probeOne(endpoint, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(String(endpoint).replace(/\/+$/, '') + PROBE_PATH, { signal: controller.signal });
    // Drain the small body so the socket is released; a failure to read it does not change reachability.
    await res.text().catch(() => {});
    return { endpoint, reachable: res.ok === true };
  } catch (_err) {
    return { endpoint, reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe each lane's ollamaUrl once.
 * @param {string[]} ollamaUrls
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{endpoint: string, reachable: boolean}>>}
 */
async function checkLaneEndpoints(ollamaUrls, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const urls = Array.isArray(ollamaUrls) ? ollamaUrls : [];
  return Promise.all(urls.map((u) => probeOne(u, timeoutMs)));
}

module.exports = { checkLaneEndpoints };
