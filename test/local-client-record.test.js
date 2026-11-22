'use strict';

// HUB0280-02: local-client.js call() records a model_calls row for a call whose caller does not (reviewer votes, needs-clarification
// triage votes), exactly once and best-effort. Ollama is a local stub server; model-stats-client.recordCall is replaced by a spy so no
// sqlite subprocess runs and nothing touches a real model-stats.db.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const statsClient = require('../src/model-stats-client.js');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/ps') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"models":[]}'); return; }
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', async () => {
      try { await fn(`http://127.0.0.1:${server.address().port}`); resolve(); } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}

function freshLocalClient(baseUrl) {
  process.env.OLLAMA_URL = baseUrl;
  process.env.LOCAL_MODEL = 'test-model';
  process.env.ORNITH_TIMEOUT_MS = '5000';
  process.env.AGENT_MANAGER_REPO_ROOT = '';
  delete require.cache[require.resolve('../src/local-client.js')];
  return require('../src/local-client.js');
}

function okServer(text = 'APPROVE') {
  return (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: text, done: true, prompt_eval_count: 120, eval_count: 10, eval_duration: 1e9 }));
    });
  };
}

async function withSpy(fn) {
  const calls = [];
  const original = statsClient.recordCall;
  statsClient.recordCall = (row) => { calls.push(row); return 'id'; };
  try { await fn(calls); } finally { statsClient.recordCall = original; }
}

test('a review-vote call records one row with the call tokens, model, source and a latency', async () => {
  await withSpy(async (calls) => {
    await withServer(okServer(), async (base) => {
      const { call } = freshLocalClient(base);
      await call({ prompt: 'x', think: false, taskId: 'T1', stage: 'review-vote', source: 'manual' }, 1);
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].taskId, 'T1');
    assert.equal(calls[0].stage, 'review-vote');
    assert.equal(calls[0].model, 'test-model');
    assert.equal(calls[0].source, 'manual');
    assert.equal(calls[0].result.prompt_eval_count, 120);
    assert.equal(calls[0].result.eval_count, 10);
    assert.ok(calls[0].latencyMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(calls[0].startedAt)));
  });
});

test('majorityVote records each vote it makes and none it skips after the early exit', async () => {
  await withSpy(async (calls) => {
    await withServer(okServer('APPROVE'), async (base) => {
      const { majorityVote } = freshLocalClient(base);
      const classify = (t) => (/APPROVE/.test(t) ? 'APPROVE' : null);
      const out = await majorityVote({ prompt: 'p', classify, n: 3, minAgreeing: 2, taskId: 'T2', stage: 'nc-triage-premise-vote' });
      assert.equal(out.verdict, 'APPROVE');
    });
    assert.equal(calls.length, 2, '2 of 3 agree, so the third vote is never made and never recorded');
    assert.ok(calls.every((c) => c.taskId === 'T2' && c.stage === 'nc-triage-premise-vote'));
  });
});

test('stages the callers already record are NOT recorded by call()', async () => {
  await withSpy(async (calls) => {
    await withServer(okServer(), async (base) => {
      const { call, CALLER_RECORDED_STAGES } = freshLocalClient(base);
      for (const stage of CALLER_RECORDED_STAGES) await call({ prompt: 'x', think: false, taskId: 'T3', stage }, 0);
    });
    assert.equal(calls.length, 0);
  });
});

test('a call without a taskId or without a stage records nothing', async () => {
  await withSpy(async (calls) => {
    await withServer(okServer(), async (base) => {
      const { call } = freshLocalClient(base);
      await call({ prompt: 'x', think: false, stage: 'review-vote' }, 0);
      await call({ prompt: 'x', think: false, taskId: 'T4' }, 0);
    });
    assert.equal(calls.length, 0);
  });
});

test('a degenerate result is not recorded', async () => {
  await withSpy(async (calls) => {
    await withServer(okServer(''), async (base) => {
      const { call } = freshLocalClient(base);
      const r = await call({ prompt: 'x', think: false, taskId: 'T5', stage: 'review-vote' }, 0);
      assert.equal(r.degenerate, 'empty');
    });
    assert.equal(calls.length, 0);
  });
});

test('a recordCall that throws never breaks the call', async () => {
  const original = statsClient.recordCall;
  statsClient.recordCall = () => { throw new Error('db locked'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withServer(okServer(), async (base) => {
      const { call } = freshLocalClient(base);
      const r = await call({ prompt: 'x', think: false, taskId: 'T6', stage: 'review-vote' }, 0);
      assert.equal(r.response, 'APPROVE');
    });
  } finally { statsClient.recordCall = original; console.warn = warn; }
});

test('every stage in CALLER_RECORDED_STAGES really appears as a stage string in the caller sources', () => {
  const src = ['src/local-draft.js', 'src/lib/implement-critique.js', 'src/local-agentic-write-draft.js', 'src/research-agentic-draft.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  const { CALLER_RECORDED_STAGES } = freshLocalClient('http://127.0.0.1:1');
  for (const stage of CALLER_RECORDED_STAGES) assert.ok(src.includes(`'${stage}'`), `no caller passes stage '${stage}'`);
});

test('the reviewer vote call in review-task.js passes the task id and the review-vote stage', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/review-task.js'), 'utf8');
  const i = src.indexOf('await resolvedMajorityVote({');
  assert.ok(i > 0);
  const block = src.slice(i, src.indexOf('});', i));
  assert.match(block, /taskId: task\.id/);
  assert.match(block, /stage: 'review-vote'/);
});
