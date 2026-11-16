'use strict';

// Every review vote records who cast it (feature cloud-agent-pool, FF-2b): majorityVote() in local-client.js adds `provider` ('cloud' when OLLAMA_URL is a cloud-providers gateway lane,
// else 'ollama') and `model` (the model the pass used) to each vote, next to the existing `verdict` and `response`. Same real HTTP stub pattern as local-client-resilience.test.js;
// local-client.js reads OLLAMA_URL and LOCAL_MODEL at require time, so each test sets them and re-requires fresh.
// Run: node --test src/local-client-vote-tags.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/ps') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: process.env.LOCAL_MODEL }] }));
        return;
      }
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', async () => {
      try { await fn(`http://127.0.0.1:${server.address().port}`); resolve(); } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}

function freshLocalClient(baseUrl, { model = 'test-model', lanes } = {}) {
  process.env.OLLAMA_URL = baseUrl;
  process.env.LOCAL_MODEL = model;
  process.env.ORNITH_TIMEOUT_MS = '5000';
  process.env.AGENT_MANAGER_REPO_ROOT = '';
  if (lanes) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vote-tags-')), 'lanes.json');
    fs.writeFileSync(file, JSON.stringify(lanes));
    process.env.AGENT_MANAGER_LANES_PATH = file;
  } else {
    process.env.AGENT_MANAGER_LANES_PATH = path.join(os.tmpdir(), 'vote-tags-no-such-lanes.json');
  }
  process.env.AGENT_MANAGER_LOCAL_GPU = 'testgpu';
  delete require.cache[require.resolve('./lanes.js')];
  delete require.cache[require.resolve('./local-client.js')];
  return require('./local-client.js');
}

const reply = (text) => JSON.stringify({ response: text, done: true, eval_count: 10, eval_duration: 1e9 });
const approving = (req, res) => { req.on('data', () => {}); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(reply('APPROVE')); }); };
const classify = (text) => (text.includes('APPROVE') ? 'approve' : null);

test('a vote made against a cloud gateway endpoint carries provider cloud and the lane model', async () => {
  await withServer(approving, async (base) => {
    const lanes = [{ gpu: 'cloud', ollamaUrl: base, model: 'claude-haiku-5-5', provider: 'cloud', preempt: 'never' }];
    const { majorityVote } = freshLocalClient(base, { model: 'claude-haiku-5-5', lanes });
    const result = await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 });
    assert.equal(result.votes.length, 2, 'two agreeing votes end the vote early');
    for (const v of result.votes) {
      assert.equal(v.provider, 'cloud');
      assert.equal(v.model, 'claude-haiku-5-5');
      assert.equal(v.verdict, 'approve');
      assert.equal(v.response, 'APPROVE');
    }
  });
});

test('a vote made against an ordinary Ollama endpoint carries provider ollama and the local model', async () => {
  await withServer(approving, async (base) => {
    const { majorityVote } = freshLocalClient(base, { model: 'ornith:35b' });
    const result = await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 });
    for (const v of result.votes) {
      assert.equal(v.provider, 'ollama');
      assert.equal(v.model, 'ornith:35b');
    }
    assert.ok(result.votes.length >= 2);
  });
});

test('an explicit model option wins over LOCAL_MODEL, and a cloud lane on another endpoint does not make this vote cloud', async () => {
  await withServer(approving, async (base) => {
    const lanes = [{ gpu: 'cloud', ollamaUrl: 'http://127.0.0.1:9', model: 'claude-haiku-5-5', provider: 'cloud', preempt: 'never' }];
    const { majorityVote } = freshLocalClient(base, { model: 'ornith:35b', lanes });
    const result = await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2, model: 'explicit-model' });
    for (const v of result.votes) {
      assert.equal(v.provider, 'ollama');
      assert.equal(v.model, 'explicit-model');
    }
  });
});

test('the existing vote keys keep their names and order, the tally is unchanged, and the new keys are only added', async () => {
  await withServer(approving, async (base) => {
    const { majorityVote } = freshLocalClient(base);
    const result = await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 });
    assert.deepEqual(Object.keys(result.votes[0]), ['verdict', 'response', 'provider', 'model']);
    assert.equal(result.verdict, 'approve');
    assert.equal(result.confident, true);
    assert.equal(result.realVoteCount, 2);
  });
});
