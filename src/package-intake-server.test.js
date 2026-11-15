'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createServer, refusal } = require('./package-intake-server.js');
const { registerNode } = require('./node-registry.js');
const { lendLease, leaseFor } = require('./lease-ledger.js');
const { buildPackage, buildRecordPackage } = require('./review-package.js');

const SHA = 'c'.repeat(40);
const RECORD = { id: 'HUB1-05-x', title: 'T', rawDiff: 'diff', localVotes: [1], history: [2] };

function setup({ address = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-intake-'));
  const env = { HOME: dir, AGENT_MANAGER_NODES_DIR: path.join(dir, 'nodes'), AGENT_MANAGER_PIPELINE_DIR: path.join(dir, 'pipeline') };
  const { token } = registerNode({ id: 'grimm', address, cores: 4, ramGb: 15, concurrencyCap: 2 }, env);
  registerNode({ id: 'other', address: '', cores: 4, ramGb: 15, concurrencyCap: 2 }, env);
  const pkg = buildPackage({ record: RECORD, nodeId: 'grimm', branch: 'agent/x', sha: SHA, now: Date.UTC(2026, 10, 11) });
  return { dir, env, token, pkg, notices: [] };
}

async function start(s) {
  const server = createServer({ env: s.env, send: async (m) => { s.notices.push(m); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

function call(port, { method = 'POST', url = '/package', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: (() => { try { return JSON.parse(text); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const stored = (s) => path.join(s.env.AGENT_MANAGER_PIPELINE_DIR, 'queue', 'node-packages', 'HUB1-05-x.json');

test('a good package from a node holding the lease is stored, the lease is returned and one summary notice is sent', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  const srv = await start(s);
  try {
    const r = await call(srv.port, { token: s.token, body: s.pkg });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, taskId: 'HUB1-05-x' });
    assert.deepEqual(JSON.parse(fs.readFileSync(stored(s), 'utf8')), s.pkg);
    assert.equal(leaseFor('HUB1-05-x', s.env).state, 'returned');
    assert.equal(s.notices.length, 1);
    assert.equal(s.notices[0].level, 'summary');
    assert.equal(s.notices[0].key, 'node-package:HUB1-05-x');
    assert.ok(!r.text.includes(s.token));
  } finally { await srv.close(); }
});

test('a resend replaces the stored package and still answers 200', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  const srv = await start(s);
  try {
    assert.equal((await call(srv.port, { token: s.token, body: s.pkg })).status, 200);
    const again = { ...s.pkg, branch: 'agent/y' };
    assert.equal((await call(srv.port, { token: s.token, body: again })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(stored(s), 'utf8')).branch, 'agent/y');
  } finally { await srv.close(); }
});

test('401 for a missing, wrong, another node\'s or unknown-node token, and a non-object body; nothing is stored', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  const other = registerNode({ id: 'other', address: '', cores: 4, ramGb: 15, concurrencyCap: 2 }, s.env, { rotate: true }).token;
  const srv = await start(s);
  try {
    for (const [token, body] of [[undefined, s.pkg], ['wrong', s.pkg], [other, s.pkg], [s.token, { ...s.pkg, nodeId: 'ghost' }], [s.token, []], [s.token, 'null'], [s.token, { ...s.pkg, nodeId: 5 }]]) {
      const r = await call(srv.port, { token, body });
      assert.equal(r.status, 401, JSON.stringify([token, body]).slice(0, 60));
    }
    assert.equal(fs.existsSync(stored(s)), false);
    assert.equal(leaseFor('HUB1-05-x', s.env).state, 'lent');
  } finally { await srv.close(); }
});

test('403 when the node was registered with another address; nothing is stored', async () => {
  const s = setup({ address: '10.9.9.9' });
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  const srv = await start(s);
  try {
    assert.equal((await call(srv.port, { token: s.token, body: s.pkg })).status, 403);
    assert.equal(fs.existsSync(stored(s)), false);
  } finally { await srv.close(); }
  const s2 = setup({ address: '127.0.0.1' });
  lendLease('HUB1-05-x', 'grimm', { env: s2.env });
  const srv2 = await start(s2);
  try { assert.equal((await call(srv2.port, { token: s2.token, body: s2.pkg })).status, 200); } finally { await srv2.close(); }
});

test('400 for junk JSON, an invalid package (each with its reason) and an unsafe task id', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  const srv = await start(s);
  try {
    assert.equal((await call(srv.port, { token: s.token, body: '{nope' })).status, 400);
    const bad = [{ ...s.pkg, version: 2 }, { ...s.pkg, sha: 'abc' }, { ...s.pkg, branch: 'main' }, { ...s.pkg, taskId: 'zzz' }, { ...s.pkg, record: null }];
    for (const body of bad) {
      const r = await call(srv.port, { token: s.token, body });
      assert.equal(r.status, 400);
      assert.ok(r.json.error.length > 0);
    }
    const evil = { ...s.pkg, taskId: '../evil', record: { ...s.pkg.record, id: '../evil' } };
    const r = await call(srv.port, { token: s.token, body: evil });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /task id/);
    assert.equal(fs.existsSync(path.join(s.env.AGENT_MANAGER_PIPELINE_DIR, 'queue')), false);
  } finally { await srv.close(); }
});

test('409 when the task has no lease or the lease belongs to another node; nothing stored and the other lease stays lent', async () => {
  const s = setup();
  const srv = await start(s);
  try {
    assert.equal((await call(srv.port, { token: s.token, body: s.pkg })).status, 409);
    lendLease('HUB1-05-x', 'other', { env: s.env });
    assert.equal((await call(srv.port, { token: s.token, body: s.pkg })).status, 409);
    assert.equal(fs.existsSync(stored(s)), false);
    assert.equal(leaseFor('HUB1-05-x', s.env).state, 'lent');
  } finally { await srv.close(); }
});

test('404 for other paths and 405 for other methods on /package', async () => {
  const s = setup();
  const srv = await start(s);
  try {
    assert.equal((await call(srv.port, { url: '/x', token: s.token, body: s.pkg })).status, 404);
    assert.equal((await call(srv.port, { method: 'GET' })).status, 405);
    assert.equal((await call(srv.port, { method: 'DELETE' })).status, 405);
  } finally { await srv.close(); }
});

test('a body over 4 MB is a 400 with the connection closed and nothing stored; one just under is accepted', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  const srv = await start(s);
  try {
    const big = { ...s.pkg, record: { ...s.pkg.record, pad: 'a'.repeat(4 * 1024 * 1024 + 10) } };
    const over = await call(srv.port, { token: s.token, body: big }).catch(() => ({ status: 400, headers: { connection: 'close' } }));
    assert.equal(over.status, 400);
    assert.equal(over.headers.connection, 'close');
    assert.equal(fs.existsSync(stored(s)), false);
    const near = { ...s.pkg, record: { ...s.pkg.record, pad: 'a'.repeat(4 * 1024 * 1024 - 5000) } };
    assert.equal((await call(srv.port, { token: s.token, body: near })).status, 200);
  } finally { await srv.close(); }
});

test('a failing notifier never changes the 200', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  const server = createServer({ env: s.env, send: async () => { throw new Error('ntfy down'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { assert.equal((await call(server.address().port, { token: s.token, body: s.pkg })).status, 200); } finally { server.close(); server.closeAllConnections(); }
});

test('createServer needs a pipeline dir, the program exits 2 without one, and refusal() explains itself', () => {
  assert.throws(() => createServer({ env: { HOME: '/x' } }), /PIPELINE_DIR/);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'package-intake-server.js')], { env: { PATH: process.env.PATH, HOME: os.tmpdir() }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /PIPELINE_DIR/);
  assert.equal(refusal(buildPackage({ record: RECORD, nodeId: 'grimm', branch: 'agent/x', sha: SHA })), '');
  assert.match(refusal({}), /version/);
});

const DRAFT = { id: 'HUB1-05-x', title: 'T', rawDiff: 'diff --git a b', implementResponse: 'did it', status: 'drafting', leasedTo: 'grimm', localVotes: [1], history: [{ stage: 'draft-done' }] };

function seedOriginal(s, queue, extra = {}) {
  const dir = path.join(s.env.AGENT_MANAGER_PIPELINE_DIR, 'queue', queue);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'HUB1-05-x.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'HUB1-05-x', title: 'T', leasedTo: 'grimm', ...extra }));
  return file;
}

const reviewFile = (s) => path.join(s.env.AGENT_MANAGER_PIPELINE_DIR, 'queue', 'review', 'HUB1-05-x.json');

for (const queue of ['pending', 'adhoc']) {
  test(`a version 2 package replaces the leased original in queue/${queue}: the node's record lands in queue/review, the original is gone, the lease is returned`, async () => {
    const s = setup();
    lendLease('HUB1-05-x', 'grimm', { env: s.env });
    const original = seedOriginal(s, queue);
    const pkg = buildRecordPackage({ record: DRAFT, nodeId: 'grimm', now: Date.UTC(2026, 10, 11) });
    const srv = await start(s);
    try {
      const r = await call(srv.port, { token: s.token, body: pkg });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true, taskId: 'HUB1-05-x' });
      assert.equal(fs.existsSync(original), false);
      const draft = JSON.parse(fs.readFileSync(reviewFile(s), 'utf8'));
      assert.equal(draft.status, 'needs-review');
      assert.equal(draft.fromNode, 'grimm');
      assert.equal('leasedTo' in draft, false);
      assert.equal(draft.rawDiff, 'diff --git a b');
      assert.equal(draft.implementResponse, 'did it');
      assert.equal(draft.history.length, 1);
      assert.equal(draft.history[0].stage, 'node-draft-received');
      assert.equal(draft.history[0].detail, 'drafted on grimm');
      assert.match(draft.history[0].at, /^\d{4}-\d\d-\d\dT/);
      assert.deepEqual(JSON.parse(fs.readFileSync(stored(s), 'utf8')), pkg);
      assert.equal(leaseFor('HUB1-05-x', s.env).state, 'returned');
      assert.equal(s.notices.length, 1);
      assert.doesNotMatch(s.notices[0].text, /undefined/);
    } finally { await srv.close(); }
  });
}

test('a version 2 package whose original is gone is a 409: nothing is stored or filed and the lease is still held', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  const srv = await start(s);
  try {
    const r = await call(srv.port, { token: s.token, body: buildRecordPackage({ record: DRAFT, nodeId: 'grimm' }) });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /original/);
    assert.equal(fs.existsSync(stored(s)), false);
    assert.equal(fs.existsSync(reviewFile(s)), false);
    assert.equal(leaseFor('HUB1-05-x', s.env).state, 'lent');
    assert.equal(s.notices.length, 0);
  } finally { await srv.close(); }
});

