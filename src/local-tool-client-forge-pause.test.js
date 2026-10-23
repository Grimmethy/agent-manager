'use strict';

// The tool loop (runPlanWithTools -> chatTurnWithFlakeRecovery, the /api/chat path of local-agentic-write-draft.js) must honour the Forge GPU lease before
// EVERY turn, not only before a pass. Found 2026-10-22 in the first live GPU broker test: a pass that was between two turns (running a tool, so holding no
// in-flight lock) when the lease appeared sent its next turn and reloaded the model the Forge session had just evicted, for the whole session.
//
// A local HTTP stub standing in for Ollama's /api/chat counts the requests that reach it (same pattern as local-tool-client-flake-rollback.test.js);
// the lease is a temp file named by AGENT_MANAGER_COMFY_LEASE_PATH, so nothing here touches the real lease, GPU or Ollama.
//
// Run: node --test src/local-tool-client-forge-pause.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pause-'));
const LEASE = path.join(tmp, 'comfyui-lease.json');
process.env.AGENT_MANAGER_COMFY_LEASE_PATH = LEASE;   // read by gpu-guard.js when it loads
delete process.env.AGENT_MANAGER_FORGE_PAUSE;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
test.afterEach(() => { fs.rmSync(LEASE, { force: true }); delete process.env.AGENT_MANAGER_FORGE_PAUSE; });

function writeLease(extra = {}, ageMs = 0) {
  const at = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(LEASE, JSON.stringify({ holder: 'promptforge', family: 'forge', owner: 'test', acquiredAt: at, refreshedAt: at, ...extra }));
}

function freshLocalToolClient(baseUrl, repoRoot) {
  process.env.OLLAMA_URL = baseUrl;
  process.env.LOCAL_MODEL = 'test-model';
  process.env.LOCAL_TIMEOUT_MS = '5000';
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  fs.mkdirSync(path.join(repoRoot, 'instances'), { recursive: true });
  for (const m of ['./local-tool-client.js', './config.js', './gpu-guard.js']) delete require.cache[require.resolve(m)];
  return require('./local-tool-client.js');
}

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try { await fn(base); resolve(); } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}

const reply = (res, message) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message, done: true })); };
const toolTurn = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
const finalTurn = { role: 'assistant', content: 'All done.' };
const MESSAGES = [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'List the repo root.' }];

function isPause(e) { return require('./gpu-guard.js').isForgePause(e); }

async function run(base, handlerFor, opts = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const seen = { requests: 0 };
  let outcome;
  await withServer(async (req, res) => {
    req.resume();
    await new Promise((r) => req.on('end', r));
    seen.requests += 1;
    handlerFor(seen, res);
  }, async (url) => {
    const { runPlanWithTools } = freshLocalToolClient(url, dir);
    try { outcome = { result: await runPlanWithTools({ messages: MESSAGES.map((m) => ({ ...m })), maxTurns: 6, ...opts }) }; } catch (error) { outcome = { error }; }
  });
  return { ...seen, ...outcome };
}

const answerDirectly = (seen, res) => reply(res, finalTurn);

test('a fresh lease pauses the pass before any request is sent', async () => {
  writeLease();
  const r = await run(null, answerDirectly, { source: 'plan' });
  assert.ok(r.error && isPause(r.error), 'rejects with a Forge pause');
  assert.equal(r.requests, 0, 'no /api/chat request reached the model');
});

test('a lease scoped to the endpoint this lane uses pauses it', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  let requests = 0;
  let outcome;
  await withServer((req, res) => { requests += 1; req.resume(); reply(res, finalTurn); }, async (url) => {
    writeLease({ endpoints: [url] });
    const { runPlanWithTools } = freshLocalToolClient(url, dir);
    try { outcome = { result: await runPlanWithTools({ messages: MESSAGES, maxTurns: 3, source: 'plan' }) }; } catch (error) { outcome = { error }; }
  });
  assert.ok(outcome.error && isPause(outcome.error));
  assert.equal(requests, 0);
});

test('a lease scoped to a different card, an expired lease, and AGENT_MANAGER_FORGE_PAUSE=off all let the pass run', async () => {
  writeLease({ endpoints: ['http://192.168.122.29:11434'] });
  let r = await run(null, answerDirectly, { source: 'plan' });
  assert.equal(r.error, undefined, 'other card');
  assert.equal(r.requests, 1);
  assert.equal(r.result.response, 'All done.');

  writeLease({}, 5 * 60 * 1000);
  r = await run(null, answerDirectly, { source: 'plan' });
  assert.equal(r.error, undefined, 'expired lease');
  assert.equal(r.requests, 1);

  writeLease();
  process.env.AGENT_MANAGER_FORGE_PAUSE = 'off';
  r = await run(null, answerDirectly, { source: 'plan' });
  assert.equal(r.error, undefined, 'kill switch');
  assert.equal(r.requests, 1);
});

test('the incident: the lease appears BETWEEN two turns, so the second turn is never sent', async () => {
  const r = await run(null, (seen, res) => {
    if (seen.requests === 1) { writeLease(); reply(res, toolTurn); return; }   // turn 1 answers with a tool call, and the Forge session starts
    reply(res, finalTurn);
  }, { source: 'plan' });
  assert.ok(r.error && isPause(r.error), 'rejects with a Forge pause, not a result');
  assert.equal(r.requests, 1, 'exactly one request reached the model: the turn after the lease was never sent');
});

test('the forced-summary turn after the turn cap also honours the lease', async () => {
  const r = await run(null, (seen, res) => {
    if (seen.requests === 1) { writeLease(); reply(res, toolTurn); return; }
    reply(res, { role: 'assistant', content: 'Summary.\nRESOLUTION: no-changes-needed' });
  }, { source: 'plan', maxTurns: 1, forceSummaryOnCap: true });
  assert.ok(r.error && isPause(r.error));
  assert.equal(r.requests, 1);
});

test('the summary retry turn (the answer lacked the RESOLUTION line) also honours the lease', async () => {
  const r = await run(null, (seen, res) => {
    if (seen.requests === 1) { reply(res, toolTurn); return; }
    if (seen.requests === 2) { writeLease(); reply(res, { role: 'assistant', content: 'A summary with no resolution line at all.' }); return; }
    reply(res, { role: 'assistant', content: 'Second try.\nRESOLUTION: no-changes-needed' });
  }, { source: 'plan', maxTurns: 1, forceSummaryOnCap: true });
  assert.ok(r.error && isPause(r.error));
  assert.equal(r.requests, 2, 'the retry turn was never sent');
});

test('the Chat panel (source chat) is an explicit user action and still runs under a fresh lease', async () => {
  writeLease();
  const r = await run(null, answerDirectly, { source: 'chat' });
  assert.equal(r.error, undefined);
  assert.equal(r.requests, 1);
});
