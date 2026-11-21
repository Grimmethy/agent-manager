'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { scrub, buildPackage, buildRecordPackage, validatePackage, sendPackage, httpPost, isStopRecord, hasDraft, PACKAGE_STRIP, RECORD_PACKAGE_STRIP, SEND_TIMEOUT_MS } = require('./review-package.js');

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
    [null, /object/], [[], /object/], [{ ...good, version: 3 }, /version/], [{ ...good, version: 0 }, /version/], [{ ...good, record: null }, /record/], [{ ...good, record: [] }, /record/],
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
  assert.deepEqual(r, { ok: true, status: 200, body: '' });
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
    assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post }), { ok: false, status: 0, body: '' });
  }
  assert.equal(called, 0);
});

test('sendPackage never throws: a failing transport is {ok:false,status:0}; non-2xx statuses are not ok but keep their code', async () => {
  const tf = tokenFile('t');
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => { throw new Error('down'); } }), { ok: false, status: 0, body: '' });
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => ({ status: 401, body: 'refused: bad token' }) }), { ok: false, status: 401, body: 'refused: bad token' });
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => ({ status: 299 }) }), { ok: true, status: 299, body: '' });
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => ({ status: 300 }) }), { ok: false, status: 300, body: '' });
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => ({}) }), { ok: false, status: 0, body: '' });
  assert.deepEqual(await sendPackage({}, { url: 'http://x', tokenFile: tf, post: async () => null }), { ok: false, status: 0, body: '' });
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
    assert.deepEqual(r, { ok: true, status: 202, body: '' });
    assert.deepEqual(got, [{ auth: 'Bearer real-token', body: '{"hello":"world"}' }]);
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
  assert.deepEqual(await sendPackage({}, { url, tokenFile: tokenFile('t') }), { ok: false, status: 0, body: '' }, 'closed port');
  const slow = http.createServer(() => {});
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(httpPost(`http://127.0.0.1:${slow.address().port}/`, {}, '{}', 150), /timeout/);
  } finally { await new Promise((r) => { slow.close(r); slow.closeAllConnections(); }); }
});

const DRAFT = { id: 'HUB2-01-x', title: 'T', rawDiff: 'diff --git a b', implementResponse: 'did it', leasedTo: 'grimm', localVotes: [{ verdict: 'APPROVE' }], history: [{ stage: 'x' }], apiToken: 't', nested: { password: 'p', keep: 1 } };

test('buildRecordPackage has the version 2 contract shape, no branch or sha, and drops votes, history, leasedTo and secret keys at any depth', () => {
  const pkg = buildRecordPackage({ record: DRAFT, nodeId: 'grimm', now: T0 });
  assert.deepEqual(Object.keys(pkg), ['version', 'kind', 'taskId', 'nodeId', 'record', 'builtAt']);
  assert.equal(pkg.version, 2);
  assert.equal(pkg.kind, 'record');
  assert.equal(pkg.taskId, 'HUB2-01-x');
  assert.equal(pkg.builtAt, '2026-11-11T12:00:00.000Z');
  assert.deepEqual(pkg.record, { id: 'HUB2-01-x', title: 'T', rawDiff: 'diff --git a b', implementResponse: 'did it', nested: { keep: 1 } });
  assert.deepEqual(RECORD_PACKAGE_STRIP, ['localVotes', 'history', 'leasedTo']);
  assert.equal(DRAFT.leasedTo, 'grimm');
  assert.equal(DRAFT.localVotes.length, 1);
});

test('buildRecordPackage with no record gives a package that validatePackage refuses', () => {
  const pkg = buildRecordPackage({ record: undefined, nodeId: 'grimm', now: T0 });
  assert.equal(pkg.taskId, undefined);
  assert.equal(validatePackage(pkg).ok, false);
});