test('a version 2 package whose original file belongs to a different task id is a 409 and the file is left alone', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  const original = seedOriginal(s, 'pending', { id: 'HUB9-09-y' });
  const srv = await start(s);
  try {
    assert.equal((await call(srv.port, { token: s.token, body: buildRecordPackage({ record: DRAFT, nodeId: 'grimm' }) })).status, 409);
    assert.equal(fs.existsSync(original), true);
    const broken = seedOriginal(s, 'adhoc');
    fs.writeFileSync(broken, '{not json');
    assert.equal((await call(srv.port, { token: s.token, body: buildRecordPackage({ record: DRAFT, nodeId: 'grimm' }) })).status, 409);
    assert.equal(fs.existsSync(broken), true);
  } finally { await srv.close(); }
});

test('a version 2 package from a node that does not hold the lease is a 409 and the original stays where it is', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'other', { env: s.env });
  const original = seedOriginal(s, 'pending');
  const srv = await start(s);
  try {
    assert.equal((await call(srv.port, { token: s.token, body: buildRecordPackage({ record: DRAFT, nodeId: 'grimm' }) })).status, 409);
    assert.equal(fs.existsSync(original), true);
    assert.equal(fs.existsSync(reviewFile(s)), false);
  } finally { await srv.close(); }
});

