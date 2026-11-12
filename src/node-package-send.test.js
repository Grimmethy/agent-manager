'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main, flag } = require('./node-package-send.js');
const { createServer } = require('./package-intake-server.js');
const { registerNode } = require('./node-registry.js');
const { lendLease, leaseFor } = require('./lease-ledger.js');

const SECRET = 'tok-SECRET-1234567890';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-send-'));
  const outbox = path.join(dir, 'queue', 'node-outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const tokenFile = path.join(dir, 'node-token');
  fs.writeFileSync(tokenFile, `${SECRET}\n`, { mode: 0o600 });
  return { dir, outbox, sent: path.join(dir, 'queue', 'node-sent'), tokenFile };
}

function put(s, name, record) {
  fs.writeFileSync(path.join(s.outbox, name), typeof record === 'string' ? record : JSON.stringify(record));
}

function argvFor(s, extra = {}) {
  const a = { '--url': 'http://127.0.0.1:1/package', '--token-file': s.tokenFile, '--node-id': 'grimm', '--outbox': s.outbox, ...extra };
  return Object.entries(a).flatMap(([k, v]) => (v === null ? [] : [k, v]));
}

async function run(s, { post, extra, now } = {}) {
  const lines = [];
  const errs = [];
  const code = await main(argvFor(s, extra), {}, { post, now }, (l) => lines.push(l), (e) => errs.push(e));
  return { code, lines, errs, result: lines.length ? JSON.parse(lines[0]) : null };
}

const ok = async () => ({ status: 200 });
const REC = (id) => ({ id, title: 'T', rawDiff: 'diff --git a b', implementResponse: 'did it', leasedTo: 'grimm', localVotes: [1], history: [2], apiToken: 'x' });

test('flag returns the value after a flag and nothing for an absent, last or flag-followed flag', () => {
  assert.equal(flag(['--url', 'u'], '--url'), 'u');
  assert.equal(flag(['--url'], '--url'), undefined);
  assert.equal(flag(['--url', '--outbox', 'o'], '--url'), undefined);
  assert.equal(flag([], '--url'), undefined);
});

test('missing arguments exit 2 with the usage line and send nothing', async () => {
  const s = setup();
  put(s, 'a.json', REC('a'));
  let posts = 0;
  for (const flagName of ['--url', '--token-file', '--node-id', '--outbox']) {
    const r = await run(s, { post: async () => { posts += 1; return { status: 200 }; }, extra: { [flagName]: null } });
    assert.equal(r.code, 2, flagName);
    assert.match(r.errs.join(''), /^usage: node src\/node-package-send\.js /);
    assert.equal(r.lines.length, 0);
  }
  assert.equal(posts, 0);
  assert.deepEqual(fs.readdirSync(s.outbox), ['a.json']);
});

test('an unreadable or empty token file, and an outbox that is not a directory, exit 2 and send nothing', async () => {
  const s = setup();
  put(s, 'a.json', REC('a'));
  let posts = 0;
  const post = async () => { posts += 1; return { status: 200 }; };
  assert.equal((await run(s, { post, extra: { '--token-file': path.join(s.dir, 'nope') } })).code, 2);
  fs.writeFileSync(s.tokenFile, '  \n');
  const empty = await run(s, { post });
  assert.equal(empty.code, 2);
  assert.match(empty.errs.join(''), /token file/);
  fs.writeFileSync(s.tokenFile, SECRET);
  const file = path.join(s.dir, 'plain-file');
  fs.writeFileSync(file, 'x');
  const notDir = await run(s, { post, extra: { '--outbox': file } });
  assert.equal(notDir.code, 2);
  assert.match(notDir.errs.join(''), /outbox/);
  assert.equal((await run(s, { post, extra: { '--outbox': path.join(s.dir, 'missing') } })).code, 2);
  assert.equal(posts, 0);
});

test('a 2xx answer moves each record to node-sent next to the outbox, in name order, and the package is version 2 without votes or the lease stamp', async () => {
  const s = setup();
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']; // eight records, created in ascending order: a listing comes back newest first on tmpfs and in hash order elsewhere, so only sorting gives this order
  for (const id of ids) put(s, `${id}.json`, REC(id));
  const seen = [];
  const post = async (url, headers, body) => { seen.push({ url, headers, pkg: JSON.parse(body) }); return { status: 200 }; };
  const r = await run(s, { post, now: () => Date.UTC(2026, 10, 11) });
  assert.equal(r.code, 0);
  assert.deepEqual(r.result, { sent: 8, failed: 0, remaining: 0 });
  assert.deepEqual(fs.readdirSync(s.outbox), []);
  assert.deepEqual(fs.readdirSync(s.sent).sort(), ids.map((id) => `${id}.json`));
  assert.deepEqual(seen.map((x) => x.pkg.taskId), ids);
  assert.equal(seen[0].url, 'http://127.0.0.1:1/package');
  assert.equal(seen[0].headers.Authorization, `Bearer ${SECRET}`);
  const pkg = seen[0].pkg;
  assert.equal(pkg.version, 2);
  assert.equal(pkg.kind, 'record');
  assert.equal(pkg.nodeId, 'grimm');
  assert.equal(pkg.builtAt, '2026-11-11T00:00:00.000Z');
  assert.equal(pkg.record.rawDiff, 'diff --git a b');
  for (const key of ['leasedTo', 'localVotes', 'history', 'apiToken']) assert.equal(key in pkg.record, false, key);
});

