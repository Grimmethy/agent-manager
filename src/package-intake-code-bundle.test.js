'use strict';

// FF-5/5b: GET /code/<name>.bundle on the package intake (src/package-intake-server.js). Helpers mirror src/package-intake-server.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createServer } = require('./package-intake-server.js');
const { registerNode } = require('./node-registry.js');

const BUNDLE = 'agent-manager-dddddddd.bundle';
const SHA = 'd'.repeat(40);

function setup({ address = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-bundle-'));
  const env = { HOME: dir, AGENT_MANAGER_NODES_DIR: path.join(dir, 'nodes'), AGENT_MANAGER_PIPELINE_DIR: path.join(dir, 'pipeline') };
  const { token } = registerNode({ id: 'grimm', address, cores: 4, ramGb: 15, concurrencyCap: 2 }, env);
  const publishDir = path.join(env.AGENT_MANAGER_PIPELINE_DIR, 'code-publish');
  fs.mkdirSync(publishDir, { recursive: true });
  const bytes = crypto.randomBytes(300000);
  fs.writeFileSync(path.join(publishDir, BUNDLE), bytes);
  fs.writeFileSync(path.join(publishDir, 'latest.json'), JSON.stringify([{ repo: 'agent-manager', sha: SHA, bundle: BUNDLE, branch: 'master' }]));
  return { dir, env, token, publishDir, bytes };
}

async function start(s) {
  const server = createServer({ env: s.env, send: async () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

// Raw path on purpose: http.request would not normalise it, so '..' and %2f reach the server as written.
function get(port, rawPath, { token, nodeId = 'grimm', method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (nodeId) headers['X-Node-Id'] = nodeId;
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a listed bundle streams with the right bytes, length and content type', async () => {
  const s = setup();
  const srv = await start(s);
  try {
    const r = await get(srv.port, `/code/${BUNDLE}`, { token: s.token });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(Number(r.headers['content-length']), s.bytes.length);
    assert.ok(r.body.equals(s.bytes));
  } finally { await srv.close(); }
});

test('the bundle is read from AGENT_MANAGER_CODE_PUBLISH_DIR when it is set', async () => {
  const s = setup();
  const other = path.join(s.dir, 'elsewhere');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, BUNDLE), 'other bytes');
  fs.writeFileSync(path.join(other, 'latest.json'), JSON.stringify([{ repo: 'agent-manager', sha: SHA, bundle: BUNDLE }]));
  s.env.AGENT_MANAGER_CODE_PUBLISH_DIR = other;
  const srv = await start(s);
  try {
    const r = await get(srv.port, `/code/${BUNDLE}`, { token: s.token });
    assert.equal(r.body.toString(), 'other bytes');
  } finally { await srv.close(); }
});

test('a name that is not in latest.json is a 404, and so is a file that is present but unlisted', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.publishDir, 'secret.bundle'), 'not listed');
  const srv = await start(s);
  try {
    assert.equal((await get(srv.port, '/code/secret.bundle', { token: s.token })).status, 404);
    assert.equal((await get(srv.port, '/code/nothing.bundle', { token: s.token })).status, 404);
    assert.equal((await get(srv.port, '/code/latest.json', { token: s.token })).status, 404);
    assert.equal((await get(srv.port, `/code/${BUNDLE}.bak`, { token: s.token })).status, 404);
  } finally { await srv.close(); }
});

test('traversal in any form is a 404 and never leaks a file outside the publish directory', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.env.AGENT_MANAGER_PIPELINE_DIR, 'outside.bundle'), 'outside');
  const srv = await start(s);
  try {
    for (const p of ['/code/../outside.bundle', '/code/%2e%2e%2foutside.bundle', '/code/..%2foutside.bundle', `/code/${BUNDLE}/../outside.bundle`, '/code//outside.bundle', '/code/%00.bundle']) {
      const r = await get(srv.port, p, { token: s.token });
      assert.equal(r.status, 404, p);
      assert.equal(r.body.toString().includes('outside'), false, p);
    }
  } finally { await srv.close(); }
});

