'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { lendTask, reclaimExpired, findRecordFile, main } = require('./lend-task.js');
const { leaseFor, listLeases } = require('./lease-ledger.js');
const { createServer } = require('./node-intake-server.js');

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const TOKEN = 'lender-token-' + 'z'.repeat(20);

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lend-task-'));
  const pipelineDir = path.join(dir, 'wok');
  for (const q of ['pending', 'adhoc']) fs.mkdirSync(path.join(pipelineDir, 'queue', q), { recursive: true });
  const tokenFile = path.join(dir, 'lender-token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const env = { HOME: dir, AGENT_MANAGER_NODES_DIR: path.join(dir, 'nodes'), AGENT_MANAGER_PIPELINE_DIR: pipelineDir };
  const put = (queue, id, extra = {}) => { const f = path.join(pipelineDir, 'queue', queue, `${id}.json`); fs.writeFileSync(f, JSON.stringify({ id, title: id, ...extra }, null, 2)); return f; };
  return { dir, pipelineDir, tokenFile, env, put };
}

const okPost = async () => ({ status: 200 });
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('a successful lend posts task and lease with the bearer token, stamps leasedTo on wok\'s record and keeps the lease lent', async () => {
  const w = world();
  const f = w.put('pending', 't1', { pad: 1 });
  const seen = [];
  const r = await lendTask({ taskId: 't1', nodeId: 'grimm', pipelineDir: w.pipelineDir, url: 'http://grimm:7472/lend', tokenFile: w.tokenFile, env: w.env, now: T0, post: async (url, headers, body, timeout) => { seen.push({ url, headers, body: JSON.parse(body), timeout }); return { status: 200 }; } });
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, 'http://grimm:7472/lend');
  assert.equal(seen[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].timeout, 15000);
  assert.deepEqual(seen[0].body.task, { id: 't1', title: 't1', pad: 1 });
  assert.deepEqual(seen[0].body.lease, { taskId: 't1', nodeId: 'grimm', expiresAt: '2026-11-11T18:00:00.000Z' });
  assert.equal(read(f).leasedTo, 'grimm');
  assert.equal(read(f).pad, 1);
  assert.equal(leaseFor('t1', w.env).state, 'lent');
});

test('the adhoc queue is searched when the task is not pending, and pending wins when both exist', async () => {
  const w = world();
  const a = w.put('adhoc', 'only-adhoc');
  assert.equal(findRecordFile(w.pipelineDir, 'only-adhoc'), a);
  const p = w.put('pending', 'both');
  w.put('adhoc', 'both');
  assert.equal(findRecordFile(w.pipelineDir, 'both'), p);
  assert.equal(findRecordFile(w.pipelineDir, 'none'), null);
  assert.equal((await lendTask({ taskId: 'only-adhoc', nodeId: 'grimm', pipelineDir: w.pipelineDir, url: 'u', tokenFile: w.tokenFile, env: w.env, post: okPost })).ok, true);
  assert.equal(read(a).leasedTo, 'grimm');
});

test('a failed lend (401, 409, a throwing transport, a missing status) cancels the lease and leaves the record byte-identical', async () => {
  for (const post of [async () => ({ status: 401 }), async () => ({ status: 409 }), async () => { throw new Error('down'); }, async () => ({}), async () => ({ status: 302 })]) {
    const w = world();
    const f = w.put('pending', 't1');
    const before = fs.readFileSync(f, 'utf8');
    const r = await lendTask({ taskId: 't1', nodeId: 'grimm', pipelineDir: w.pipelineDir, url: 'u', tokenFile: w.tokenFile, env: w.env, post });
    assert.equal(r.ok, false);
    assert.match(r.reason, /node answered|could not be reached/);
    assert.equal(fs.readFileSync(f, 'utf8'), before);
    assert.deepEqual(listLeases(w.env), [], 'the lease is cancelled');
  }
});

