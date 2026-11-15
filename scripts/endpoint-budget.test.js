'use strict';

// ollama_endpoint_reachable (scripts/agent-manager-common.sh) with the gateway budget check (src/gateway-budget.js), run for real in bash against stub
// HTTP servers. Run: node --test scripts/endpoint-budget.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SPENT = { tokenBudget: { perHour: 1500000, used: 1518237, remaining: -18237, resetsInSec: 1196 } };
const FINE = { tokenBudget: { perHour: 1500000, used: 10, remaining: 1499990, resetsInSec: 3000 } };

async function stub(meterStatus, meterBody) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/meter' && meterStatus === 200) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(meterBody)); return; }
    res.writeHead(req.url === '/meter' ? meterStatus : 200); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, hits, close: () => { server.close(); server.closeAllConnections(); } };
}

function probe(url, extraEnv = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-budget-'));
  // async spawn: the stub servers live in this process and must keep answering while bash runs
  return new Promise((resolve) => {
    const c = spawn('bash', ['-c', `source "${path.join(__dirname, 'agent-manager-common.sh')}" >/dev/null 2>&1; ollama_endpoint_reachable "${url}"`], {
      env: { ...process.env, HOME: state, AGENT_MANAGER_BUDGET_STATE_DIR: path.join(state, 'budget'), AGENT_MANAGER_ENDPOINT_PROBE_TIMEOUT_S: '3', ...extraEnv },
    });
    c.on('close', (code) => resolve({ code, state }));
  });
}

test('a gateway whose hourly budget is spent is not ready, and the hit is recorded once', async () => {
  const g = await stub(200, SPENT);
  try {
    const r = await probe(`http://127.0.0.1:${g.port}`);
    assert.equal(r.code, 1);
    assert.ok(g.hits.includes('/meter'));
    assert.equal(fs.readFileSync(path.join(r.state, 'budget', 'hits.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally { g.close(); }
});

test('a gateway with budget left is ready', async () => {
  const g = await stub(200, FINE);
  try { assert.equal((await probe(`http://127.0.0.1:${g.port}`)).code, 0); } finally { g.close(); }
});

test('a plain Ollama (no /meter: 404) stays ready, and a junk /meter answer fails open', async () => {
  const a = await stub(404);
  const b = await stub(200, { whatever: true });
  try {
    assert.equal((await probe(`http://127.0.0.1:${a.port}`)).code, 0);
    assert.equal((await probe(`http://127.0.0.1:${b.port}/`)).code, 0);
  } finally { a.close(); b.close(); }
});

test('AGENT_MANAGER_BUDGET_PROBE=off ignores a spent budget and never asks /meter', async () => {
  const g = await stub(200, SPENT);
  try {
    assert.equal((await probe(`http://127.0.0.1:${g.port}`, { AGENT_MANAGER_BUDGET_PROBE: 'off' })).code, 0);
    assert.ok(!g.hits.includes('/meter'));
  } finally { g.close(); }
});

test('a closed port is still not ready', async () => {
  const g = await stub(200, FINE);
  const port = g.port;
  g.close();
  assert.equal((await probe(`http://127.0.0.1:${port}`)).code, 1);
});
