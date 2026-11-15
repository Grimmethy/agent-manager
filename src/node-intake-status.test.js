'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer } = require('./node-intake-server.js');

const TOKEN = 'test-lender-token';
const IN_PROGRESS = ['adhoc', 'pending', 'drafting', 'review', 'approved', 'node-outbox', 'coordinating'];

function setup(t, gitFn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pipelineDir = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'queue'), { recursive: true });
  const tokenFile = path.join(root, 'lender-token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const env = { HOME: root, AGENT_MANAGER_LENDER_TOKEN_FILE: tokenFile, AGENT_MANAGER_PIPELINE_DIR: pipelineDir };
  const calls = [];
  const git = gitFn || ((branch, base, dir) => { calls.push({ branch, base, dir }); return false; });
  return { root, pipelineDir, calls, server: createServer({ env, gitFn: git, repoDir: root }) };
}

function serve(t, server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve(server.address().port);
    });
  });
}

function put(pipelineDir, state, id, record = {}) {
  const dir = path.join(pipelineDir, 'queue', state);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, ...record }));
}

function post(port, body, token = TOKEN, urlPath = '/status') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

function getStatus(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/status' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return JSON.stringify(out);
}

test('each in-progress queue state answers in-progress', async (t) => {
  const { pipelineDir, server } = setup(t);
  IN_PROGRESS.forEach((s) => put(pipelineDir, s, `t-${s}`));
  const port = await serve(t, server);
  const ids = IN_PROGRESS.map((s) => `t-${s}`);
  const res = await post(port, { taskIds: ids });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  for (const id of ids) assert.equal(res.body.tasks[id], 'in-progress', id);
});

test('done with mergedAt answers merged', async (t) => {
  const { pipelineDir, server } = setup(t);
  put(pipelineDir, 'done', 't-done', { mergedAt: '2026-11-14T10:00:00.000Z' });
  const port = await serve(t, server);
  const res = await post(port, { taskIds: ['t-done'] });
  assert.deepEqual(res.body.tasks, { 't-done': 'merged' });
});

test('applied history with an ancestor branch answers merged, otherwise unknown', async (t) => {
  const seen = [];
  const ancestors = new Set(['agent/t-yes']);
  const { pipelineDir, server } = setup(t, (branch, base) => { seen.push({ branch, base }); return ancestors.has(branch); });
  put(pipelineDir, 'done', 't-yes', { history: [{ stage: 'applied', detail: 'agent/t-yes' }] });
  put(pipelineDir, 'done', 't-no', { history: [{ stage: 'applied', detail: 'agent/t-no' }] });
  const port = await serve(t, server);
  const res = await post(port, { taskIds: ['t-yes', 't-no'] });
  assert.deepEqual(res.body.tasks, { 't-yes': 'merged', 't-no': 'unknown' });
  assert.ok(seen.some((c) => c.branch === 'agent/t-yes' && c.base.startsWith('origin/')));
});

test('blocked, needs-clarification and awaiting-confirm answer unknown', async (t) => {
  const { pipelineDir, server } = setup(t);
  const states = ['blocked', 'needs-clarification', 'awaiting-confirm'];
  states.forEach((s) => put(pipelineDir, s, `t-${s}`));
  const port = await serve(t, server);
  const ids = states.map((s) => `t-${s}`);
  const res = await post(port, { taskIds: ids });
  for (const id of ids) assert.equal(res.body.tasks[id], 'unknown', id);
});

test('a mix of states answers each id, and an absent id is unknown', async (t) => {
  const { pipelineDir, server } = setup(t);
  put(pipelineDir, 'review', 't-live');
  put(pipelineDir, 'done', 't-shipped', { mergedAt: '2026-11-14T10:00:00.000Z' });
  const port = await serve(t, server);
  const res = await post(port, { taskIds: ['t-live', 't-shipped', 't-nowhere'] });
  assert.deepEqual(res.body.tasks, { 't-live': 'in-progress', 't-shipped': 'merged', 't-nowhere': 'unknown' });
});

test('a temp file in queue/adhoc does not count as in-progress', async (t) => {
  const { pipelineDir, server } = setup(t);
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'adhoc', '.t-tmp.json.tmp-1-2'), '{}');
  const port = await serve(t, server);
  const res = await post(port, { taskIds: ['t-tmp'] });
  assert.deepEqual(res.body.tasks, { 't-tmp': 'unknown' });
});

test('more than 50 ids answers 400, exactly 50 is accepted', async (t) => {
  const { server } = setup(t);
  const port = await serve(t, server);
  const fifty = Array.from({ length: 50 }, (_, i) => `t-${i}`);
  const ok = await post(port, { taskIds: fifty });
  assert.equal(ok.status, 200);
  assert.equal(Object.keys(ok.body.tasks).length, 50);
  const tooMany = await post(port, { taskIds: [...fifty, 't-50'] });
  assert.equal(tooMany.status, 400);
});

test('bad token answers 401, bad bodies answer 400', async (t) => {
  const { server } = setup(t);
  const port = await serve(t, server);
  assert.equal((await post(port, { taskIds: ['t-x'] }, 'wrong')).status, 401);
  assert.equal((await post(port, { taskIds: 'nope' })).status, 400);
  assert.equal((await post(port, { taskIds: [5] })).status, 400);
  assert.equal((await post(port, { taskIds: ['bad/id'] })).status, 400);
  assert.equal((await post(port, 'not json')).status, 400);
});

test('other paths answer 404 and GET answers 405', async (t) => {
  const { server } = setup(t);
  const port = await serve(t, server);
  assert.equal((await post(port, { taskIds: [] }, TOKEN, '/nope')).status, 404);
  assert.equal(await getStatus(port), 405);
});

test('a status request leaves the queue tree byte-identical', async (t) => {
  const { pipelineDir, server } = setup(t);
  put(pipelineDir, 'adhoc', 't-live');
  put(pipelineDir, 'done', 't-shipped', { mergedAt: '2026-11-14T10:00:00.000Z' });
  put(pipelineDir, 'blocked', 't-stuck');
  const before = snapshot(pipelineDir);
  const port = await serve(t, server);
  const res = await post(port, { taskIds: ['t-live', 't-shipped', 't-stuck', 't-missing'] });
  assert.equal(res.status, 200);
  assert.equal(snapshot(pipelineDir), before);
});
