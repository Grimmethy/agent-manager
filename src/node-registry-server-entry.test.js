'use strict';

// Tests for the standalone entry of src/node-registry-server.js (grimm-as-a-node): the service started with `node src/node-registry-server.js`
// records node events on the lease ledger (POST /event) and reads AGENT_MANAGER_NODE_PIPELINE_DIRS. Temp dirs only, a loopback port, a spawned child.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { parsePipelineDirs } = require('./node-registry-server.js');
const { registerNode } = require('./node-registry.js');

const SERVER = path.join(__dirname, 'node-registry-server.js');

test('parsePipelineDirs splits on commas, trims, drops empty entries and answers an empty list for nothing', () => {
  assert.deepEqual(parsePipelineDirs('/a, /b ,,/c'), ['/a', '/b', '/c']);
  assert.deepEqual(parsePipelineDirs(' , '), []);
  assert.deepEqual(parsePipelineDirs(''), []);
  assert.deepEqual(parsePipelineDirs(undefined), []);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function postJson(port, token, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const postEvent = (port, token, body) => postJson(port, token, '/event', body);

// Starts the real standalone service and waits until its port answers.
async function startStandalone(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-registry-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: dir, AGENT_MANAGER_NODES_DIR: path.join(dir, 'nodes'), AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch') };
  const { token } = registerNode({ id: 'grimm', address: '127.0.0.1', cores: 4 }, env);
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { ...env, AGENT_MANAGER_NODES_PORT: String(port), AGENT_MANAGER_NODE_PIPELINE_DIRS: path.join(dir, 'pipe') }, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  for (let i = 0; i < 50; i++) {
    const up = await new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); });
    if (up) return { dir, env, port, token };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the standalone registry service did not start');
}

test('the standalone service records an event on the lease ledger', async (t) => {
  const s = await startStandalone(t);
  const ledger = path.join(s.dir, 'nodes', 'leases.json');
  fs.writeFileSync(ledger, JSON.stringify({ t1: { taskId: 't1', nodeId: 'grimm', state: 'lent', expiresAt: '2099-01-01T00:00:00.000Z' } }));
  const r = await postEvent(s.port, s.token, { id: 'grimm', taskId: 't1', event: 'applied' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  const row = JSON.parse(fs.readFileSync(ledger, 'utf8')).t1;
  assert.equal(row.lastEvent, 'applied');
  assert.equal(typeof row.lastEventAt, 'string');
});

test('the standalone service still refuses an event outside the six, without touching the ledger', async (t) => {
  const s = await startStandalone(t);
  const r = await postEvent(s.port, s.token, { id: 'grimm', taskId: 't1', event: 'exploded' });
  assert.equal(r.status, 400);
  assert.equal(fs.existsSync(path.join(s.dir, 'nodes', 'leases.json')), false);
});

test('the standalone service claims from the pipelines named in AGENT_MANAGER_NODE_PIPELINE_DIRS', async (t) => {
  const s = await startStandalone(t);
  const pipe = path.join(s.dir, 'pipe');
  fs.mkdirSync(path.join(pipe, 'queue', 'adhoc'), { recursive: true });
  execFileSync('git', ['init', '-q', pipe]); // /claim skips a task whose project has no origin URL
  execFileSync('git', ['-C', pipe, 'remote', 'add', 'origin', 'https://example.invalid/repo.git']);
  fs.writeFileSync(path.join(pipe, 'queue', 'adhoc', 't-9.json'), JSON.stringify({ id: 't-9', title: 'x' }));
  const r = await postJson(s.port, s.token, '/claim', { id: 'grimm' });
  assert.equal(r.status, 200);
  assert.equal(r.body.task.id, 't-9');
  assert.equal(r.body.repo.root, pipe);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'nodes', 'leases.json'), 'utf8'))['t-9'].nodeId, 'grimm');
});
