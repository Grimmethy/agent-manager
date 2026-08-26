'use strict';

// Regression test for runPlanWithTools()'s rollback-on-poisoned-history behavior
// (2026-08-26, Grimmethy: "no user query found in messages" investigation). Confirmed
// live (see local-tool-client.js's own comment on this) that this specific Ollama error
// is NOT a live-inference race -- it's a corrupted STORED history (a tool-call-only turn
// leaves an unclosed <think> block behind), so replaying the identical messages array
// fails deterministically no matter how many times it's retried unchanged. The only fix
// is dropping the poisoned prior turn and making the model regenerate it fresh.
//
// Uses a real local HTTP stub server (same pattern as local-client-resilience.test.js)
// standing in for Ollama's /api/chat, not a real Ollama instance.
//
// Run: node --test src/local-tool-client-flake-rollback.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function freshLocalToolClient(baseUrl, repoRoot) {
  process.env.OLLAMA_URL = baseUrl;
  process.env.LOCAL_MODEL = 'test-model';
  process.env.LOCAL_TIMEOUT_MS = '5000';
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  fs.mkdirSync(path.join(repoRoot, 'instances'), { recursive: true });
  delete require.cache[require.resolve('./local-tool-client.js')];
  delete require.cache[require.resolve('./config.js')];
  return require('./local-tool-client.js');
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(JSON.parse(data || '{}')));
  });
}

function chatOk(message) {
  return JSON.stringify({ message, done: true });
}

const NO_USER_QUERY_BODY = '{"error":"no user query found in messages"}';

test('a poisoned prior turn is rolled back and regenerated, not endlessly retried unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tool-client-rollback-test-'));
  let requestCount = 0;
  const requestMessageCounts = [];

  await withServer(
    async (req, res) => {
      requestCount += 1;
      const body = await readJsonBody(req);
      requestMessageCounts.push(body.messages.length);

      if (requestCount === 1) {
        // Turn 0: a tool-call-only response (empty content, just tool_calls) -- the
        // shape that (per the real Ollama bug) can leave the rendered history poisoned.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(chatOk({ role: 'assistant', content: '', tool_calls: [
          { function: { name: 'list_directory', arguments: { path: '.' } } },
        ] }));
        return;
      }
      if (requestCount >= 2 && requestCount <= 1 + 3) {
        // Turn 1, all CHAT_FLAKE_MAX_ATTEMPTS (3) immediate retries: deterministically
        // fails, unchanged, exactly like the real bug.
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(NO_USER_QUERY_BODY);
        return;
      }
      // After rollback, the model is asked to redo turn 0 fresh -- this time it just
      // answers directly (no tool call), same as a re-sampled response plausibly would.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(chatOk({ role: 'assistant', content: 'Recovered answer.' }));
    },
    async (base) => {
      const { runPlanWithTools } = freshLocalToolClient(base, dir);
      const result = await runPlanWithTools({
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'List the repo root.' },
        ],
        maxTurns: 10,
      });

      assert.equal(result.response, 'Recovered answer.');
      // The tool call recorded during the discarded (poisoned) turn 0 attempt must not
      // survive into the final log -- it was rolled back along with the messages that
      // carried it, not just silently left dangling.
      assert.equal(result.toolCallLog.length, 0);
      // 1 (poisoned turn 0) + 3 (exhausted retries on turn 1) + 1 (regenerated turn 0) = 5
      assert.equal(requestCount, 5);
      // The regenerated call must actually be smaller than the poisoned one it replaced
      // -- i.e. a REAL rollback happened, not just "keep retrying the same growing array".
      assert.ok(requestMessageCounts[4] <= requestMessageCounts[1]);
    }
  );
});

test('a flake on the very first turn (no prior turn to roll back) still throws, not loops forever', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tool-client-rollback-test-'));
  let requestCount = 0;

  await withServer(
    (req, res) => {
      requestCount += 1;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(NO_USER_QUERY_BODY);
      });
    },
    async (base) => {
      const { runPlanWithTools } = freshLocalToolClient(base, dir);
      await assert.rejects(
        () => runPlanWithTools({
          messages: [{ role: 'user', content: 'Hello' }],
          maxTurns: 10,
        }),
        /no user query found in messages/i
      );
      // Only CHAT_FLAKE_MAX_ATTEMPTS (3) -- no prior turn exists to roll back to, so it
      // must give up and throw rather than spin.
      assert.equal(requestCount, 3);
    }
  );
});
