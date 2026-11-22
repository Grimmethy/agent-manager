'use strict';

// The cloud plan-limit probe: asks a cloud-providers gateway whether its plan limit is reached, so a cloud lane can claim nothing instead of claiming
// tasks, getting HTTP 429 and parking them as deferred until the window resets.
//
// It GETs <baseUrl>/health. Limited only for HTTP 200 with a JSON object whose planLimit is a plain object:
//   planLimit.resetsAt in the future  -> { limited: true, resetsAt: ISO string }
//   planLimit.resetsAt missing        -> { limited: true, resetsAt: null }
// Every other outcome (thrown error, timeout, non-200, bad JSON, planLimit not an object, past or unparseable resetsAt) FAILS OPEN to
// { limited: false, resetsAt: null }. A broken probe must never stall the swarm. isPlanLimited never rejects.
//
// CLI (the bash worker shells out to it so the rule lives once; same shape as src/cloud-dial.js):
//   node src/cloud-plan-limit.js is-limited <baseUrl>
//     exits 0 and prints one line (the resetsAt, or 'until unknown') when limited; exits 1 printing nothing otherwise. Exits 1 WITHOUT any HTTP call when
//     baseUrl is not the endpoint of an enabled cloud lane (src/lanes.js isCloudEndpoint), so a local GPU Ollama is never probed. Never throws.

const { isCloudEndpoint } = require('./lanes.js');

const DEFAULT_TIMEOUT_MS = 3000;

function open() {
  return { limited: false, resetsAt: null };
}

async function isPlanLimited(baseUrl, { fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    if (typeof baseUrl !== 'string') return open();
    const base = baseUrl.trim().replace(/\/+$/, '');
    if (!base) return open();
    if (typeof fetchImpl !== 'function') return open();

    const ac = new AbortController();
    let timer;
    // One-shot timeout: aborts the request and rejects the race, so a fetch that ignores the signal still cannot hang the caller.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { ac.abort(); reject(new Error('plan-limit probe timed out')); }, timeoutMs);
    });
    let res;
    let body;
    try {
      const probe = (async () => {
        const r = await fetchImpl(`${base}/health`, { signal: ac.signal });
        if (!r || r.status !== 200) return { r, body: null };
        return { r, body: await r.json() };
      })();
      probe.catch(() => {}); // a probe that loses the race must not leave an unhandled rejection behind
      ({ r: res, body } = await Promise.race([probe, timeout]));
    } finally {
      clearTimeout(timer);
    }
    if (!res || res.status !== 200) return open();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return open();
    const pl = body.planLimit;
    if (!pl || typeof pl !== 'object' || Array.isArray(pl)) return open();
    if (pl.resetsAt === undefined || pl.resetsAt === null) return { limited: true, resetsAt: null };
    const at = Date.parse(pl.resetsAt);
    if (!Number.isFinite(at) || at <= now) return open();
    return { limited: true, resetsAt: new Date(at).toISOString() };
  } catch (e) {
    return open();
  }
}

// The CLI's decision: a url that is not an enabled cloud lane's endpoint is answered not-limited with no fetch at all.
async function cliIsLimited(baseUrl, { env = process.env, ...opts } = {}) {
  try {
    if (!isCloudEndpoint(baseUrl, env)) return open();
    return await isPlanLimited(baseUrl, opts);
  } catch (e) {
    return open();
  }
}

module.exports = { isPlanLimited, cliIsLimited, DEFAULT_TIMEOUT_MS };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  (async () => {
    if (cmd !== 'is-limited') {
      console.error('usage: cloud-plan-limit.js is-limited <baseUrl>');
      process.exit(2);
    }
    const r = await cliIsLimited(arg);
    if (!r.limited) process.exit(1);
    console.log(r.resetsAt || 'until unknown');
    process.exit(0);
  })().catch(() => process.exit(1));
}
