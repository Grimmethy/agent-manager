'use strict';

// Fail-fast pre-flight: is the local Ollama endpoint actually listening? Wired into
// local-draft.js's runDraftPasses (decomposed from adhoc-brain-dump-bd-1788717523453)
// so a draft that is going to call a local model dies in ~5s with a one-line
// diagnostic ("Ollama endpoint http://localhost:11434 is not reachable (ECONNREFUSED: ...)")
// instead of stalling on the first real generate call's 4-minute socket timeout with
// the identical, far less actionable symptom.
//
// Raw http.get (not fetch) for the same reason ollama-http.js's postJson already avoids
// fetch: undici's built-in header/body timeouts misbehave against this hardware's
// Ollama, so the whole pipeline talks to Ollama through node:http with an explicit
// socket timeout.
//
// Deliberately a bare GET / -- Ollama's own liveness endpoint: it answers 200
// ("Ollama is running") with no model, GPU, or load involved. Not a /api/generate
// probe -- that would actually spend a generation.
const http = require('http');
const { taggedError, OLLAMA_ERROR_CODES } = require('./ollama-http.js');

const DEFAULT_TIMEOUT_MS = 5000; // 5s -- a healthy local endpoint answers in <100ms; generous, but this is a pre-flight, not a generation call (far below ollama-http.js's 5-minute ceiling).

/**
 * Resolve when the Ollama endpoint at `url` answers HTTP 200 to GET /, reject
 * (with a tagged error carrying one of ollama-http.js's OLLAMA_ERROR_CODES) on
 * an invalid URL, timeout, connection failure, or a non-200 status.
 *
 * NORMATIVE URL SPEC (sub-task-2, corrected): the `url` argument MUST be the
 * result of the env-var-first expression
 *   process.env.OLLAMA_URL || 'http://localhost:11434'
 * `http://localhost:11434` appears ONLY as the `||` fallback for when OLLAMA_URL
 * is unset/empty -- it must NEVER be passed as a standalone hardcoded probe that
 * bypasses the env-var check. A caller that ignores OLLAMA_URL and probes
 * localhost directly would silently skip every deployment that routes its Ollama
 * traffic elsewhere:
 *
 *  - src/dead-process-check.js:87 -- the P40 lane is wrapped in
 *    `env OLLAMA_URL="$AGENT_MANAGER_P40_OLLAMA_URL"`, so inside that lane
 *    process.env.OLLAMA_URL resolves to the lane host (e.g. 192.168.122.29:11434),
 *    not the host's own localhost.
 *  - scripts/launch.sh:117 -- TokenFold's healthy-start path exports
 *    OLLAMA_URL=http://localhost:9339 (line 73 was unconfirmed; the real export
 *    is at line 117).
 *
 * NEGATIVE CONSTRAINT: the endpoint URL is not sourced from any config-module
 * field -- src/config.js defines no `ollamaUrl` key at all (verified: zero
 * matches for either `ollamaUrl` or `ollama` in that file), so callers must not
 * try to read the Ollama URL from that module; the env-var expression above is
 * the single source of truth.
 *
 * @param {string} url - Ollama base URL, obtained via the normative env-var-first
 *   expression `process.env.OLLAMA_URL || 'http://localhost:11434'`
 *   (localhost:11434 only as the `||` fallback, never a standalone hardcoded probe).
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000] - Socket timeout for the probe.
 * @returns {Promise<{ok: true, url: string}>}
 */
function checkOllamaReachable(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return Promise.reject(taggedError(`Ollama URL ${JSON.stringify(url)} is not a valid URL: ${e.message}`, OLLAMA_ERROR_CODES.CONNECTION_ERROR));
  }
  if (parsed.protocol === 'https:') {
    // This pipeline's Ollama is local (http); refusing to silently support https
    // here keeps the helper honest instead of needing an https module import.
    return Promise.reject(taggedError(`checkOllamaReachable: only http:// endpoints are supported, got ${url}`, OLLAMA_ERROR_CODES.CONNECTION_ERROR));
  }
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: parsed.hostname, port: parsed.port || 80, path: parsed.pathname || '/', agent: false, timeout: timeoutMs }, (res) => {
      // Drain and finish the response so the socket closes cleanly either way.
      res.resume();
      res.on('end', () => {
        if (res.statusCode === 200) resolve({ ok: true, url });
        else reject(taggedError(`Ollama endpoint ${url} answered HTTP ${res.statusCode} to a liveness probe (expected 200)`, OLLAMA_ERROR_CODES.HTTP_ERROR, { statusCode: res.statusCode }));
      });
    });
    req.on('timeout', () => {
      req.destroy(taggedError(`Ollama endpoint ${url} did not answer within ${timeoutMs}ms`, OLLAMA_ERROR_CODES.TIMEOUT, { timeoutMs }));
    });
    req.on('error', (e) => {
      // req.destroy(err) re-emits the SAME tagged error (see ollama-http.js's
      // isAlreadyTagged note) -- pass tagged timeouts through unchanged, wrap the rest.
      reject(e && e.code && Object.values(OLLAMA_ERROR_CODES).includes(e.code)
        ? e
        : taggedError(`Ollama endpoint ${url} is not reachable (${e && e.code || 'unknown error'}: ${e && e.message})`, OLLAMA_ERROR_CODES.CONNECTION_ERROR));
    });
  });
}

module.exports = { checkOllamaReachable };