test('refusals: unknown task, a record already leased, a live lease, a missing or blank token file, missing arguments; nothing is sent', async () => {
  const w = world();
  let sent = 0;
  const post = async () => { sent += 1; return { status: 200 }; };
  const base = { nodeId: 'grimm', pipelineDir: w.pipelineDir, url: 'u', tokenFile: w.tokenFile, env: w.env, post };
  assert.match((await lendTask({ ...base, taskId: 'ghost' })).reason, /not in queue/);
  w.put('pending', 'leased', { leasedTo: 'other' });
  assert.match((await lendTask({ ...base, taskId: 'leased' })).reason, /already leased to other/);
  w.put('pending', 'live');
  require('./lease-ledger.js').lendLease('live', 'other', { env: w.env });
  assert.match((await lendTask({ ...base, taskId: 'live' })).reason, /live lease/);
  w.put('pending', 'notoken');
  assert.match((await lendTask({ ...base, taskId: 'notoken', tokenFile: path.join(w.dir, 'missing') })).reason, /token file/);
  fs.writeFileSync(path.join(w.dir, 'blank'), '  \n');
  assert.match((await lendTask({ ...base, taskId: 'notoken', tokenFile: path.join(w.dir, 'blank') })).reason, /token file/);
  assert.equal(leaseFor('notoken', w.env), null, 'no lease is taken when the token is unusable');
  assert.match((await lendTask({ ...base, taskId: '' })).reason, /required/);
  assert.match((await lendTask({ ...base, taskId: 'notoken', nodeId: '' })).reason, /required/);
  fs.writeFileSync(path.join(w.pipelineDir, 'queue', 'pending', 'junk.json'), '{oops');
  assert.match((await lendTask({ ...base, taskId: 'junk' })).reason, /not readable/);
  assert.equal(sent, 0);
});

