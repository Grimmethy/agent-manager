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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    // GET /api/ps is routed away from `handler` as a harmless no-op in case anything
    // ever probes it again -- local-client.js no longer makes this call itself (removed
    // 2026-08-23 alongside the num_ctx pin: see gpu-capacity.js's PINNED_NUM_CTX and
    // local-client.js's own comment on why a per-call live VRAM read was actively
    // harmful), kept here only so a future caller of it doesn't silently perturb a
    // test's own POST /api/generate request-count expectations.
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

// --- done_reason:"length" truncation detection (2026-09-05) -------------------------
// Root-caused a real blocked-task cluster (pipeline_forensics_fix AC-4/6/8/20): a plan
// pass came back non-empty, real-looking text that just stopped mid-sentence (Ollama
// reached num_predict before a natural stop, likely think:true reasoning eating the
// budget) -- detectDegenerate never looked at done_reason at all, so this sailed through
// as a valid, complete plan and fed implement nothing coherent to work from.

test('call() treats a done_reason:"length" response as degenerate ("truncated") and retries, succeeding on a later attempt', async () => {
  let requestCount = 0;
  await withServer(
    (req, res) => {
      requestCount += 1;
      req.on('data', () => {});
      req.on('end', () => {
        if (requestCount === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response: '**Scope:** `src/x.js` only. No other', done: true, done_reason: 'length', eval_count: 1200 }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse('a real, complete response that reached its own natural stop.'));
      });
    },
    async (base) => {
      const { call } = freshLocalClient(base);
      const result = await call({ prompt: 'x', think: false }, 2);
      assert.equal(result.degenerate, null);
      assert.equal(result.response, 'a real, complete response that reached its own natural stop.');
      assert.equal(requestCount, 2, 'the truncated first attempt must have been retried, not accepted as final');
    }
  );
});

test('call() returns degenerate:"truncated" (not a false "fine" verdict) when every retry also hits done_reason:"length"', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'a plausible-looking sentence that never finishes because', done: true, done_reason: 'length', eval_count: 1200 }));
      });
    },
    async (base) => {
      const { call } = freshLocalClient(base);
      const result = await call({ prompt: 'x', think: false }, 1);
      assert.equal(result.degenerate, 'truncated');
    }
  );
});

// 2026-09-06: logDegenerateAudit's first real production data showed the gap this fixes
// -- two brain-dump-spawned adhoc plan passes each hit done_reason:"length" on ALL 3
// attempts with eval_count === numPredict every time, identically, because the retry
// loop above called with the exact same numPredict each attempt: a fixed ceiling on the
// same prompt reproduces the same cutoff deterministically, so an identical retry has
// zero chance of a different outcome. Proves the retry loop actually escalates
// numPredict after a truncated attempt, not just that it eventually gives up correctly.
test('call() escalates numPredict on a retry after a "truncated" (done_reason:"length") attempt, not just repeating the same ceiling', async () => {
  const capturedNumPredicts = [];
  await withServer(
    (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        capturedNumPredicts.push(body.options.num_predict);
        if (capturedNumPredicts.length < 3) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response: 'still reasoning, never finishes because', done: true, done_reason: 'length', eval_count: body.options.num_predict }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse('a real, complete response that finally finished.'));
      });
    },
    async (base) => {
      const { call } = freshLocalClient(base);
      const result = await call({ prompt: 'x', think: false, numPredict: 1000 }, 2);
      assert.equal(result.degenerate, null);
      assert.deepEqual(capturedNumPredicts, [1000, 2000, 4000], 'each truncated retry must double the prior numPredict, not repeat it');
    }
  );
});

test('call() caps the escalated numPredict at the ceiling rather than growing unbounded', async () => {
  const capturedNumPredicts = [];
  await withServer(
    (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        capturedNumPredicts.push(body.options.num_predict);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'still truncating', done: true, done_reason: 'length', eval_count: body.options.num_predict }));
      });
    },
    async (base) => {
      const { call } = freshLocalClient(base);
      const result = await call({ prompt: 'x', think: false, numPredict: 6000 }, 2);
      assert.equal(result.degenerate, 'truncated');
      assert.deepEqual(capturedNumPredicts, [6000, 8000, 8000], 'must clamp at the ceiling (8000), never exceed it');
    }
  );
});

test('call() does NOT escalate numPredict on a non-truncation degenerate (e.g. empty) -- only "truncated" gets the ceiling bump', async () => {
  const capturedNumPredicts = [];
  await withServer(
    (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        capturedNumPredicts.push(body.options.num_predict);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse(''));
      });
    },
    async (base) => {
      const { call } = freshLocalClient(base);
      const result = await call({ prompt: 'x', think: false, numPredict: 1000 }, 1);
      assert.equal(result.degenerate, 'empty');
      assert.deepEqual(capturedNumPredicts, [1000, 1000], 'an empty-response retry has no ceiling to escalate away from');
    }
  );
});

