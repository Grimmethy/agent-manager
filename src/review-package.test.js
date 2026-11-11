'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { scrub, buildPackage, validatePackage, sendPackage, httpPost, PACKAGE_STRIP, SEND_TIMEOUT_MS } = require('./review-package.js');

const SHA = 'a'.repeat(40);
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const RECORD = { id: 'HUB1-01-x', title: 'T', rawDiff: 'diff --git a b', promptContext: { rawText: 'r' }, localVotes: [{ verdict: 'APPROVE' }], history: [{ stage: 'x' }] };

test('buildPackage has the contract shape and keeps title, rawDiff, promptContext and id', () => {
  const pkg = buildPackage({ record: RECORD, nodeId: 'grimm', branch: 'agent/x', sha: SHA, now: T0 });
  assert.deepEqual(Object.keys(pkg), ['version', 'taskId', 'nodeId', 'branch', 'sha', 'record', 'builtAt']);
  assert.equal(pkg.version, 1);
  assert.equal(pkg.taskId, 'HUB1-01-x');
  assert.equal(pkg.builtAt, '2026-11-11T12:00:00.000Z');
  assert.deepEqual(pkg.record, { id: 'HUB1-01-x', title: 'T', rawDiff: 'diff --git a b', promptContext: { rawText: 'r' } });
  assert.deepEqual(PACKAGE_STRIP, ['localVotes', 'history']);
});

test('buildPackage does not change the record it was given', () => {
  const before = JSON.stringify(RECORD);
  buildPackage({ record: RECORD, nodeId: 'grimm', branch: 'agent/x', sha: SHA, now: T0 });
  assert.equal(JSON.stringify(RECORD), before);
});

test('scrub removes secret-like keys at any depth and inside arrays, case-insensitively, and keeps everything else', () => {
  const out = scrub({ a: 1, apiToken: 'x', Password: 'p', nested: { client_secret: 's', keep: [{ AUTH_TOKEN: 't', ok: 2 }, 3, null] }, list: [{ secretKey: 1 }], tokenCount: 5 });
  assert.deepEqual(out, { a: 1, nested: { keep: [{ ok: 2 }, 3, null] }, list: [{}] });
  assert.equal(scrub(5), 5);
  assert.equal(scrub(null), null);
});

test('a record with no id or a non-object record still builds (validation will refuse it)', () => {
  assert.equal(validatePackage(buildPackage({ record: { title: 'x' }, nodeId: 'grimm', branch: 'agent/x', sha: SHA })).ok, false);
  assert.equal(validatePackage(buildPackage({ record: null, nodeId: 'grimm', branch: 'agent/x', sha: SHA })).ok, false);
});

test('validatePackage accepts a good package and gives a specific reason for each failure', () => {
  const good = buildPackage({ record: RECORD, nodeId: 'grimm', branch: 'agent/x', sha: SHA, now: T0 });
  assert.deepEqual(validatePackage(good), { ok: true, reason: '' });
  const cases = [
    [null, /object/], [[], /object/], [{ ...good, version: 2 }, /version/], [{ ...good, record: null }, /record/], [{ ...good, record: [] }, /record/],
    [{ ...good, taskId: 'other' }, /taskId/], [{ ...good, taskId: '' }, /taskId/], [{ ...good, taskId: 5, record: { id: 5 } }, /taskId/],
    [{ ...good, nodeId: '' }, /nodeId/], [{ ...good, nodeId: 7 }, /nodeId/],
    [{ ...good, sha: 'abc' }, /sha/], [{ ...good, sha: 'A'.repeat(40) }, /sha/], [{ ...good, sha: SHA + '0' }, /sha/], [{ ...good, sha: 5 }, /sha/],
    [{ ...good, branch: 'main' }, /branch/], [{ ...good, branch: 7 }, /branch/],
  ];
  for (const [pkg, re] of cases) {
    const r = validatePackage(pkg);
    assert.equal(r.ok, false, JSON.stringify(pkg).slice(0, 60));
    assert.match(r.reason, re);
  }
});

function tokenFile(content) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-package-')), 'node-token');
  fs.writeFileSync(f, content, { mode: 0o600 });
  return f;
}

test('sendPackage POSTs the JSON with the trimmed bearer token and reports the status', async () => {
  const seen = [];
  const pkg = buildPackage({ record: RECORD, nodeId: 'grimm', branch: 'agent/x', sha: SHA, now: T0 });
  const post = async (url, headers, body, timeout) => { seen.push({ url, headers, body, timeout }); return { status: 200 }; };
  const r = await sendPackage(pkg, { url: 'http://wok:7473/package', tokenFile: tokenFile('tok-123\n'), post });
  assert.deepEqual(r, { ok: true, status: 200 });
  assert.equal(seen[0].url, 'http://wok:7473/package');
  assert.equal(seen[0].headers.Authorization, 'Bearer tok-123');
  assert.equal(seen[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0].body), pkg);
  assert.equal(seen[0].timeout, 15000);
  assert.equal(SEND_TIMEOUT_MS, 15000);
});

test('sendPackage: a missing, unreadable or blank token file sends nothing and answers {ok:false,status:0}', async () => {
  let called = 0;
  const post = async () => { called += 1; return { status: 200 }; };
  for (const tf of [path.join(os.tmpdir(), 'no-such-token-file'), tokenFile('  \n'), undefined]) {
    assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post }), { ok: false, status: 0 });
  }
  assert.equal(called, 0);
});

test('sendPackage never throws: a failing transport is {ok:false,status:0}; non-2xx statuses are not ok but keep their code', async () => {
  const tf = tokenFile('t');
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => { throw new Error('down'); } }), { ok: false, status: 0 });
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => ({ status: 401 }) }), { ok: false, status: 401 });
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => ({ status: 299 }) }), { ok: true, status: 299 });
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => ({ status: 300 }) }), { ok: false, status: 300 });
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => ({}) }), { ok: false, status: 0 });
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => null }), { ok: false, status: 0 });
});

test('the default transport really POSTs to a local server and reports its status; a closed port and a timeout reject', async () => {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { got.push({ auth: req.headers.authorization, body }); res.writeHead(202); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/package`;
  try {
    const r = await sendPackage({ hello: 'world' }, { url, tokenFile: tokenFile('real-token') });
    assert.deepEqual(r, { ok: true, status: 202 });
    assert.deepEqual(got, [{ auth: 'Bearer real-token', body: '{"hello":"world"}' }]);
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
  assert.deepEqual(await sendPackage({}, { url, tokenFile: tokenFile('t') }), { ok: false, status: 0 }, 'closed port');
  const slow = http.createServer(() => {});
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(httpPost(`http://127.0.0.1:${slow.address().port}/`, {}, '{}', 150), /timeout/);
  } finally { await new Promise((r) => { slow.close(r); slow.closeAllConnections(); }); }
});
