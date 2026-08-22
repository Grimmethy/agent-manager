'use strict';

// Unit tests for postJson()'s extraHeaders param -- the mechanism ornith-client.js uses
// to send a stable X-TokenFold-Session header (see its own comment for why: without one,
// TokenFold hashes each call's own prompt into a fresh session and can never amortize its
// dictionary bootstrap cost, confirmed live 2026-08-21 at 0.27% real savings).
//
// Run: node --test src/ollama-http.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { postJson } = require('./ollama-http.js');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}`);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

test('postJson sends extraHeaders alongside the standard ones', async () => {
  let receivedHeaders = null;
  await withServer(
    (req, res) => {
      receivedHeaders = req.headers;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    },
    async (base) => {
      const result = await postJson(`${base}/api/generate`, { a: 1 }, 5000, {
        'X-TokenFold-Session': 'agent-manager-worker-1',
      });
      assert.deepEqual(result, { ok: true });
      assert.equal(receivedHeaders['x-tokenfold-session'], 'agent-manager-worker-1');
      assert.equal(receivedHeaders['content-type'], 'application/json');
    }
  );
});

// Regression, 2026-08-22: Node's http.globalAgent defaults to keepAlive:true, pooling
// connections across calls made from the same process -- local-draft.js's draftTask()
// makes several sequential Ollama calls (plan, critique, revision) with the single-flight
// lock released in between each, so a pooled connection can sit idle for however long
// another worker's real generation call takes (often 1-3+ minutes) before being reused.
// Confirmed live as the root cause of a recurring "write EPIPE" pattern across multiple
// task sources: a stale pooled socket dies server-side during that gap, and the next
// write reuses it before Node's own pruning catches it. postJson now passes agent:false
// to force a fresh connection every call, eliminating this race by construction.
test('postJson opens a FRESH connection every call, never reusing a pooled keep-alive socket', async () => {
  const remotePorts = new Set();
  await withServer(
    (req, res) => {
      remotePorts.add(req.socket.remotePort);
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    },
    async (base) => {
      await postJson(`${base}/api/generate`, { a: 1 }, 5000);
      await postJson(`${base}/api/generate`, { a: 2 }, 5000);
      await postJson(`${base}/api/generate`, { a: 3 }, 5000);
      assert.equal(remotePorts.size, 3, 'each call must use a distinct client-side port -- a reused keep-alive connection would show the same port for all three');
    }
  );
});

test('postJson works with no extraHeaders (backward compatible)', async () => {
  let receivedHeaders = null;
  await withServer(
    (req, res) => {
      receivedHeaders = req.headers;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    },
    async (base) => {
      const result = await postJson(`${base}/api/generate`, { a: 1 }, 5000);
      assert.deepEqual(result, { ok: true });
      assert.equal(receivedHeaders['x-tokenfold-session'], undefined);
    }
  );
});