test('a refusal, a network failure and a thrown send leave the record in the outbox, count failed and exit 3', async () => {
  for (const post of [async () => ({ status: 409 }), async () => ({ status: 500 }), async () => { throw new Error('down'); }]) {
    const s = setup();
    put(s, 'a.json', REC('a'));
    const r = await run(s, { post });
    assert.equal(r.code, 3);
    assert.deepEqual(r.result, { sent: 0, failed: 1, remaining: 1 });
    assert.deepEqual(fs.readdirSync(s.outbox), ['a.json']);
    assert.equal(fs.existsSync(s.sent), false);
  }
});

test('records that are not JSON, have no string id or an empty id are failed and left; good records around them are still sent', async () => {
  const s = setup();
  put(s, 'a-good.json', REC('a'));
  put(s, 'b-junk.json', '{not json');
  put(s, 'c-noid.json', { title: 'x' });
  put(s, 'd-numid.json', { id: 5 });
  put(s, 'e-emptyid.json', { id: '' });
  put(s, 'f-good.json', REC('f'));
  fs.writeFileSync(path.join(s.outbox, 'notes.txt'), 'not a record');
  const r = await run(s, { post: ok });
  assert.equal(r.code, 3);
  assert.deepEqual(r.result, { sent: 2, failed: 4, remaining: 4 });
  assert.deepEqual(fs.readdirSync(s.outbox).sort(), ['b-junk.json', 'c-noid.json', 'd-numid.json', 'e-emptyid.json', 'notes.txt']);
});

test('a move into node-sent that fails leaves the record in the outbox and counts it failed instead of throwing', async () => {
  const s = setup();
  put(s, 'a.json', REC('a'));
  fs.writeFileSync(s.sent, 'a plain file where the directory should be');
  const r = await run(s, { post: ok });
  assert.equal(r.code, 3);
  assert.deepEqual(r.result, { sent: 0, failed: 1, remaining: 1 });
});

test('a record filed while the send is running is not sent this time and is counted as remaining', async () => {
  const s = setup();
  put(s, 'a.json', REC('a'));
  const post = async () => { put(s, 'z-new.json', REC('z')); return { status: 200 }; };
  const r = await run(s, { post });
  assert.equal(r.code, 0);
  assert.deepEqual(r.result, { sent: 1, failed: 0, remaining: 1 });
  assert.deepEqual(fs.readdirSync(s.outbox), ['z-new.json']);
});

test('an empty outbox prints zero counts and exits 0 without posting', async () => {
  const s = setup();
  let posts = 0;
  const r = await run(s, { post: async () => { posts += 1; return { status: 200 }; } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.result, { sent: 0, failed: 0, remaining: 0 });
  assert.equal(posts, 0);
});

test('the token never appears in the output, the errors or the result, on success or failure', async () => {
  const s = setup();
  put(s, 'a.json', REC('a'));
  const bad = await run(s, { post: async () => { throw new Error(`boom ${SECRET}`); } });
  const good = await run(s, { post: ok });
  const empty = await run(s, { post: ok, extra: { '--token-file': path.join(s.dir, 'nope') } });
  for (const r of [bad, good, empty]) assert.equal((r.lines.join('') + r.errs.join('')).includes(SECRET), false);
});

test('a real round trip: the package intake on wok replaces the leased original with the node record in queue/review, ends the lease, and the outbox record moves to node-sent', async () => {
  const s = setup();
  const wok = fs.mkdtempSync(path.join(os.tmpdir(), 'wok-side-'));
  const env = { HOME: wok, AGENT_MANAGER_NODES_DIR: path.join(wok, 'nodes'), AGENT_MANAGER_PIPELINE_DIR: path.join(wok, 'pipeline') };
  const { token } = registerNode({ id: 'grimm', address: '', cores: 4, ramGb: 15, concurrencyCap: 2 }, env);
  fs.writeFileSync(s.tokenFile, token, { mode: 0o600 });
  lendLease('HUB7-01-x', 'grimm', { env });
  const adhoc = path.join(env.AGENT_MANAGER_PIPELINE_DIR, 'queue', 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  fs.writeFileSync(path.join(adhoc, 'HUB7-01-x.json'), JSON.stringify({ id: 'HUB7-01-x', title: 'T', leasedTo: 'grimm' }));
  put(s, 'HUB7-01-x.json', { ...REC('HUB7-01-x'), status: 'needs-review' });
  const server = createServer({ env, send: async () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/package`;
    const r = await run(s, { extra: { '--url': url } });
    assert.equal(r.code, 0, r.errs.join(''));
    assert.deepEqual(r.result, { sent: 1, failed: 0, remaining: 0 });
    const filed = JSON.parse(fs.readFileSync(path.join(env.AGENT_MANAGER_PIPELINE_DIR, 'queue', 'review', 'HUB7-01-x.json'), 'utf8'));
    assert.equal(filed.fromNode, 'grimm');
    assert.equal(filed.status, 'needs-review');
    assert.equal(filed.rawDiff, 'diff --git a b');
    assert.equal('leasedTo' in filed, false);
    assert.equal(fs.existsSync(path.join(adhoc, 'HUB7-01-x.json')), false);
    assert.equal(leaseFor('HUB7-01-x', env).state, 'returned');
    assert.deepEqual(fs.readdirSync(s.sent), ['HUB7-01-x.json']);
  } finally { server.close(); server.closeAllConnections(); }
});

test('the command line exits 2 with the usage line when it is given nothing', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'node-package-send.js')], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^usage: node src\/node-package-send\.js /);
  assert.equal(r.stdout, '');
});
