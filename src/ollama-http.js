'use strict';

// Shared HTTP POST helper for talking to Ollama -- both local-client.js (/api/generate)
// and local-tool-client.js (/api/chat) independently implemented the exact same raw
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
// learned the hard way, twice, the same night: local-tool-client.js originally used a
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
 * @param {object} [extraHeaders] - Additional headers merged into the request. Used to pass
 *   X-TokenFold-Session (see local-client.js) -- without it, TokenFold's registry.py-adjacent
 *   proxy hashes each call's own prompt into a fresh, one-off session_id, so its dictionary
 *   bootstrap can never amortize across calls (see encoder.py: "One-shot requests stay at face
 *   value") and nearly every request loses more to the bootstrap tax than it gains from
 *   aliasing, falling back to representation="original". Confirmed live 2026-08-21: with no
 *   session header, 273 real requests netted 0.27% total savings and 198/273 fell back to
 *   "original".
 */
function postJson(urlString, bodyObj, timeoutMs, extraHeaders) {
  const url = new URL(urlString);
  const payload = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        extraHeaders || {}
      ),
      timeout: timeoutMs,
      // agent: false -- confirmed live 2026-08-22: Node's http.globalAgent defaults to
      // keepAlive:true (as of this Node version), pooling TCP connections across calls
      // made from the SAME process. A single draftTask() call makes several SEQUENTIAL
      // Ollama calls (plan, critique, revision) with the single-flight lock released in
      // between each -- during that gap another worker can hold the lock for a real
      // generation call lasting 1-3+ minutes, leaving THIS process's pooled connection
      // to TokenFold idle for an unbounded, often-long duration. That's the textbook
      // stale-pooled-socket race: the server (or an intermediate proxy) can close its
      // side of an idle keep-alive connection at any point during that gap, and Node's
      // own client-side pruning doesn't always detect it before the next write reuses
      // it -- surfacing as "write EPIPE" on a call that has nothing wrong with it,
      // confirmed live as a real, recurring pattern across multiple task sources (not
      // reproducible with a short artificial idle gap, but consistent with the actual
      // multi-minute gaps this pipeline's own lock contention produces). Forcing a fresh
      // connection per call (agent:false, same effect as keepAlive:false) costs a
      // negligible extra TCP handshake on localhost and eliminates this whole class of
      // race by construction, rather than chasing a hard-to-pin-down window.
      agent: false,
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
      // Without this, a connection reset (or any other stream error) arriving AFTER
      // headers but mid-body has no listener on `res` itself (only `req` was covered
      // below) -- Node throws it as an uncaught exception, killing the whole worker
      // process with zero stdout written. Confirmed live 2026-08-23: 159 blocked tasks
      // sharing the identical, content-free reason "draft call failed 5 times in a row
      // (most recent: )" -- draft_result was truly empty every time (not a caught error
      // with a blank message), meaning local-draft.js's node process was dying outright
      // before ever reaching its own process.stdout.write. Doubly bad: an empty message
      // never matches local-worker.sh's INFRA_FAILURE_PATTERN regex either, so every one
      // of these permanently blocked instead of going through the bounded infra-requeue
      // path a real "ECONNRESET"-bearing Error would have qualified for.
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error(`Ollama request timed out after ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Streaming sibling of postJson, for callers that want to relay tokens live (Chat panel's
 * onChunk, 2026-08-26: Open WebUI does the same over Socket.IO/SSE -- this is the
 * equivalent for our http.request-based client). Ollama's stream:true response is NDJSON,
 * one JSON object per line -- TokenFold's proxy (vendor/tokenfold/.../ollama_native.py's
 * own _stream_ndjson) already speaks this shape, so no new upstream contract is needed.
 * Calls onLine(obj) for every parsed line as it arrives; resolves once the response body
 * ends. Errors mid-body (a dropped connection, a non-JSON line) reject the same as
 * postJson's own error paths -- a bad HTTP status is still a hard reject, but a mid-stream
 * failure the proxy already turned into an {error, done_reason:"error"} NDJSON frame is
 * left for the caller to notice via onLine, same as any other line.
 */
function postJsonStream(urlString, bodyObj, timeoutMs, extraHeaders, onLine) {
  const url = new URL(urlString);
  const payload = JSON.stringify(Object.assign({}, bodyObj, { stream: true }));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        extraHeaders || {}
      ),
      timeout: timeoutMs,
      agent: false, // same stale-pooled-socket reasoning as postJson above
    }, (res) => {
      if (res.statusCode !== 200) {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => reject(new Error(`Ollama HTTP ${res.statusCode}: ${data.slice(0, 500)}`)));
        res.on('error', reject);
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try { onLine(JSON.parse(line)); } catch (e) { reject(new Error(`Ollama returned unparseable NDJSON line: ${e.message}`)); }
        }
      });
      res.on('end', () => {
        const line = buf.trim();
        if (line) {
          try { onLine(JSON.parse(line)); } catch (e) { reject(new Error(`Ollama returned unparseable NDJSON line: ${e.message}`)); }
        }
        resolve();
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error(`Ollama request timed out after ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { postJson, postJsonStream };