test('a version 2 package without a diff is a 400 and a version 1 package still only stores and returns the lease, leaving queue/review alone', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  const original = seedOriginal(s, 'pending');
  const srv = await start(s);
  try {
    const noDiff = buildRecordPackage({ record: { ...DRAFT, rawDiff: '' }, nodeId: 'grimm' });
    assert.equal((await call(srv.port, { token: s.token, body: noDiff })).status, 400);
    assert.equal(fs.existsSync(original), true);
    const r = await call(srv.port, { token: s.token, body: s.pkg });
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(original), true);
    assert.equal(fs.existsSync(reviewFile(s)), false);
    assert.equal(leaseFor('HUB1-05-x', s.env).state, 'returned');
    assert.match(s.notices[0].text, /agent\/x/);
  } finally { await srv.close(); }
});

test('a hand-built version 2 package that still carries a lease stamp and a history keeps its history, gains the received entry and loses the stamp', async () => {
  const s = setup();
  lendLease('HUB1-05-x', 'grimm', { env: s.env });
  seedOriginal(s, 'pending');
  const pkg = { version: 2, kind: 'record', taskId: 'HUB1-05-x', nodeId: 'grimm', builtAt: 'x', record: { ...DRAFT, history: [{ stage: 'draft-done' }], leasedTo: 'grimm' } };
  const srv = await start(s);
  try {
    assert.equal((await call(srv.port, { token: s.token, body: pkg })).status, 200);
    const draft = JSON.parse(fs.readFileSync(reviewFile(s), 'utf8'));
    assert.equal('leasedTo' in draft, false);
    assert.deepEqual(draft.history.map((h) => h.stage), ['draft-done', 'node-draft-received']);
  } finally { await srv.close(); }
});