test('validatePackage accepts a good version 2 package and gives a specific reason for each failure', () => {
  const good = buildRecordPackage({ record: DRAFT, nodeId: 'grimm', now: T0 });
  assert.deepEqual(validatePackage(good), { ok: true, reason: '' });
  const cases = [
    [{ ...good, kind: 'branch' }, /kind/], [{ ...good, kind: undefined }, /kind/],
    [{ ...good, record: { ...good.record, rawDiff: '' } }, /rawDiff/], [{ ...good, record: { ...good.record, rawDiff: undefined } }, /rawDiff/], [{ ...good, record: { ...good.record, rawDiff: 5 } }, /rawDiff/],
    [{ ...good, taskId: 'other' }, /taskId/], [{ ...good, nodeId: '' }, /nodeId/], [{ ...good, record: [] }, /record/], [{ ...good, record: null }, /record/],
  ];
  for (const [pkg, re] of cases) {
    const r = validatePackage(pkg);
    assert.equal(r.ok, false, JSON.stringify(pkg).slice(0, 60));
    assert.match(r.reason, re);
  }
});

test('a version 1 package still needs its sha and branch, and a version 2 package does not', () => {
  const v1 = buildPackage({ record: RECORD, nodeId: 'grimm', branch: 'agent/x', sha: SHA, now: T0 });
  assert.equal(validatePackage({ ...v1, sha: undefined }).ok, false);
  assert.equal(validatePackage({ ...v1, branch: undefined }).ok, false);
  const v2 = buildRecordPackage({ record: DRAFT, nodeId: 'grimm', now: T0 });
  assert.equal('sha' in v2 || 'branch' in v2, false);
  assert.equal(validatePackage(v2).ok, true);
});

test('a decompose parent with two proposals and an empty rawDiff is ok; the same parent with no proposals, another adhocResolution, or a proposal without rawText is refused', () => {
  const proposals = [{ title: 'a', rawText: 'do a' }, { title: 'b', rawText: 'do b' }];
  const parent = { ...DRAFT, rawDiff: '', adhocResolution: 'decompose', subTaskProposals: proposals };
  const pkg = buildRecordPackage({ record: parent, nodeId: 'grimm', now: T0 });
  assert.deepEqual(validatePackage(pkg), { ok: true, reason: '' });
  const refused = [
    { ...parent, subTaskProposals: [] },
    { ...parent, adhocResolution: 'other' },
    { ...parent, subTaskProposals: [{ title: 'a', rawText: 'do a' }, { title: 'b' }] },
  ];
  for (const record of refused) {
    const r = validatePackage({ ...pkg, record: { ...pkg.record, ...record, rawDiff: '' } });
    assert.equal(r.ok, false, JSON.stringify(record).slice(0, 60));
    assert.match(r.reason, /rawDiff/);
  }
});

test('a normal record with a non-empty rawDiff still passes validation', () => {
  const pkg = buildRecordPackage({ record: { ...DRAFT, adhocResolution: 'decompose', subTaskProposals: [{ title: 'a', rawText: 'x' }] }, nodeId: 'grimm', now: T0 });
  assert.deepEqual(validatePackage(pkg), { ok: true, reason: '' });
});

const STOP = { needsClarification: { reason: 'design-decision', openQuestions: 'which?' } };

test('isStopRecord is true only for a plain object with a non-empty string reason', () => {
  assert.equal(isStopRecord({ ...DRAFT, rawDiff: '', ...STOP }), true);
  for (const r of [null, undefined, { needsClarification: null }, { needsClarification: [] }, { needsClarification: 'x' },
    { needsClarification: {} }, { needsClarification: { reason: '' } }, { needsClarification: { reason: 5 } },
    { needsClarification: { openQuestions: 'x' } }, { title: 'no stop' }]) {
    assert.equal(isStopRecord(r), false, JSON.stringify(r));
  }
});