test('call() does NOT flag a genuinely complete response (done_reason:"stop") as truncated', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'a real, complete response.', done: true, done_reason: 'stop', eval_count: 10 }));
      });
    },
    async (base) => {
      const { call } = freshLocalClient(base);
      const result = await call({ prompt: 'x', think: false }, 0);
      assert.equal(result.degenerate, null);
      assert.equal(result.response, 'a real, complete response.');
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

// Regression, 2026-08-23: Grimmethy: "Are there opportunities to make the actual review
// more efficient?" -- majorityVote() always ran all n votes even once 2 of 3 already
// agreed, paying for a 3rd real generation call whose result could never change the
// outcome (2 already meets minAgreeing -- a 3rd vote can at best add to the winner, at
// worst start a losing count that still can't overtake it). This proves the 3rd call is
// now skipped entirely, not just that its result is ignored.
test('majorityVote() stops calling once 2 of 3 votes already agree -- the 3rd call never happens', async () => {
  let requestCount = 0;
  await withServer(
    (req, res) => {
      requestCount += 1;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse('APPROVE'));
      });
    },
    async (base) => {
      const { majorityVote } = freshLocalClient(base);
      const classify = (text) => (text.includes('APPROVE') ? 'approve' : null);
      const result = await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 });
      assert.equal(requestCount, 2, 'only 2 calls should have happened -- the 3rd is provably unnecessary once 2 agree');
      assert.equal(result.realVoteCount, 2);
      assert.equal(result.requestedVotes, 3);
      assert.equal(result.verdict, 'approve');
      assert.equal(result.confident, true);
    }
  );
});

// Regression, 2026-08-24: model/numCtx/numPredict were silently dropped by majorityVote()
// -- a model-profile-registry.js profile naming a specific model/context/output-length had
// no way to actually reach a vote, since majorityVote is the only caller of call() review
// uses. Proves the override actually reaches the real HTTP request body, not just that the
// param is accepted without erroring.
test('majorityVote() forwards model/numCtx/numPredict overrides into the real request body', async () => {
  let capturedBody = null;
  await withServer(
    (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        capturedBody = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse('APPROVE'));
      });
    },
    async (base) => {
      const { majorityVote } = freshLocalClient(base);
      const classify = (text) => (text.includes('APPROVE') ? 'approve' : null);
      await majorityVote({
        prompt: 'x', classify, n: 3, minAgreeing: 2,
        model: 'qwen2.5:3b', numCtx: 8192, numPredict: 400,
      });
      assert.equal(capturedBody.model, 'qwen2.5:3b', 'must override the module-level LOCAL_MODEL default');
      assert.equal(capturedBody.options.num_ctx, 8192, 'must override PINNED_NUM_CTX');
      assert.equal(capturedBody.options.num_predict, 400);
    }
  );
});

test('majorityVote() falls back to the module default model when no override is given', async () => {
  let capturedBody = null;
  await withServer(
    (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        capturedBody = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse('APPROVE'));
      });
    },
    async (base) => {
      const { majorityVote } = freshLocalClient(base);
      const classify = (text) => (text.includes('APPROVE') ? 'approve' : null);
      await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 }); // no model/numCtx/numPredict passed
      assert.equal(capturedBody.model, 'test-model', 'must fall back to LOCAL_MODEL when no profile override is given');
      assert.equal(capturedBody.options.num_ctx, 24576, 'must fall back to PINNED_NUM_CTX when no profile override is given');
    }
  );
});

test('majorityVote() does NOT early-exit when only 1 vote has landed so far', async () => {
  let requestCount = 0;
  await withServer(
    (req, res) => {
      requestCount += 1;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(generateResponse(requestCount === 1 ? 'APPROVE' : 'REJECT'));
      });
    },
    async (base) => {
      const { majorityVote } = freshLocalClient(base);
      const classify = (text) => (text.includes('APPROVE') ? 'approve' : text.includes('REJECT') ? 'reject' : null);
      const result = await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 });
      assert.equal(requestCount, 3, 'a single vote (count=1) must not trigger the early-exit -- all 3 calls still happen since nothing reached minAgreeing until the 3rd');
      assert.equal(result.verdict, 'reject'); // 2 REJECT vs 1 APPROVE
      assert.equal(result.confident, true);
    }
  );
});

// 2026-09-08, Second Brain [[dspy]] research applied: end-to-end confirmation that a real
// hard call failure gets tagged and logged with a distinguishing code, not just re-thrown
// silently. Uses its own real AGENT_MANAGER_REPO_ROOT (unlike freshLocalClient above,
// which deliberately sets '' to skip the in-flight lock) so instances/pipeline-history.log
// actually has somewhere to write. That log is the unified, type-discriminated stream
// (pipeline-history.js) every audit log in this codebase now writes into.
test('call() logs a tagged hard-failure entry to the unified pipeline-history.log on every failed attempt', async () => {
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"always down"}'); });
    },
    async (base) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-client-hard-failure-test-'));
      process.env.OLLAMA_URL = base;
      process.env.LOCAL_MODEL = 'test-model';
      process.env.ORNITH_TIMEOUT_MS = '5000';
      process.env.AGENT_MANAGER_REPO_ROOT = dir;
      process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
      delete require.cache[require.resolve('./local-client.js')];
      const { call } = require('./local-client.js');

      await assert.rejects(() => call({ prompt: 'x', think: false, source: 'pipeline_debrief', taskId: 't1', stage: 'implement' }, 1));

      const logPath = path.join(dir, 'instances', 'pipeline-history.log');
      assert.ok(fs.existsSync(logPath), 'the unified pipeline history log must exist after every attempt fails');
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(lines.length, 2, 'one line per attempt (maxRetries=1 means 2 attempts total)');
      for (const line of lines) {
        assert.equal(line.type, 'hard-failure');
        assert.equal(line.code, 'OLLAMA_HTTP_ERROR');
        assert.equal(line.statusCode, 503);
        assert.equal(line.source, 'pipeline_debrief');
        assert.equal(line.stage, 'implement');
      }
    }
  );
});
