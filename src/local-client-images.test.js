'use strict';

// call({ images }) puts base64 pictures in Ollama's /api/generate body (vision tasks, lib/task-images.js);
// without images the body has no `images` key at all. Same stub-server pattern as local-client-resilience.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET') { res.writeHead(200); res.end('{"models":[]}'); return; }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => handler(JSON.parse(raw), res));
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
  delete require.cache[require.resolve('./local-client.js')];
  return require('./local-client.js');
}

const reply = JSON.stringify({ response: 'a pig in a brown coat', done: true, eval_count: 10, eval_duration: 1e9 });

test('images reach the Ollama request body, with the task model', async () => {
  let body;
  await withServer((b, res) => { body = b; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(reply); }, async (base) => {
    const { call } = freshLocalClient(base);
    await call({ prompt: 'describe', think: false, images: ['QUJD'], model: 'qwen3-vl:8b-instruct' }, 0);
  });
  assert.deepEqual(body.images, ['QUJD']);
  assert.equal(body.model, 'qwen3-vl:8b-instruct');
});

test('no images -> no images key', async () => {
  let body;
  await withServer((b, res) => { body = b; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(reply); }, async (base) => {
    const { call } = freshLocalClient(base);
    await call({ prompt: 'x', think: false }, 0);
  });
  assert.equal('images' in body, false);
});
