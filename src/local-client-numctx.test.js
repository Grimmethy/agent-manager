'use strict';
// A caller can never make Ollama restart the model runner by sending a different num_ctx (owner rule 2026-11-07: never swap a model).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = __dirname;
const generateResponse = (t) => JSON.stringify({ response: t, done: true, eval_count: 10, eval_duration: 1e9 });

async function withStub(fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/ps') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'test-model' }] })); return; }
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { seen.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(generateResponse('ok')); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`, seen); } finally { server.close(); }
}

function freshClient(base, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-client-numctx-'));
  Object.assign(process.env, { OLLAMA_URL: base, LOCAL_MODEL: 'test-model', ORNITH_TIMEOUT_MS: '5000', AGENT_MANAGER_REPO_ROOT: dir, AGENT_MANAGER_PIPELINE_DIR: dir });
  delete process.env.AGENT_MANAGER_ALLOW_CALLER_NUM_CTX;
  Object.assign(process.env, env);
  for (const m of ['./local-client.js', './model-resident.js']) { try { delete require.cache[require.resolve(m)]; } catch { /* module not present in this tree */ } }
  return require('./local-client.js');
}

test('a caller-supplied numCtx different from the pinned value is replaced by the pinned value', async () => {
  await withStub(async (base, seen) => {
    const { callOnce } = freshClient(base);
    const pinned = require('./gpu-capacity.js').PINNED_NUM_CTX;
    await callOnce({ prompt: 'x', think: false, numCtx: 8192, source: 'unit-test' });
    assert.equal(seen[seen.length - 1].options.num_ctx, pinned);
    assert.notEqual(pinned, 8192);
  });
});

test('a caller numCtx equal to the pinned value, and no numCtx at all, both send the pinned value', async () => {
  await withStub(async (base, seen) => {
    const { callOnce } = freshClient(base);
    const pinned = require('./gpu-capacity.js').PINNED_NUM_CTX;
    await callOnce({ prompt: 'x', think: false, numCtx: pinned });
    await callOnce({ prompt: 'x', think: false });
    assert.deepEqual(seen.map((b) => b.options.num_ctx), [pinned, pinned]);
  });
});

test('AGENT_MANAGER_ALLOW_CALLER_NUM_CTX=1 restores caller control', async () => {
  await withStub(async (base, seen) => {
    const { callOnce } = freshClient(base, { AGENT_MANAGER_ALLOW_CALLER_NUM_CTX: '1' });
    await callOnce({ prompt: 'x', think: false, numCtx: 8192 });
    assert.equal(seen[seen.length - 1].options.num_ctx, 8192);
  });
});

test('the override is logged once per (source, value), not once per call', async () => {
  await withStub(async (base) => {
    const { callOnce } = freshClient(base);
    const warns = []; const orig = console.warn; console.warn = (m) => warns.push(String(m));
    try {
      for (let i = 0; i < 3; i++) await callOnce({ prompt: 'x', think: false, numCtx: 8192, source: 'plan_critique' });
      await callOnce({ prompt: 'x', think: false, numCtx: 4096, source: 'plan_critique' });
    } finally { console.warn = orig; }
    assert.equal(warns.filter((w) => /ignoring numCtx=8192 from source=plan_critique/.test(w)).length, 1);
    assert.equal(warns.filter((w) => /ignoring numCtx=4096/.test(w)).length, 1);
  });
});

test('source scan: no non-test file under src/ assigns a numeric literal to a num_ctx name (gpu-capacity.js owns the pinned default)', () => {
  const offenders = [];
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js') && n !== 'gpu-capacity.js')) {
    fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/(?:NUM_CTX|numCtx|num_ctx)\s*[:=]\s*\d{3,}/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, []);
});
