'use strict';

// Tests for src/node-status-client.js makeAskNode(): the URL, header and body it sends, the three answers, and 'unknown' for every failure.
// A fake post is injected; one test runs the real default post against a loopback server. Temp HOME and token files, no network beyond 127.0.0.1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { makeAskNode } = require('./node-status-client.js');

function setup(t, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-status-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'lender-token');
  fs.writeFileSync(tokenFile, 'secret-token\n', { mode: 0o600 });
  const env = { HOME: root, AGENT_MANAGER_LENDER_TOKEN_FILE: tokenFile, ...extraEnv };
  const readRegistry = () => ({ grimm: { id: 'grimm', address: '192.168.40.12' }, empty: { id: 'empty', address: '' }, odd: { id: 'odd', address: 'a b/c' } });
  return { root, env, readRegistry };
}

function fakePost(answer) {
  const calls = [];
  const post = async (url, headers, body, timeoutMs) => {
    calls.push({ url, headers, body, timeoutMs });
    if (typeof answer === 'function') return answer();
    return answer;
  };
  return { post, calls };
}

const ok = (tasks) => ({ status: 200, body: JSON.stringify({ ok: true, tasks }) });

test('asks the node at its registered address and the default port with the bearer token and the task id', async (t) => {
  const { env, readRegistry } = setup(t);
  const fp = fakePost(ok({ t1: 'in-progress' }));
  const answer = await makeAskNode({ env, post: fp.post, readRegistry })('grimm', 't1');
  assert.equal(answer, 'in-progress');
  assert.equal(fp.calls.length, 1);
  assert.equal(fp.calls[0].url, 'http://192.168.40.12:7472/status');
  assert.equal(fp.calls[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(fp.calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(fp.calls[0].body), { taskIds: ['t1'] });
  assert.equal(fp.calls[0].timeoutMs, 15000);
});

test('AGENT_MANAGER_INTAKE_PORT changes the port', async (t) => {
  const { env, readRegistry } = setup(t, { AGENT_MANAGER_INTAKE_PORT: '9001' });
  const fp = fakePost(ok({ t1: 'merged' }));
  assert.equal(await makeAskNode({ env, post: fp.post, readRegistry })('grimm', 't1'), 'merged');
  assert.equal(fp.calls[0].url, 'http://192.168.40.12:9001/status');
});

test('merged, in-progress and unknown answers are passed through; anything else is unknown', async (t) => {
  const { env, readRegistry } = setup(t);
  for (const [value, want] of [['merged', 'merged'], ['in-progress', 'in-progress'], ['unknown', 'unknown'], ['done', 'unknown'], [null, 'unknown'], [5, 'unknown']]) {
    const fp = fakePost(ok({ t1: value }));
    assert.equal(await makeAskNode({ env, post: fp.post, readRegistry })('grimm', 't1'), want, String(value));
  }
});

test('every failure shape answers unknown and never throws', async (t) => {
  const { env, readRegistry } = setup(t);
  const cases = {
    'unknown node': () => makeAskNode({ env, post: fakePost(ok({})).post, readRegistry })('nobody', 't1'),
    'no address': () => makeAskNode({ env, post: fakePost(ok({})).post, readRegistry })('empty', 't1'),
    'address with a space and slash': () => makeAskNode({ env, post: fakePost(ok({ t1: 'merged' })).post, readRegistry })('odd', 't1'),
    'no token file': () => makeAskNode({ env: { ...env, AGENT_MANAGER_LENDER_TOKEN_FILE: '/nonexistent/token' }, post: fakePost(ok({ t1: 'merged' })).post, readRegistry })('grimm', 't1'),
    'empty token file': () => { const empty = path.join(env.HOME, 'empty-token'); fs.writeFileSync(empty, '\n'); return makeAskNode({ env: { ...env, AGENT_MANAGER_LENDER_TOKEN_FILE: empty }, post: fakePost(ok({ t1: 'merged' })).post, readRegistry })('grimm', 't1'); },
    'token env unset': () => makeAskNode({ env: { HOME: env.HOME }, post: fakePost(ok({ t1: 'merged' })).post, readRegistry })('grimm', 't1'),
    'http 500': () => makeAskNode({ env, post: fakePost({ status: 500, body: JSON.stringify({ ok: true, tasks: { t1: 'merged' } }) }).post, readRegistry })('grimm', 't1'),
    'http 401': () => makeAskNode({ env, post: fakePost({ status: 401, body: '{}' }).post, readRegistry })('grimm', 't1'),
    'bad json': () => makeAskNode({ env, post: fakePost({ status: 200, body: 'not json' }).post, readRegistry })('grimm', 't1'),
    'ok false': () => makeAskNode({ env, post: fakePost({ status: 200, body: JSON.stringify({ ok: false, tasks: { t1: 'merged' } }) }).post, readRegistry })('grimm', 't1'),
    'no tasks key': () => makeAskNode({ env, post: fakePost({ status: 200, body: JSON.stringify({ ok: true }) }).post, readRegistry })('grimm', 't1'),
    'post throws': () => makeAskNode({ env, post: async () => { throw new Error('boom'); }, readRegistry })('grimm', 't1'),
    'no response': () => makeAskNode({ env, post: async () => undefined, readRegistry })('grimm', 't1'),
    'registry throws': () => makeAskNode({ env, post: fakePost(ok({})).post, readRegistry: () => { throw new Error('bad registry'); } })('grimm', 't1'),
  };
  for (const [name, run] of Object.entries(cases)) assert.equal(await run(), 'unknown', name);
});

test('no request is sent when the node, address or token is missing', async (t) => {
  const { env, readRegistry } = setup(t);
  const fp = fakePost(ok({ t1: 'merged' }));
  await makeAskNode({ env, post: fp.post, readRegistry })('nobody', 't1');
  await makeAskNode({ env, post: fp.post, readRegistry })('empty', 't1');
  await makeAskNode({ env: { HOME: env.HOME }, post: fp.post, readRegistry })('grimm', 't1');
  assert.equal(fp.calls.length, 0);
});

test('the default post really talks to a node intake: bearer header, JSON body and the answer come back', async (t) => {
  const { env } = setup(t);
  const seen = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(data) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, tasks: { t9: 'merged' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((done) => server.close(done)));
  const askNode = makeAskNode({ env: { ...env, AGENT_MANAGER_INTAKE_PORT: String(server.address().port) }, readRegistry: () => ({ n1: { address: '127.0.0.1' } }) });
  assert.equal(await askNode('n1', 't9'), 'merged');
  assert.deepEqual(seen, [{ url: '/status', method: 'POST', auth: 'Bearer secret-token', body: { taskIds: ['t9'] } }]);
});

test('a blocked answer comes back with the node\'s reason, capped at 300 characters', async (t) => {
  const { env, readRegistry } = setup(t);
  const body = JSON.stringify({ ok: true, tasks: { t1: 'blocked' }, reasons: { t1: 'z'.repeat(500) } });
  const answer = await makeAskNode({ env, post: fakePost({ status: 200, body }).post, readRegistry })('grimm', 't1');
  assert.equal(answer.answer, 'blocked');
  assert.equal(answer.reason.length, 300);
});

test('a blocked answer without a reasons map has an empty reason', async (t) => {
  const { env, readRegistry } = setup(t);
  const answer = await makeAskNode({ env, post: fakePost(ok({ t1: 'blocked' })).post, readRegistry })('grimm', 't1');
  assert.deepEqual(answer, { answer: 'blocked', reason: '' });
});
