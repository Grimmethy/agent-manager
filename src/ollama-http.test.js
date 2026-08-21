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
