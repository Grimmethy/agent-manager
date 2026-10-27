'use strict';

// A task with promptContext.imagePaths reaches Ollama with those pictures on every local call
// (lib/task-images.js), and an unreadable picture blocks the draft instead of dropping silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('resolveDraftContext sends the task images; a missing image throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-images-'));
  const img = path.join(dir, 's.png');
  fs.writeFileSync(img, Buffer.from('PNGDATA'));
  let body;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200); res.end('{"models":[]}'); return; }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { body = JSON.parse(raw); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ response: 'ok', done: true, eval_count: 1, eval_duration: 1e9 })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.LOCAL_MODEL = 'test-model';
  process.env.ORNITH_TIMEOUT_MS = '5000';
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = path.join(dir, 'pipeline');
  for (const m of ['../local-client.js', '../model-provider.js', './draft-context.js']) delete require.cache[require.resolve(m)];
  try {
    const { resolveDraftContext } = require('./draft-context.js');
    const task = { id: 't1', source: 'sprite_describe', domain: 'character_content', promptContext: { imagePaths: [img] } };
    const { resolvedLocalCall } = resolveDraftContext(task, { localCall: null, withLockFn: (k, fn) => fn() });
    await resolvedLocalCall({ prompt: 'describe', think: false });
    assert.deepEqual(body.images, [Buffer.from('PNGDATA').toString('base64')]);
    assert.throws(() => resolveDraftContext({ ...task, promptContext: { imagePaths: [path.join(dir, 'gone.png')] } }, { localCall: null, withLockFn: (k, fn) => fn() }), /unreadable/);
  } finally { server.close(); }
});
