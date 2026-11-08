'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { postJson, postJsonStream, OLLAMA_ERROR_CODES } = require('./ollama-http.js');

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

// Tests for postJsonStream deadlineMs parameter wiring
test('postJsonStream with no deadlineMs completes normally on fast server', async () => {
  const lines = [];
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ ok: true }) + '\n');
        res.end();
      });
    },
    async (base) => {
      await postJsonStream(`${base}/api/chat`, { messages: [] }, undefined, undefined, (line) => {
        lines.push(line);
      });
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0], { ok: true });
    }
  );
});

test('postJsonStream with deadlineMs that is not exceeded resolves normally', async () => {
  const lines = [];
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ ok: true }) + '\n');
        res.end();
      });
    },
    async (base) => {
      await postJsonStream(`${base}/api/chat`, { messages: [] }, 5000, undefined, (line) => {
        lines.push(line);
      });
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0], { ok: true });
    }
  );
});

test('postJsonStream with deadlineMs that IS exceeded rejects with TIMEOUT', async () => {
  await withServer(
    (req, res) => {
      // Never respond -- deadline will fire
    },
    async (base) => {
      try {
        await postJsonStream(`${base}/api/chat`, { messages: [] }, 100, undefined, () => {});
        assert.fail('expected reject on deadline expiry');
      } catch (e) {
        assert.equal(e.code, OLLAMA_ERROR_CODES.TIMEOUT);
        assert.equal(e.deadlineMs, 100);
      }
    }
  );
});

// Test: deadlineMs parameter is the third positional arg (not timeoutMs)
test('postJson third positional arg is deadlineMs (not timeoutMs)', async () => {
  await withServer(
    (req, res) => {
      // Never respond
    },
    async (base) => {
      try {
        await postJson(`${base}/api/generate`, { a: 1 }, 200);
        assert.fail('expected reject');
      } catch (e) {
        assert.equal(e.code, OLLAMA_ERROR_CODES.TIMEOUT);
        assert.equal(e.deadlineMs, 200, 'deadlineMs metadata should be preserved');
      }
    }
  );
});

test('postJsonStream third positional arg is deadlineMs (not timeoutMs)', async () => {
  await withServer(
    (req, res) => {
      // Never respond
    },
    async (base) => {
      try {
        await postJsonStream(`${base}/api/chat`, { messages: [] }, 200, undefined, () => {});
        assert.fail('expected reject');
      } catch (e) {
        assert.equal(e.code, OLLAMA_ERROR_CODES.TIMEOUT);
        assert.equal(e.deadlineMs, 200, 'deadlineMs metadata should be preserved');
      }
    }
  );
});
