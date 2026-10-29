'use strict';

// While the Forge family holds the GPU (PromptForge's comfyui-lease), NO new local-model call may start:
// a call that begins after the Forge session evicted the model reloads it (19+ GB) and starves ComfyUI.
// Live 2026-10-14: a pipeline task already in flight made a call ~5 min into a Forge session; ComfyUI was
// left with <1 GB of VRAM and the render stalled for 7+ minutes. The tick-level yield in local-worker.sh /
// review-runner.sh cannot see calls inside a running task, so call() itself checks the lease.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pause-'));
const LEASE = path.join(tmp, 'comfyui-lease.json');

let requests = 0;
const server = http.createServer((req, res) => {
  requests += 1;
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ response: 'APPROVE: fine', done: true, done_reason: 'stop', eval_count: 3, eval_duration: 1, load_duration: 1 }));
  });
});

// The env must be in place BEFORE the modules are required: both read it at load time.
let client;
let guard;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.AGENT_MANAGER_COMFY_LEASE_PATH = LEASE;
  process.env.AGENT_MANAGER_REPO_ROOT = tmp;   // makes local-client resolve an instances dir, i.e. it WOULD take an in-flight lock
  process.env.LOCAL_MODEL = 'fake-model';
  delete process.env.AGENT_MANAGER_FORGE_PAUSE;
  guard = require('./gpu-guard.js');
  client = require('./local-client.js');
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const writeLease = (ageS = 0) => {
  const t = new Date(Date.now() - ageS * 1000).toISOString();
  fs.writeFileSync(LEASE, JSON.stringify({ holder: 'promptforge', family: 'forge', acquiredAt: t, refreshedAt: t }));
};
// Spy on the in-flight lock: a paused call must never even try to take it (the lock is what PromptForge's acquire waits on).
let lockAcquires = 0;
test.before(() => {
  const lock = require('./model-inflight-lock.js');
  const orig = lock.acquire;
  lock.acquire = (...a) => { lockAcquires += 1; return orig(...a); };
});

test('a fresh lease: call() rejects with ForgePauseError, sends no request, takes no in-flight lock, and does not retry', async () => {
  writeLease(0);
  const before = requests;
  const locksBefore = lockAcquires;
  await assert.rejects(client.call({ prompt: 'hi' }), (e) => {
    assert.ok(e instanceof guard.ForgePauseError, 'ForgePauseError');
    assert.equal(e.message, guard.FORGE_PAUSE_MESSAGE);
    assert.ok(guard.isForgePause(e));
    return true;
  });
  assert.equal(requests, before, 'no HTTP request may reach Ollama');
  assert.equal(lockAcquires, locksBefore, 'no in-flight lock may be taken');
});

test('majorityVote under a fresh lease rejects immediately instead of tallying partial votes', async () => {
  writeLease(0);
  const before = requests;
  await assert.rejects(
    client.majorityVote({ prompt: 'vote', classify: (t) => (/APPROVE/.test(t) ? 'APPROVE' : null) }),
    (e) => guard.isForgePause(e),
  );
  assert.equal(requests, before);
});

test('a vote already in progress is abandoned, not counted as a lost vote, when the pause starts mid-way', async () => {
  // vote 1 succeeds (no lease); the lease appears before vote 2 -> the whole majorityVote must reject (not return 1 real vote)
  fs.rmSync(LEASE, { force: true });
  let n = 0;
  const origClassify = (t) => { n += 1; if (n === 1) writeLease(0); return /APPROVE/.test(t) ? 'APPROVE' : null; };
  await assert.rejects(
    client.majorityVote({ prompt: 'vote', classify: origClassify, n: 3, minAgreeing: 3 }),
    (e) => guard.isForgePause(e),
  );
});

test('no lease file: call() proceeds as before (and does take the in-flight lock, proving the spy sees it)', async () => {
  fs.rmSync(LEASE, { force: true });
  const before = requests;
  const locksBefore = lockAcquires;
  const r = await client.call({ prompt: 'hi' });
  assert.match(r.response, /APPROVE/);
  assert.equal(requests, before + 1);
  assert.equal(lockAcquires, locksBefore + 1);
});

test('a stale lease (older than the TTL): call() proceeds as before', async () => {
  writeLease(600);
  const before = requests;
  const r = await client.call({ prompt: 'hi' });
  assert.match(r.response, /APPROVE/);
  assert.equal(requests, before + 1);
});

test('an unreadable / malformed lease is treated as not held (fail open): call() proceeds', async () => {
  fs.writeFileSync(LEASE, '{not json');
  const before = requests;
  await client.call({ prompt: 'hi' });
  assert.equal(requests, before + 1);
});

test('kill switch AGENT_MANAGER_FORGE_PAUSE=off: a fresh lease no longer pauses call()', async () => {
  writeLease(0);
  process.env.AGENT_MANAGER_FORGE_PAUSE = 'off';
  try {
    const before = requests;
    await client.call({ prompt: 'hi' });
    assert.equal(requests, before + 1);
  } finally { delete process.env.AGENT_MANAGER_FORGE_PAUSE; }
});

// ---- endpoint-scoped lease: only a call to a leased card is paused ----------------------------------------------------------------------------
const writeScopedLease = (endpoints) => {
  const t = new Date().toISOString();
  fs.writeFileSync(LEASE, JSON.stringify({ holder: 'kaggleforge', family: 'forge', endpoints, acquiredAt: t, refreshedAt: t }));
};

test('a lease scoped to ANOTHER card does not pause this lane: call() proceeds and sends its request', async () => {
  writeScopedLease(['http://192.168.122.29:11434']);
  const before = requests;
  const r = await client.call({ prompt: 'hi' });
  assert.match(r.response, /APPROVE/);
  assert.equal(requests, before + 1);
});

test('a lease scoped to THIS card (written as localhost, the lane uses 127.0.0.1) pauses it: ForgePauseError, no request', async () => {
  writeScopedLease([`http://localhost:${server.address().port}`]);
  const before = requests;
  await assert.rejects(() => client.call({ prompt: 'hi' }), (e) => guard.isForgePause(e));
  assert.equal(requests, before, 'no request reached the card');
});

test('a scoped lease also pauses majorityVote (the reviewer path) for the leased card, and not for another', async () => {
  const classify = (t) => ({ verdict: 'approve' });
  writeScopedLease([`http://127.0.0.1:${server.address().port}`]);
  await assert.rejects(() => client.majorityVote({ prompt: 'x', classify, n: 3 }), (e) => guard.isForgePause(e));
  writeScopedLease(['http://192.168.122.29:11434']);
  const before = requests;
  await client.majorityVote({ prompt: 'x', classify, n: 3 });
  assert.ok(requests > before, 'votes were cast');
});
