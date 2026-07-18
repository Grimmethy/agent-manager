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

const http = require('http');

/**
 * @param {string} urlString - Full URL to POST to.
 * @param {object} bodyObj - JSON body.
 * @param {number} timeoutMs - Socket timeout; each caller picks its own (ornith-client.js's
 *   single-generation calls vs. ornith-tool-client.js's multi-turn tool loop need very
 *   different overtime-fail lines).
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