test('a record that left the queue while lending is reported and the lease stays lent (the node has the task)', async () => {
  const w = world();
  const f = w.put('pending', 't1');
  const r = await lendTask({ taskId: 't1', nodeId: 'grimm', pipelineDir: w.pipelineDir, url: 'u', tokenFile: w.tokenFile, env: w.env, post: async () => { fs.unlinkSync(f); return { status: 200 }; } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /left the queue/);
  assert.equal(leaseFor('t1', w.env).state, 'lent');
  assert.equal(fs.existsSync(f), false, 'no record is recreated');
});

test('end to end against the real node intake: the node gets the record stamped leasedTo and wok\'s copy is stamped too', async () => {
  const w = world();
  const f = w.put('pending', 't1', { title: 'real' });
  const nodePipeline = path.join(w.dir, 'grimm-pipeline');
  const server = createServer({ env: { AGENT_MANAGER_LENDER_TOKEN_FILE: w.tokenFile, AGENT_MANAGER_PIPELINE_DIR: nodePipeline } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await lendTask({ taskId: 't1', nodeId: 'grimm', pipelineDir: w.pipelineDir, url: `http://127.0.0.1:${server.address().port}/lend`, tokenFile: w.tokenFile, env: w.env });
    assert.equal(r.ok, true);
    assert.equal(read(path.join(nodePipeline, 'queue', 'adhoc', 't1.json')).leasedTo, 'grimm');
    assert.equal(read(f).leasedTo, 'grimm');
    const again = await lendTask({ taskId: 't1', nodeId: 'grimm', pipelineDir: w.pipelineDir, url: `http://127.0.0.1:${server.address().port}/lend`, tokenFile: w.tokenFile, env: w.env });
    assert.equal(again.ok, false, 'a second lend of the same task is refused');
    const wrongToken = path.join(w.dir, 'wrong');
    fs.writeFileSync(wrongToken, 'not-the-token');
    w.put('pending', 't2');
    const bad = await lendTask({ taskId: 't2', nodeId: 'grimm', pipelineDir: w.pipelineDir, url: `http://127.0.0.1:${server.address().port}/lend`, tokenFile: wrongToken, env: w.env });
    assert.match(bad.reason, /401/);
    assert.equal(leaseFor('t2', w.env), null);
  } finally { server.close(); server.closeAllConnections(); }
});

test('reclaimExpired expires due leases, clears leasedTo only when it still names that node, and leaves live leases alone', () => {
  const w = world();
  const a = w.put('pending', 'a', { leasedTo: 'grimm' });
  const b = w.put('pending', 'b', { leasedTo: 'other-now' });
  const c = w.put('adhoc', 'c', { leasedTo: 'grimm' });
  const live = w.put('pending', 'live', { leasedTo: 'grimm' });
  const L = require('./lease-ledger.js');
  L.lendLease('a', 'grimm', { ttlMs: 1000, now: T0, env: w.env });
  L.lendLease('b', 'grimm', { ttlMs: 1000, now: T0, env: w.env });
  L.lendLease('c', 'grimm', { ttlMs: 1000, now: T0, env: w.env });
  L.lendLease('gone', 'grimm', { ttlMs: 1000, now: T0, env: w.env });
  L.lendLease('live', 'grimm', { ttlMs: 99999, now: T0, env: w.env });
  const expired = reclaimExpired({ pipelineDir: w.pipelineDir, now: T0 + 1000, env: w.env });
  assert.deepEqual(expired.map((l) => l.taskId).sort(), ['a', 'b', 'c', 'gone']);
  assert.equal('leasedTo' in read(a), false);
  assert.equal(read(b).leasedTo, 'other-now');
  assert.equal('leasedTo' in read(c), false);
  assert.equal(read(live).leasedTo, 'grimm');
  assert.deepEqual(reclaimExpired({ pipelineDir: w.pipelineDir, now: T0 + 1000, env: w.env }), []);
});

test('main: exit codes 0, 3 and 2, a JSON line without the token, and reclaim', async () => {
  const w = world();
  w.put('pending', 't1');
  const out = [];
  const run = (argv, deps) => main(argv, w.env, deps, (s) => out.push(s));
  const errs = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await run(['lend', 't1', 'grimm', '--url', 'http://x/lend', '--token-file', w.tokenFile], { post: okPost }), 0);
    assert.deepEqual(JSON.parse(out.pop()), { ok: true, reason: '' });
    assert.equal(await run(['lend', 't1', 'grimm', '--url', 'http://x/lend', '--token-file', w.tokenFile], { post: okPost }), 3);
    assert.ok(!out.join('').includes(TOKEN));
    assert.equal(await run(['reclaim']), 0);
    assert.equal(out.pop(), '[]');
    assert.equal(await run(['lend', 't1', 'grimm']), 2);
    assert.equal(await run(['bogus']), 2);
    assert.equal(await main(['reclaim'], { HOME: w.dir }, {}, () => {}), 2, 'no pipeline dir');
  } finally { process.stderr.write = errs; }
});

test('the CLI runs as a real process against a real local intake', async () => {
  const w = world();
  w.put('pending', 'cli1');
  const nodePipeline = path.join(w.dir, 'node-p');
  const server = createServer({ env: { AGENT_MANAGER_LENDER_TOKEN_FILE: w.tokenFile, AGENT_MANAGER_PIPELINE_DIR: nodePipeline } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await new Promise((resolve) => {
      const c = require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'lend-task.js'), 'lend', 'cli1', 'grimm', '--url', `http://127.0.0.1:${server.address().port}/lend`, '--token-file', w.tokenFile], { env: { ...process.env, ...w.env } });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, reason: '' });
    assert.ok(fs.existsSync(path.join(nodePipeline, 'queue', 'adhoc', 'cli1.json')));
  } finally { server.close(); server.closeAllConnections(); }
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, 'lend-task.js'), 'lend'], { env: { ...process.env, ...w.env }, encoding: 'utf8' }).status, 2);
});
