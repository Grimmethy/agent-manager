'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createServer, normalizeIp, bearer, sameToken, writeAdhoc } = require('./node-intake-server.js');

const TOKEN = 'lender-secret-' + 'x'.repeat(24);

function setup(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-intake-'));
  const tokenFile = path.join(dir, 'lender-token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const pipeline = path.join(dir, 'pipeline');
  fs.mkdirSync(pipeline);
  const env = { HOME: dir, AGENT_MANAGER_LENDER_TOKEN_FILE: tokenFile, AGENT_MANAGER_PIPELINE_DIR: pipeline, ...extraEnv };
  return { dir, pipeline, env };
}

async function start(env) {
  const server = createServer({ env });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

function call(port, { method = 'POST', url = '/lend', token = TOKEN, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { 'Content-Length': Buffer.byteLength(data) };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: (() => { try { return JSON.parse(text); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const GOOD = { task: { id: 'HUB1-01-x', title: 'T', promptContext: { rawText: 'r' } }, lease: { taskId: 'HUB1-01-x', nodeId: 'grimm', expiresAt: '2026-11-12T00:00:00.000Z' } };

test('a good lend writes the record, stamped leasedTo, into queue/adhoc and answers 200', async () => {
  const s = setup();
  const srv = await start(s.env);
  try {
    const r = await call(srv.port, { body: GOOD });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, taskId: 'HUB1-01-x' });
    const written = JSON.parse(fs.readFileSync(path.join(s.pipeline, 'queue', 'adhoc', 'HUB1-01-x.json'), 'utf8'));
    assert.deepEqual(written, { ...GOOD.task, leasedTo: 'grimm' });
    assert.deepEqual(fs.readdirSync(path.join(s.pipeline, 'queue', 'adhoc')), ['HUB1-01-x.json'], 'no temp file is left behind');
  } finally { await srv.close(); }
});

test('401 for a missing or wrong token, and nothing is written; the token never appears in any response', async () => {
  const s = setup();
  const srv = await start(s.env);
  try {
    for (const token of [null, 'wrong', TOKEN + 'x', '']) {
      const r = await call(srv.port, { token, body: GOOD });
      assert.equal(r.status, 401, String(token));
      assert.ok(!r.text.includes(TOKEN));
    }
    assert.equal(fs.existsSync(path.join(s.pipeline, 'queue')), false);
    const ok = await call(srv.port, { body: GOOD });
    assert.ok(!ok.text.includes(TOKEN));
  } finally { await srv.close(); }
});

test('403 when AGENT_MANAGER_LENDER_ADDRESS is set and the peer is another address; the right address is let in', async () => {
  const s = setup({ AGENT_MANAGER_LENDER_ADDRESS: '10.9.9.9' });
  const srv = await start(s.env);
  try { assert.equal((await call(srv.port, { body: GOOD })).status, 403); } finally { await srv.close(); }
  const s2 = setup({ AGENT_MANAGER_LENDER_ADDRESS: '127.0.0.1' });
  const srv2 = await start(s2.env);
  try { assert.equal((await call(srv2.port, { body: GOOD })).status, 200); } finally { await srv2.close(); }
});

test('400 for junk JSON, a non-object body, missing task or lease, a bad task id and a lease for another task or without a node', async () => {
  const s = setup();
  const srv = await start(s.env);
  try {
    const bad = [
      '{nope', '[]', '"x"', {}, { task: GOOD.task }, { lease: GOOD.lease }, { task: [], lease: GOOD.lease },
      { task: { ...GOOD.task, id: '../evil' }, lease: { ...GOOD.lease, taskId: '../evil' } },
      { task: { ...GOOD.task, id: 'a/b' }, lease: { ...GOOD.lease, taskId: 'a/b' } },
      { task: { ...GOOD.task, id: '' }, lease: { ...GOOD.lease, taskId: '' } },
      { task: { ...GOOD.task, id: 'x'.repeat(201) }, lease: { ...GOOD.lease, taskId: 'x'.repeat(201) } },
      { task: { ...GOOD.task, id: 7 }, lease: { ...GOOD.lease, taskId: 7 } },
      { task: GOOD.task, lease: { ...GOOD.lease, taskId: 'other' } },
      { task: GOOD.task, lease: { ...GOOD.lease, nodeId: '  ' } },
      { task: GOOD.task, lease: { taskId: GOOD.task.id } },
    ];
    for (const body of bad) assert.equal((await call(srv.port, { body })).status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(fs.existsSync(path.join(s.pipeline, 'queue')), false, 'nothing was written');
  } finally { await srv.close(); }
});

test('a body over 1 MB is a 400 and nothing is written; just under the limit is accepted', async () => {
  const s = setup();
  const srv = await start(s.env);
  try {
    const big = { task: { ...GOOD.task, pad: 'a'.repeat(1024 * 1024 + 10) }, lease: GOOD.lease };
    const over = await call(srv.port, { body: big }).catch(() => ({ status: 400, headers: { connection: 'close' } }));
    assert.equal(over.status, 400);
    assert.equal(over.headers.connection, 'close', 'an oversized upload gets its answer and the connection is closed');
    assert.equal(fs.existsSync(path.join(s.pipeline, 'queue')), false);
    const near = { task: { ...GOOD.task, pad: 'a'.repeat(1024 * 1024 - 2000) }, lease: GOOD.lease };
    assert.equal((await call(srv.port, { body: near })).status, 200);
  } finally { await srv.close(); }
});

test('404 for other paths and 405 for other methods on /lend', async () => {
  const s = setup();
  const srv = await start(s.env);
  try {
    assert.equal((await call(srv.port, { url: '/other', body: GOOD })).status, 404);
    assert.equal((await call(srv.port, { url: '/lend/x', body: GOOD })).status, 404);
    assert.equal((await call(srv.port, { method: 'GET', url: '/lend' })).status, 405);
    assert.equal((await call(srv.port, { method: 'PUT', body: GOOD })).status, 405);
  } finally { await srv.close(); }
});

test('409 for an id that is already queued, and the existing file is untouched', async () => {
  const s = setup();
  const srv = await start(s.env);
  try {
    assert.equal((await call(srv.port, { body: GOOD })).status, 200);
    const file = path.join(s.pipeline, 'queue', 'adhoc', 'HUB1-01-x.json');
    const before = fs.readFileSync(file, 'utf8');
    const again = { task: { ...GOOD.task, title: 'CHANGED' }, lease: GOOD.lease };
    assert.equal((await call(srv.port, { body: again })).status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['HUB1-01-x.json']);
  } finally { await srv.close(); }
});

test('the server refuses to be created without a readable non-empty token file or without a pipeline dir', () => {
  const s = setup();
  assert.throws(() => createServer({ env: { ...s.env, AGENT_MANAGER_LENDER_TOKEN_FILE: '' } }), /TOKEN_FILE/);
  assert.throws(() => createServer({ env: { ...s.env, AGENT_MANAGER_LENDER_TOKEN_FILE: path.join(s.dir, 'missing') } }), /TOKEN_FILE/);
  fs.writeFileSync(path.join(s.dir, 'empty'), ' \n');
  assert.throws(() => createServer({ env: { ...s.env, AGENT_MANAGER_LENDER_TOKEN_FILE: path.join(s.dir, 'empty') } }), /TOKEN_FILE/);
  assert.throws(() => createServer({ env: { ...s.env, AGENT_MANAGER_PIPELINE_DIR: '' } }), /PIPELINE_DIR/);
});

test('run as a program without a token file it exits 2 and never prints a token', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'node-intake-server.js')], { env: { PATH: process.env.PATH, HOME: os.tmpdir() }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /TOKEN_FILE/);
});

test('helpers: ::ffff: prefix stripped, bearer parsing, constant-time comparison, writeAdhoc refuses an existing id', () => {
  assert.equal(normalizeIp('::ffff:10.0.0.5'), '10.0.0.5');
  assert.equal(normalizeIp(undefined), '');
  assert.equal(bearer('Bearer abc'), 'abc');
  assert.equal(bearer('Basic abc'), '');
  assert.equal(bearer('Bearer a b'), '');
  assert.equal(sameToken('a', 'a'), true);
  assert.equal(sameToken('a', 'b'), false);
  const s = setup();
  assert.equal(writeAdhoc(s.pipeline, { id: 'q1' }), true);
  assert.equal(writeAdhoc(s.pipeline, { id: 'q1' }), false);
});