test('validatePackage accepts a stop record with rawDiff empty or absent, and refuses the same empty rawDiff otherwise', () => {
  const msg = 'record.rawDiff must be a non-empty string';
  const absent = { ...DRAFT, ...STOP }; delete absent.rawDiff;
  assert.deepEqual(validatePackage(buildRecordPackage({ record: { ...DRAFT, ...STOP, rawDiff: '' }, nodeId: 'grimm', now: T0 })), { ok: true, reason: '' });
  assert.deepEqual(validatePackage(buildRecordPackage({ record: absent, nodeId: 'grimm', now: T0 })), { ok: true, reason: '' });
  const noReason = validatePackage(buildRecordPackage({ record: { ...DRAFT, rawDiff: '', needsClarification: {} }, nodeId: 'grimm', now: T0 }));
  assert.equal(noReason.ok, false);
  assert.equal(noReason.reason, msg);
  const noStop = validatePackage(buildRecordPackage({ record: { ...DRAFT, rawDiff: '' }, nodeId: 'grimm', now: T0 }));
  assert.equal(noStop.ok, false);
  assert.equal(noStop.reason, msg);
});

test('a stop record with a non-string rawDiff (a number or an object) is refused, not accepted as a stop record', () => {
  const msg = 'record.rawDiff must be a non-empty string';
  for (const rawDiff of [5, {}]) {
    const r = validatePackage(buildRecordPackage({ record: { ...DRAFT, ...STOP, rawDiff }, nodeId: 'grimm', now: T0 }));
    assert.equal(r.ok, false, JSON.stringify(rawDiff));
    assert.equal(r.reason, msg);
  }
});

test('isStopRecord is false for an array needsClarification even when the array has a string reason property', () => {
  const arr = ['x'];
  arr.reason = 'design-decision';
  assert.equal(isStopRecord({ ...DRAFT, needsClarification: arr }), false);
});

test('a no-changes-needed record with an empty or absent rawDiff is a valid version 2 package', () => {
  const noop = { id: 'HUB3-01-x', title: 'T', adhocResolution: 'no-changes-needed', rawDiff: '' };
  assert.deepEqual(validatePackage(buildRecordPackage({ record: noop, nodeId: 'grimm', now: T0 })), { ok: true, reason: '' });
  const absent = { ...noop }; delete absent.rawDiff;
  assert.deepEqual(validatePackage(buildRecordPackage({ record: absent, nodeId: 'grimm', now: T0 })), { ok: true, reason: '' });
});

test('an undrafted record is refused with record has no draft', () => {
  for (const record of [{ id: 'HUB3-02-x', title: 'T' }, { id: 'HUB3-02-x', title: 'T', rawDiff: '' }]) {
    const r = validatePackage(buildRecordPackage({ record, nodeId: 'grimm', now: T0 }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'record has no draft');
  }
});

test('stop records and decompose parents are still valid version 2 packages', () => {
  const stop = { id: 'HUB3-03-x', title: 'T', ...STOP };
  assert.deepEqual(validatePackage(buildRecordPackage({ record: stop, nodeId: 'grimm', now: T0 })), { ok: true, reason: '' });
  const parent = { id: 'HUB3-04-x', title: 'T', rawDiff: '', adhocResolution: 'decompose', subTaskProposals: [{ title: 'a', rawText: 'do a' }] };
  assert.deepEqual(validatePackage(buildRecordPackage({ record: parent, nodeId: 'grimm', now: T0 })), { ok: true, reason: '' });
});

test('hasDraft is true for each draft signal and false for nothing', () => {
  assert.equal(hasDraft({ implementResponse: 'x' }), true);
  assert.equal(hasDraft({ rawDiff: 'diff' }), true);
  assert.equal(hasDraft({ adhocResolution: 'no-changes-needed' }), true);
  assert.equal(hasDraft({ ...STOP }), true);
  assert.equal(hasDraft({ adhocResolution: 'decompose', subTaskProposals: [{ title: 'a', rawText: 'b' }] }), true);
  for (const r of [null, undefined, 5, {}, { rawDiff: '' }]) assert.equal(hasDraft(r), false, JSON.stringify(r));
});

test('httpPost keeps at most 300 characters of the reply body', async () => {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(400); res.end('x'.repeat(1000)); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await httpPost(`http://127.0.0.1:${server.address().port}/`, {}, '{}', 2000);
    assert.equal(r.status, 400);
    assert.equal(r.body.length, 300);
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
});
