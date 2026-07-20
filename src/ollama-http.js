'use strict';

// Shared HTTP POST helper for talking to Ollama -- both ornith-client.js (/api/generate)
// and ornith-tool-client.js (/api/chat) independently implemented the exact same raw
// http.request-with-timeout wrapper, each with its own comment explaining why (fetch/
// undici's ~5-minute built-in timeout is too short for this hardware's real generation
// times) instead of sharing one. The 4-minute overtime-fail tuning this exists for is a
// deliberate, hard-won value -- keeping one copy means it can't drift out of sync between
// the two callers by hand-editing only one of them.
//
// Raw http.request instead of fetch: with stream:false Ollama only answers once the whole
// generation is done, and fetch/undici's built-in header/body timeouts are too short to
// always let a real call finish, so this uses its own socket timeout instead.
//
// FORMALIZED CEILING (2026-07-19): no timeoutMs passed to postJson, and no worker-liveness
// threshold anywhere in this pipeline (queue-watchdog.ps1's $StaleHeartbeatSeconds /
// $WorkerZombieThresholdSeconds), should exceed 5 minutes (300_000ms / 300s). This was
// learned the hard way, twice, the same night: ornith-tool-client.js originally used a
// 30-minute timeout on the theory that a slower call class deserved more room, and that
// theory was actively harmful -- it let a genuinely hung call block a worker for 13+
// minutes with nothing catching it, and is a direct reason that whole call path is
// currently disabled. Separately, a first attempt at a worker-zombie-restart threshold used
// 15 minutes "to be safe," and got corrected down to 5 after the operator pointed out that
// repeated-failure downtime compounds fast and a bigger margin doesn't buy any real safety
// once you actually check what's bounding legitimate call duration (see
// docs/pipeline-incident-2026-07-19.md). If a future timeout genuinely needs to exceed 5
// minutes, that is itself a signal to question the design generating it, not just the
// number -- do not silently raise these values to "fix" a false-positive without revisiting
// this reasoning first.

const http = require('http');

/**
 * @param {string} urlString - Full URL to POST to.
 * @param {object} bodyObj - JSON body.
 * @param {number} timeoutMs - Socket timeout. Both current callers pass 240_000 (4 min,
 *   under the 5-min ceiling documented above) via their own REQUEST_TIMEOUT_MS constants --
 *   kept as separate named constants per caller rather than one shared value here, so each
 *   call site's reasoning stays visible next to it.
 */
function postJson(urlString, bodyObj, timeoutMs) {
  const url = new URL(urlString);
  const payload = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Ollama returned unparseable JSON: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`Ollama request timed out after ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { postJson };
