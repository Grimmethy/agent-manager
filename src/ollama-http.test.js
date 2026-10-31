'use strict';

// Unit tests for postJson()'s extraHeaders param -- the mechanism local-client.js uses
// to send a stable X-TokenFold-Session header (see its own comment for why: without one,
// TokenFold hashes each call's own prompt into a fresh session and can never amortize its
// dictionary bootstrap cost, confirmed live 2026-08-21 at 0.27% real savings).
//
// Run: node --test src/ollama-http.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { postJson, OLLAMA_ERROR_CODES } = require('./ollama-http.js');

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

// Regression, 2026-08-23: 159 blocked tasks all sharing the identical, content-free
// reason "draft call failed 5 times in a row (most recent: )" -- draft_result was truly
// empty on every attempt (not a caught error with a blank message), meaning local-draft.js's
// node process was dying outright before ever reaching its own process.stdout.write. Root
// cause: `res` (the response stream) had no 'error' listener -- only `req` did -- so a
// connection reset arriving after headers but mid-body threw as an uncaught exception
// instead of rejecting the postJson() promise. Doubly bad: an empty message never matches
// local-worker.sh's INFRA_FAILURE_PATTERN regex, so every one of these permanently blocked
// instead of qualifying for the bounded infra-requeue path a real "ECONNRESET"-bearing
// Error would have gotten.
test('postJson rejects (rather than crashing the process) when the response stream errors mid-body', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"partial":'); // headers sent, body started, then abort before it's valid JSON
        res.destroy(new Error('simulated ECONNRESET mid-body'));
      });
    },
    async (base) => {
      await assert.rejects(() => postJson(`${base}/api/generate`, { a: 1 }, 5000));
    }
  );
});

// 2026-09-08, Second Brain [[dspy]] research applied: this session diagnosed 3 completely
// different root causes that all surfaced as the identical generic "Ollama request timed
// out" message, each needing a fresh multi-hour live investigation to tell apart. These
// tests confirm every real failure path now carries a distinguishing `code`, so a future
// occurrence is a `grep` away from knowing which known class it is.
test('postJson tags a non-200 response with OLLAMA_HTTP_ERROR and the real statusCode', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"down"}'); });
    },
    async (base) => {
      try {
        await postJson(`${base}/api/generate`, { a: 1 }, 5000);
        assert.fail('must reject');
      } catch (e) {
        assert.equal(e.code, OLLAMA_ERROR_CODES.HTTP_ERROR);
        assert.equal(e.statusCode, 503);
      }
    }
  );
});

test('postJson tags an unparseable 200 response with OLLAMA_BAD_JSON', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('not json'); });
    },
    async (base) => {
      try {
        await postJson(`${base}/api/generate`, { a: 1 }, 5000);
        assert.fail('must reject');
      } catch (e) {
        assert.equal(e.code, OLLAMA_ERROR_CODES.BAD_JSON);
      }
    }
  );
});

test('postJson tags a mid-body disconnect with a distinguishing code (STREAM_ERROR or CONNECTION_ERROR -- Node routes a server-destroyed socket through either depending on timing, never left untagged)', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"partial":');
        res.destroy(new Error('simulated ECONNRESET mid-body'));
      });
    },
    async (base) => {
      try {
        await postJson(`${base}/api/generate`, { a: 1 }, 5000);
        assert.fail('must reject');
      } catch (e) {
        assert.ok(
          [OLLAMA_ERROR_CODES.STREAM_ERROR, OLLAMA_ERROR_CODES.CONNECTION_ERROR].includes(e.code),
          `expected a mid-transfer disconnect code, got ${e.code}`,
        );
      }
    }
  );
});

test('postJson tags a deadline expiry with OLLAMA_TIMEOUT and the real deadlineMs', async () => {
  await withServer(
    (req, res) => {
      // never respond -- forces the deadline timer to fire
    },
    async (base) => {
      try {
        await postJson(`${base}/api/generate`, { a: 1 }, 200);
        assert.fail('must reject');
      } catch (e) {
        assert.equal(e.code, OLLAMA_ERROR_CODES.TIMEOUT);
        assert.equal(e.deadlineMs, 200);
      }
    }
  );
});

test('postJson tags a request-level connection error (nothing listening) with OLLAMA_CONNECTION_ERROR', async () => {
  try {
    await postJson('http://127.0.0.1:1/api/generate', { a: 1 }, 5000); // port 1 -- guaranteed nothing listens
    assert.fail('must reject');
  } catch (e) {
    assert.equal(e.code, OLLAMA_ERROR_CODES.CONNECTION_ERROR);
    assert.ok(e.nodeCode, 'the underlying Node error code (e.g. ECONNREFUSED) is preserved');
  }
});

