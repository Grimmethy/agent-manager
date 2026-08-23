'use strict';

// Focused tests for call()'s and majorityVote()'s resilience to a hard call failure
// (network error / non-200 / timeout -- anything that makes postJson() reject), added
// alongside the 2026-08-23 fix (Grimmethy: "Why are 17 tasks sitting in review instead of
// being processed fully?"): review-runner's majorityVote() was aborting its ENTIRE 3-vote
// call the instant the FIRST vote's callOnce() rejected, discarding whatever votes might
// otherwise have succeeded -- confirmed live: 59 of the last 62 real review attempts
// failed this exact way. Uses a real local HTTP stub server (same pattern as
// ollama-http.test.js) rather than a real Ollama instance -- a non-200 response is enough
// to make postJson() reject the same way a real network failure does, without needing to
// wait out a real timeout.
//
// local-client.js reads OLLAMA_URL/LOCAL_MODEL into module-level consts at require time,
// so every test here sets the env vars THEN clears the require cache and re-requires
// fresh -- same convention local-draft.test.js's withFixtureRepo already establishes for
// the same reason.
//
// Run: node --test src/local-client-resilience.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    // getCapacitySnapshot() (local-client.js) fires a real GET /api/ps against
    // OLLAMA_URL before every callOnce() when nvidia-smi is available (it is, in this
    // sandbox) -- routed away from `handler` entirely so it never perturbs a test's own
    // POST /api/generate request-count expectations. Its content doesn't matter
    // (queryLoadedModel's own parse failure just resolves to null capacity, a no-op).
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/ps') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"models":[]}');
        return;
      }
      handler(req, res);
    });
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

function freshLocalClient(baseUrl) {
  process.env.OLLAMA_URL = baseUrl;
  process.env.LOCAL_MODEL = 'test-model';
  process.env.ORNITH_TIMEOUT_MS = '5000'; // keep any real-timeout path fast, not the point of these tests
  process.env.AGENT_MANAGER_REPO_ROOT = ''; // resolveInstancesDir() returns null -- no real lock file needed
  delete require.cache[require.resolve('./local-client.js')];
  return require('./local-client.js');
}

// Ollama's real /api/generate response shape, trimmed to what callOnce() actually reads.
function generateResponse(text) {
  return JSON.stringify({ response: text, done: true, eval_count: 10, eval_duration: 1e9 });
}

test('call() retries a hard failure (non-200) within its own budget and succeeds on a later attempt', async () => {
  let requestCount = 0;
  await withServer(
    (req, res) => {
      requestCount += 1;
      req.on('data', () => {});
      req.on('end', () => {
        if (requestCount === 1) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"simulated failure"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse('a real, fine response'));
      });
    },
    async (base) => {
      const { call } = freshLocalClient(base);
      const result = await call({ prompt: 'x', think: false }, 2);
      assert.equal(result.degenerate, null);
      assert.equal(result.response, 'a real, fine response');
      assert.equal(requestCount, 2, 'the first hard failure must have been retried, not thrown immediately');
    }
  );
});

test('call() throws the real error when EVERY attempt hard-fails (no response ever landed)', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end('{"error":"always down"}');
      });
    },
    async (base) => {
      const { call } = freshLocalClient(base);
      await assert.rejects(() => call({ prompt: 'x', think: false }, 1), /503/);
    }
  );
});

test('call() does NOT throw when an earlier attempt hard-failed but a later attempt returned a real (even degenerate) response', async () => {
  let requestCount = 0;
  await withServer(
    (req, res) => {
      requestCount += 1;
      req.on('data', () => {});
      req.on('end', () => {
        if (requestCount === 1) {
          res.writeHead(500);
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse('')); // a real response, but degenerate (empty)
      });
    },
    async (base) => {
      const { call } = freshLocalClient(base);
      const result = await call({ prompt: 'x', think: false }, 1);
      assert.equal(result.degenerate, 'empty');
      assert.equal(result.response, '');
    }
  );
});

test('majorityVote() does not abort the whole vote when one vote hard-fails -- the other votes still count', async () => {
  let requestCount = 0;
  await withServer(
    (req, res) => {
      requestCount += 1;
      req.on('data', () => {});
      req.on('end', () => {
        // Vote 1 hard-fails outright (both of call()'s own maxRetries=1 attempts fail);
        // votes 2 and 3 succeed with a real, classifiable response.
        if (requestCount <= 2) {
          res.writeHead(500);
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse('APPROVE'));
      });
    },
    async (base) => {
      const { majorityVote } = freshLocalClient(base);
      const classify = (text) => (text.includes('APPROVE') ? 'approve' : null);
      const result = await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 });
      assert.equal(result.realVoteCount, 2, 'the 2 surviving votes must both count');
      assert.equal(result.voteErrors.length, 1, 'the hard-failed vote is recorded, not silently dropped');
      assert.equal(result.verdict, 'approve');
      assert.equal(result.confident, true);
    }
  );
});

test('majorityVote() throws (does not return a false "inconclusive" verdict) when EVERY vote hard-fails', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(503);
        res.end('{}');
      });
    },
    async (base) => {
      const { majorityVote } = freshLocalClient(base);
      const classify = (text) => (text.includes('APPROVE') ? 'approve' : null);
      await assert.rejects(() => majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 }), /503/);
    }
  );
});

test('majorityVote() reaches a real "no consensus" verdict (not a throw) when all votes succeed but genuinely disagree', async () => {
  const responses = ['APPROVE', 'REJECT', 'APPROVE'];
  let requestCount = 0;
  await withServer(
    (req, res) => {
      const text = responses[requestCount] || 'APPROVE';
      requestCount += 1;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse(text));
      });
    },
    async (base) => {
      const { majorityVote } = freshLocalClient(base);
      const classify = (text) => (text.includes('APPROVE') ? 'approve' : text.includes('REJECT') ? 'reject' : null);
      const result = await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 });
      assert.equal(result.realVoteCount, 3);
      assert.equal(result.voteErrors.length, 0);
      assert.equal(result.verdict, 'approve'); // 2 APPROVE vs 1 REJECT -- still a real majority
      assert.equal(result.confident, true);
    }
  );
});
