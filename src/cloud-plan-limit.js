'use strict';

// The cloud plan-limit probe (HUB0781): asks a cloud gateway whether its plan limit is reached, so a cloud lane or reviewer can pause instead of claiming tasks.
//
// It GETs <baseUrl>/health. Limited only for HTTP 200 with a JSON object whose planLimit is a plain object:
//   planLimit.resetsAt in the future  -> { limited: true, resetsAt: ISO string }
//   planLimit.resetsAt missing        -> { limited: true, resetsAt: null }
// Every other outcome (thrown error, timeout, non-200, bad JSON, planLimit not an object, past or unparseable resetsAt)
// FAILS OPEN to { limited: false, resetsAt: null }. The function never rejects.
//
// CLI (the bash worker shells out to it so the rule lives once):
//   node src/cloud-plan-limit.js is-limited <baseUrl>
//     prints one line and exits 0 when limited (the resetsAt, or 'until unknown'); exits 1 otherwise, printing nothing. Never throws.

const DEFAULT_TIMEOUT_MS = 3000;

function closed() {
  return { limited: false, resetsAt: null };
}

async function isPlanLimited(baseUrl, { fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    if (typeof baseUrl !== 'string') return closed();
    const base = baseUrl.trim().replace(/\/+$/, '');
    if (!base) return closed();
    if (typeof fetchImpl !== 'function') return closed();

    const ac = new AbortController();
    let timer;
    // One-shot timeout: aborts the request and rejects the race so a fetch that ignores the signal still cannot hang the caller.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error('plan-limit probe timed out'));
      }, timeoutMs);
    });
    timeout.catch(() => {});

    let body;
    try {
      const res = await Promise.race([fetchImpl(base + '/health', { method: 'GET', signal: ac.signal }), timeout]);
      if (!res || res.status !== 200) return closed();
      body = await Promise.race([res.json(), timeout]);
    } finally {
      clearTimeout(timer);
    }

    const planLimit = body && typeof body === 'object' && !Array.isArray(body) ? body.planLimit : undefined;
    if (!planLimit || typeof planLimit !== 'object' || Array.isArray(planLimit)) return closed();

    if (planLimit.resetsAt === undefined || planLimit.resetsAt === null) return { limited: true, resetsAt: null };

    const parsed = Date.parse(planLimit.resetsAt);
    if (Number.isNaN(parsed)) return closed();
    if (parsed > Number(now)) return { limited: true, resetsAt: new Date(parsed).toISOString() };
    return closed();
  } catch (e) {
    return closed();
  }
}

module.exports = { isPlanLimited };

if (require.main === module) {
  const [cmd, baseUrl] = process.argv.slice(2);
  (async () => {
    try {
      if (cmd !== 'is-limited' || !baseUrl) {
        process.exitCode = 1;
        return;
      }
      const r = await isPlanLimited(baseUrl);
      if (!r.limited) {
        process.exitCode = 1;
        return;
      }
      console.log(r.resetsAt || 'until unknown');
      process.exitCode = 0;
    } catch (e) {
      process.exitCode = 1;
    }
  })();
}