test('a listed name that breaks the name rule (too long, bad characters) is a 404 even when the file exists', async () => {
  const s = setup();
  const long = `${'a'.repeat(195)}.bundle`;
  const spaced = 'a b.bundle';
  const percent = 'a%41.bundle';
  for (const name of [long, spaced, percent]) fs.writeFileSync(path.join(s.publishDir, name), 'x');
  fs.writeFileSync(path.join(s.publishDir, 'latest.json'), JSON.stringify([long, spaced, percent].map((name) => ({ repo: 'r', sha: SHA, bundle: name }))));
  const srv = await start(s);
  try {
    assert.equal((await get(srv.port, `/code/${long}`, { token: s.token })).status, 404);
    assert.equal((await get(srv.port, '/code/a%20b.bundle', { token: s.token })).status, 404);
    assert.equal((await get(srv.port, `/code/${percent}`, { token: s.token })).status, 404);
  } finally { await srv.close(); }
});

test('a listed bundle whose file is missing or is a directory is a 404', async () => {
  const s = setup();
  fs.rmSync(path.join(s.publishDir, BUNDLE));
  const srv = await start(s);
  try {
    assert.equal((await get(srv.port, `/code/${BUNDLE}`, { token: s.token })).status, 404);
    fs.mkdirSync(path.join(s.publishDir, BUNDLE));
    assert.equal((await get(srv.port, `/code/${BUNDLE}`, { token: s.token })).status, 404);
  } finally { await srv.close(); }
});

test('a listed bundle that cannot be read before the headers is a 500', { skip: process.getuid && process.getuid() === 0 }, async () => {
  const s = setup();
  fs.chmodSync(path.join(s.publishDir, BUNDLE), 0o000);
  const srv = await start(s);
  try {
    assert.equal((await get(srv.port, `/code/${BUNDLE}`, { token: s.token })).status, 500);
  } finally { fs.chmodSync(path.join(s.publishDir, BUNDLE), 0o600); await srv.close(); }
});

test('auth failures are the same as for /code/latest: 401 for a bad token, a missing node id or another node, 403 for the wrong address', async () => {
  const s = setup();
  const third = registerNode({ id: 'third', address: '', cores: 1, ramGb: 1, concurrencyCap: 1 }, s.env).token;
  const srv = await start(s);
  try {
    assert.equal((await get(srv.port, `/code/${BUNDLE}`, { token: 'wrong' })).status, 401);
    assert.equal((await get(srv.port, `/code/${BUNDLE}`, {})).status, 401);
    assert.equal((await get(srv.port, `/code/${BUNDLE}`, { token: s.token, nodeId: '' })).status, 401);
    assert.equal((await get(srv.port, `/code/${BUNDLE}`, { token: third })).status, 401);
    assert.equal((await get(srv.port, `/code/${BUNDLE}`, { token: s.token, nodeId: 'nobody' })).status, 401);
  } finally { await srv.close(); }
  const t = setup({ address: '10.9.9.9' });
  const srv2 = await start(t);
  try {
    const r = await get(srv2.port, `/code/${BUNDLE}`, { token: t.token });
    assert.equal(r.status, 403);
    assert.equal(r.body.length < 200, true);
  } finally { await srv2.close(); }
});

test('other methods on a bundle name are a 405, a name without .bundle is a 404 with no auth needed, and /code/latest still works', async () => {
  const s = setup();
  const srv = await start(s);
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal((await get(srv.port, `/code/${BUNDLE}`, { token: s.token, method })).status, 405, method);
    assert.equal((await get(srv.port, '/code/other', {})).status, 404);
    const latest = await get(srv.port, '/code/latest', { token: s.token });
    assert.equal(latest.status, 200);
    assert.equal(JSON.parse(latest.body.toString())[0].bundle, BUNDLE);
  } finally { await srv.close(); }
});

test('the runbook describes the two code routes', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'docs', 'agents', 'multi-node-runbook.md'), 'utf8');
  assert.match(text, /### Code routes/);
  assert.match(text, /GET \/code\/latest/);
  assert.match(text, /GET \/code\/<name>\.bundle/);
  assert.match(text, /X-Node-Id/);
});