// Subtask 1 reproduction (HUB0282/3/3): three fake-server cases that expose the
// root cause of the chat-and-lane hang on a closed connection. The current postJson()
// uses Node's `http.request` `timeout` option -- a SOCKET IDLE timeout that RESETS
// on any received byte. This is NOT a hard deadline from call start: a server that
// keeps the socket "alive" by sending bytes (even one every 10s) prevents the timer
// from ever firing, causing an unconditional hang. Cases (a) and (b) currently reject
// (confirming the existing error paths work); case (c) hangs, reproducing the live
// incident this task decompose was built from.
//
// Each test has a 5s node:test timeout so the hang case is observable (the test
// framework reports "exceeded timeout" rather than passing silently).
test('premature close: server sends headers + partial chunked body then closes TCP without final chunk → rejects (STREAM_ERROR or CONNECTION_ERROR)', { timeout: 5000 }, async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        // Send chunked headers + ONE chunk, then close without the terminating 0\r\n\r\n
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        });
        res.write('1a\r\n{"partial":'); // 0x1a = 26 bytes of payload
        // Deliberately do NOT write the final '0\r\n\r\n' -- the socket just dies
        res.destroy(new Error('simulated premature close after partial chunked body'));
      });
    },
    async (base) => {
      try {
        await postJson(`${base}/api/generate`, { a: 1 }, 5000);
        assert.fail('expected reject on premature close');
      } catch (e) {
        // Current behavior: Node routes a server-destroyed socket through either
        // STREAM_ERROR (mid-body error on res) or CONNECTION_ERROR (socket error
        // propagating via req); the point of this test is that it REJECTS, not hangs.
        assert.ok(
          [OLLAMA_ERROR_CODES.STREAM_ERROR, OLLAMA_ERROR_CODES.CONNECTION_ERROR].includes(e.code),
          `expected reject with STREAM_ERROR or CONNECTION_ERROR on premature close, got code=${e.code} msg=${e.message}`,
        );
      }
    }
  );
});

test('silent server: server accepts TCP connection and sends nothing → rejects with OLLAMA_TIMEOUT via deadlineMs', { timeout: 5000 }, async () => {
  await withServer(
    (req, res) => {
      // Accept the connection but never write anything -- the deadline timer fires
      // regardless of server activity (unlike socket idle timeout which resets).
      req.on('data', () => {}); // consume the body so the request completes
    },
    async (base) => {
      try {
        await postJson(`${base}/api/generate`, { a: 1 }, 500);
        assert.fail('expected reject on silent server');
      } catch (e) {
        assert.equal(e.code, OLLAMA_ERROR_CODES.TIMEOUT,
          `expected OLLAMA_TIMEOUT on silent server, got code=${e.code} msg=${e.message}`);
        assert.equal(e.deadlineMs, 500, 'deadlineMs metadata should be preserved');
      }
    }
  );
});

// FIXED: With deadlineMs (hard deadline from call start), a slow server that sends
// bytes periodically CANNOT prevent the timeout from firing. The deadline timer is
// independent of socket activity.
test('slow server (1 byte / 10s): deadlineMs fires regardless of activity → rejects with TIMEOUT', { timeout: 5000 }, async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {}); // consume the body so request "completes" on the wire
      // Send one byte every 10 seconds forever -- never enough to complete the response,
      // but enough to keep the socket "alive". With deadlineMs, this does NOT prevent
      // the timeout from firing.
      const interval = setInterval(() => { res.write('x'); }, 10000);
      // We never clear the interval and never end -- the server is intentionally
      // designed to test that deadlineMs is a hard deadline.
    },
    async (base) => {
      // deadlineMs (200ms) is much shorter than the 10s interval, so the deadline
      // will fire before the server can send another byte.
      try {
        await postJson(`${base}/api/generate`, { a: 1 }, 200);
        assert.fail('expected reject on deadline expiry');
      } catch (e) {
        assert.equal(e.code, OLLAMA_ERROR_CODES.TIMEOUT,
          `expected OLLAMA_TIMEOUT on slow server, got code=${e.code} msg=${e.message}`);
        assert.equal(e.deadlineMs, 200, 'deadlineMs metadata should be preserved');
      }
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

// New test: deadlineMs omitted (undefined) produces no setTimeout and completes normally
test('postJson with no deadlineMs completes normally on fast server', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    },
    async (base) => {
      const result = await postJson(`${base}/api/generate`, { a: 1 });
      assert.deepEqual(result, { ok: true });
    }
  );
});

// New test: deadlineMs with a server that responds in time does not reject
test('postJson with deadlineMs that is not exceeded resolves normally', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        // Respond quickly (well within the 5000ms deadline)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    },
    async (base) => {
      const result = await postJson(`${base}/api/generate`, { a: 1 }, 5000);
      assert.deepEqual(result, { ok: true });
    }
  );
});

// New test: deadlineMs expiry rejects with TIMEOUT
test('postJson with deadlineMs that IS exceeded rejects with TIMEOUT', async () => {
  await withServer(
    (req, res) => {
      // Never respond -- deadline will fire
    },
    async (base) => {
      try {
        await postJson(`${base}/api/generate`, { a: 1 }, 100);
        assert.fail('expected reject on deadline expiry');
      } catch (e) {
        assert.equal(e.code, OLLAMA_ERROR_CODES.TIMEOUT);
        assert.equal(e.deadlineMs, 100);
      }
    }
  );
});
