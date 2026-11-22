'use strict';

// redo-supersede-sweep.js: a merged redo retires the card of the task it replaced. Fixture projects on disk, an injected dashboard request, and an end-to-end
// run of the real CLI against a fake dashboard http server. Run: node --test src/redo-supersede-sweep.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');
const { sweep, mergedRedos, mode, norm } = require('./redo-supersede-sweep.js');

const SCRIPT = path.join(__dirname, 'redo-supersede-sweep.js');
const quiet = () => {};

function project(label, tasks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `supersede-${label}-`));
  const pipelineDir = path.join(root, 'pipe');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done'), { recursive: true });
  for (const [id, extra] of Object.entries(tasks)) fs.writeFileSync(path.join(pipelineDir, 'queue', 'done', `${id}.json`), JSON.stringify({ id, ...extra }));
  return { label, repoRoot: root, pipelineDir };
}
const merged = (redoOf) => ({ promptContext: { redoOf }, status: 'done', terminalDisposition: 'merged', mergedAt: '2026-10-31T00:07:23+00:00' });
const card = (p, o = {}) => ({ branch: 'agent/old-branch', headSha: 'abc123', taskId: 'old-task-1', verdict: 'needs-work', hub: null, project: { label: p.label, repoRoot: p.repoRoot }, ...o });
function fakeRequest(rows, answers = {}) {
  const posts = [];
  const request = async (method, url, body) => {
    if (method === 'GET') return { status: 200, json: rows };
    posts.push({ url, body });
    return { status: answers.status || 200, json: {} };
  };
  request.posts = posts;
  return request;
}

test('a merged redo records a discard on the card of the task it replaced, naming the redo and when it merged', async () => {
  const p = project('a', { 'redo-1': merged('old-task-1') });
  const req = fakeRequest([card(p)]);
  const s = await sweep({ projects: [p], request: req, env: {}, log: quiet });
  assert.deepEqual([s.redos, s.matched, s.recorded], [1, 1, 1]);
  assert.equal(req.posts.length, 1);
  assert.equal(req.posts[0].url, `/api/git/branches/${encodeURIComponent('agent/old-branch')}/verdict?project=${encodeURIComponent(p.repoRoot)}`);
  const b = req.posts[0].body;
  assert.deepEqual([b.verdict, b.source, b.sha], ['discard', 'manual', 'abc123']);
  assert.match(b.reasons[0], /redo-1/);
  assert.match(b.reasons[0], /2026-10-31T00:07:23/);
});

test('a hub predecessor matches through row.hub.id and through the decompose- prefix of row.taskId', async () => {
  const p = project('a', { 'redo-1': merged('adhoc-chat-hub-1793311473800'), 'redo-2': merged('decompose-adhoc-other-hub-1') });
  const rows = [
    card(p, { branch: 'agent/hub-a', taskId: 'unrelated-name', hub: { id: 'adhoc-chat-hub-1793311473800' } }),
    card(p, { branch: 'agent/hub-b', taskId: 'adhoc-other-hub-1', hub: null }),
  ];
  const req = fakeRequest(rows);
  const s = await sweep({ projects: [p], request: req, env: {}, log: quiet });
  assert.equal(s.recorded, 2);
  assert.equal(norm('decompose-x'), 'x');
});

test('a redo that is not merged, has no redoOf, or has an empty redoOf retires nothing', async () => {
  const p = project('a', {
    'redo-open': { promptContext: { redoOf: 'old-task-1' }, terminalDisposition: 'pending-merge' },
    'redo-nomerge-time': { promptContext: { redoOf: 'old-task-1' }, terminalDisposition: 'merged' },
    'plain': { terminalDisposition: 'merged', mergedAt: 'x' },
    'blank': merged('  '),
  });
  assert.deepEqual(mergedRedos(p), []);
  const req = fakeRequest([card(p)]);
  const s = await sweep({ projects: [p], request: req, env: {}, log: quiet });
  assert.equal(req.posts.length, 0);
  assert.equal(s.recorded, 0);
});

// Sweeps ONE project twice with the card changed in between; under the queue-events journal a clean second run is (correctly) idle, so this per-card guard test runs
// with the journal switched off, i.e. the old full scan on every run.
const OFF = { AGENT_MANAGER_QUEUE_EVENTS: 'off' };
test('a card that is already discard is skipped; a card with a merge verdict is kept and reported', async () => {
  const p = project('a', { 'redo-1': merged('old-task-1') });
  const logs = [];
  let req = fakeRequest([card(p, { verdict: 'discard' })]);
  let s = await sweep({ projects: [p], request: req, env: OFF, log: quiet });
  assert.equal(req.posts.length, 0);
  assert.equal(s.skipped['already-discard'], 1);
  req = fakeRequest([card(p, { verdict: 'merge' })]);
  s = await sweep({ projects: [p], request: req, env: OFF, log: (l) => logs.push(l) });
  assert.equal(req.posts.length, 0);
  assert.equal(s.skipped['has-merge-verdict'], 1);
  assert.ok(logs.some((l) => /kept, it carries a merge verdict/.test(l)));
});

test('the redo is never allowed to retire its own branch, and a card with no head sha is skipped', async () => {
  const p = project('a', { 'redo-1': merged('redo-1') });
  let req = fakeRequest([card(p, { taskId: 'redo-1' })]);
  let s = await sweep({ projects: [p], request: req, env: {}, log: quiet });
  assert.equal(req.posts.length, 0);
  assert.equal(s.skipped['own-branch'], 1);
  const q = project('b', { 'redo-9': merged('old-task-1') });
  req = fakeRequest([card(q, { headSha: '' })]);
  s = await sweep({ projects: [q], request: req, env: {}, log: quiet });
  assert.equal(s.skipped['no-head-sha'], 1);
});

test('a card of ANOTHER project with the same task id is not touched', async () => {
  const a = project('a', { 'redo-1': merged('old-task-1') });
  const b = project('b');
  const req = fakeRequest([card(b)]);
  const s = await sweep({ projects: [a, b], request: req, env: {}, log: quiet });
  assert.equal(req.posts.length, 0);
  assert.equal(s.matched, 0);
});

test('dry-run records nothing but counts what it would; off does nothing at all, not even a listing', async () => {
  const p = project('a', { 'redo-1': merged('old-task-1') });
  let req = fakeRequest([card(p)]);
  let s = await sweep({ projects: [p], request: req, env: { AGENT_MANAGER_REDO_SUPERSEDE: 'dry-run' }, log: quiet });
  assert.deepEqual([req.posts.length, s.wouldRecord, s.recorded], [0, 1, 0]);
  let calls = 0;
  s = await sweep({ projects: [p], request: async () => { calls += 1; return { status: 200, json: [] }; }, env: { AGENT_MANAGER_REDO_SUPERSEDE: 'off' }, log: quiet });
  assert.equal(calls, 0);
  assert.equal(s.mode, 'off');
  assert.equal(mode({}), 'on');
});

test('an unreachable dashboard, a refused listing, a 409 and a 500 never throw', async () => {
  const p = project('a', { 'redo-1': merged('old-task-1') });
  let s = await sweep({ projects: [p], request: async () => { throw new Error('ECONNREFUSED'); }, env: {}, log: quiet });
  assert.match(s.error, /did not answer/);
  s = await sweep({ projects: [p], request: async () => ({ status: 500, json: null }), env: {}, log: quiet });
  assert.match(s.error, /HTTP 500/);
  s = await sweep({ projects: [p], request: fakeRequest([card(p)], { status: 409 }), env: {}, log: quiet });
  assert.equal(s.skipped['head-moved-retry-later'], 1);
  s = await sweep({ projects: [p], request: fakeRequest([card(p)], { status: 500 }), env: {}, log: quiet });
  assert.equal(s.errors, 1);
});

test('a project with no done directory or unreadable task files is simply skipped', async () => {
  const p = project('a');
  fs.writeFileSync(path.join(p.pipelineDir, 'queue', 'done', 'broken.json'), '{not json');
  assert.deepEqual(mergedRedos(p), []);
  assert.deepEqual(mergedRedos({ label: 'x', repoRoot: '/nope', pipelineDir: '/nope' }), []);
});

// ---- the real CLI against a fake dashboard --------------------------------------------------------------------------------------------
function fakeDashboard(rows) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(rows)); return; }
      posts.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, posts, port: server.address().port })));
}
function runCli(env, args = []) {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('real CLI: reads the registry, lists cards from the dashboard, posts the discard, prints one JSON line', async () => {
  const p = project('real', { 'redo-1': merged('old-task-1') });
  const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-reg-')), 'projects.json');
  fs.writeFileSync(registry, JSON.stringify([{ label: 'real', repoRoot: p.repoRoot, pipelineDir: p.pipelineDir }]));
  const dash = await fakeDashboard([card(p)]);
  try {
    const env = { AGENT_MANAGER_PROJECTS_REGISTRY_PATH: registry, AGENT_MANAGER_DASHBOARD_PORT: String(dash.port) };
    const r = await runCli(env);
    assert.equal(r.code, 0, r.err);
    const summary = JSON.parse(r.out.trim().split('\n').pop());
    assert.deepEqual([summary.redos, summary.recorded], [1, 1]);
    assert.equal(dash.posts.length, 1);
    assert.equal(dash.posts[0].body.verdict, 'discard');
    assert.match(r.err, /discard recorded/);
    const dry = await runCli(env, ['--dry-run']);
    assert.equal(JSON.parse(dry.out.trim()).mode, 'dry-run');
    assert.equal(dash.posts.length, 1, 'dry-run posted nothing more');
  } finally {
    dash.server.close();
  }
});

test('real CLI with no dashboard listening exits 0 and says why', async () => {
  const p = project('real2', { 'redo-1': merged('old-task-1') });
  const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-reg-')), 'projects.json');
  fs.writeFileSync(registry, JSON.stringify([{ label: 'real2', repoRoot: p.repoRoot, pipelineDir: p.pipelineDir }]));
  const r = await runCli({ AGENT_MANAGER_PROJECTS_REGISTRY_PATH: registry, AGENT_MANAGER_DASHBOARD_PORT: '1' });
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.out.trim()).error, /did not answer/);
});

test('the watchdog tick runs the sweep with the same log convention, and the script still parses', () => {
  const sh = path.join(__dirname, '..', 'scripts', 'queue-watcher.sh');
  const text = fs.readFileSync(sh, 'utf8');
  assert.match(text, /node "\$\{PACKAGE_SRC_DIR\}\/redo-supersede-sweep\.js" 2>>"\$\{HOME_LOGS\}\/redo-supersede-sweep\.log"/);
  assert.match(text, /\[watchdog\] redo-supersede-sweep: %s/);
  assert.equal(spawnSync('bash', ['-n', sh]).status, 0);
});


// ---- ADR-0024: driven by the queue-events journal (HUB0330 piece 4) ----
const queueEvents = require('./queue-events.js');
const T0 = Date.parse('2026-11-03T12:00:00Z');
const MIN = 60 * 1000;
function countingFs() {
  const readdirs = [];
  const impl = { ...fs, readdirSync: (p, ...rest) => { readdirs.push(String(p)); return fs.readdirSync(p, ...rest); } };
  return { impl, doneListings: () => readdirs.filter((d) => /queue[\\/]done$/.test(d)).length };
}
const addRedo = (p, id, redoOf) => fs.writeFileSync(path.join(p.pipelineDir, 'queue', 'done', `${id}.json`), JSON.stringify({ id, ...merged(redoOf) }));

test('journal mode: the first run does the full scan, a clean second run with no events lists nothing and asks the dashboard nothing', async () => {
  const p = project('j1', { 'redo-1': merged('old-task-1') });
  const c = countingFs();
  const req = fakeRequest([card(p)]);
  let s = await sweep({ projects: [p], request: req, env: {}, log: quiet, fsImpl: c.impl, now: T0 });
  assert.deepEqual([s.redos, s.recorded, s.journal.fullScans], [1, 1, 1]);
  assert.equal(c.doneListings(), 1);
  let calls = 0;
  s = await sweep({ projects: [p], request: async () => { calls += 1; return { status: 200, json: [] }; }, env: {}, log: quiet, fsImpl: c.impl, now: T0 + 5 * MIN });
  assert.deepEqual([s.redos, s.journal.idle, s.journal.fullScans], [0, 1, 0]);
  assert.equal(c.doneListings(), 1, 'the idle run made ZERO readdirSync calls on done/');
  assert.equal(calls, 0, 'and no dashboard request');
});

test('journal mode: a branch_merged event for a new redo triggers exactly one examination, without listing done/', async () => {
  const p = project('j2', { 'redo-1': merged('old-task-1') });
  const c = countingFs();
  await sweep({ projects: [p], request: fakeRequest([card(p)]), env: {}, log: quiet, fsImpl: c.impl, now: T0 });
  addRedo(p, 'redo-2', 'old-task-2');
  addRedo(p, 'redo-3', 'old-task-3');                                            // merged too, but NOT announced: must not be examined by an event run
  queueEvents.append(p.pipelineDir, { type: 'branch_merged', branch: 'agent/redo-2', taskId: 'redo-2' });
  const req = fakeRequest([card(p), card(p, { branch: 'agent/old-branch-2', taskId: 'old-task-2', headSha: 'def456' }), card(p, { branch: 'agent/old-branch-3', taskId: 'old-task-3', headSha: 'ghi789' })]);
  const s = await sweep({ projects: [p], request: req, env: {}, log: quiet, fsImpl: c.impl, now: T0 + 5 * MIN });
  assert.deepEqual([s.redos, s.journal.eventRuns, s.recorded], [1, 1, 1]);
  assert.match(req.posts[0].url, /old-branch-2/);
  assert.equal(c.doneListings(), 1, 'still only the first run listed done/');
});

test('journal mode: the reconcile pass revisits done/, and a supersede no event announced is counted as a correction (the first run counts none)', async () => {
  const p = project('j3', { 'redo-1': merged('old-task-1') });
  let s = await sweep({ projects: [p], request: fakeRequest([card(p)]), env: {}, log: quiet, now: T0 });
  assert.equal(s.journal.corrections, 0, 'the first run is the catch-up, not a reconcile');
  addRedo(p, 'redo-9', 'old-task-9');                                            // merged without any event: a producer forgot to emit
  s = await sweep({ projects: [p], request: fakeRequest([card(p, { branch: 'agent/ob9', taskId: 'old-task-9', headSha: 'z9' })]), env: {}, log: quiet, now: T0 + 31 * MIN });
  assert.deepEqual([s.journal.fullScans, s.recorded, s.journal.corrections], [1, 1, 1]);
  assert.deepEqual(queueEvents.readCorrections(p.pipelineDir).byConsumer, { 'redo-supersede': 1 });
});

test('journal mode: an announced redo found by the reconcile pass is NOT a correction', async () => {
  const p = project('j4', { 'redo-1': merged('old-task-1') });
  await sweep({ projects: [p], request: fakeRequest([card(p)]), env: {}, log: quiet, now: T0 });
  addRedo(p, 'redo-9', 'old-task-9');
  queueEvents.append(p.pipelineDir, { type: 'branch_merged', branch: 'agent/redo-9', taskId: 'redo-9' });
  const s = await sweep({ projects: [p], request: fakeRequest([card(p, { branch: 'agent/ob9', taskId: 'old-task-9', headSha: 'z9' })]), env: {}, log: quiet, now: T0 + 31 * MIN });
  assert.deepEqual([s.recorded, s.journal.corrections], [1, 0]);
});

test('journal mode: unfinished work is retried (a 409 or a refused listing keeps the events and the scan pending); a dry-run never advances state', async () => {
  const p = project('j5', { 'redo-1': merged('old-task-1') });
  let s = await sweep({ projects: [p], request: fakeRequest([card(p)], { status: 409 }), env: {}, log: quiet, now: T0 });
  assert.equal(s.skipped['head-moved-retry-later'], 1);
  s = await sweep({ projects: [p], request: fakeRequest([card(p)]), env: {}, log: quiet, now: T0 + MIN });
  assert.deepEqual([s.journal.fullScans, s.recorded], [1, 1], 'the full scan ran again and the retry succeeded');
  const q = project('j6', { 'redo-1': merged('old-task-1') });
  await sweep({ projects: [q], request: fakeRequest([card(q)]), env: { AGENT_MANAGER_REDO_SUPERSEDE: 'dry-run' }, log: quiet, now: T0 });
  s = await sweep({ projects: [q], request: fakeRequest([card(q)]), env: {}, log: quiet, now: T0 + MIN });
  assert.deepEqual([s.journal.fullScans, s.recorded], [1, 1], 'a dry-run did not mark the scan done');
  const r = project('j7', { 'redo-1': merged('old-task-1') });
  queueEvents.append(r.pipelineDir, { type: 'branch_merged', branch: 'agent/redo-1', taskId: 'redo-1' });
  s = await sweep({ projects: [r], request: async () => { throw new Error('ECONNREFUSED'); }, env: {}, log: quiet, now: T0 });
  assert.match(s.error, /did not answer/);
  assert.equal(queueEvents.drain(r.pipelineDir, 'redo-supersede').events.length, 1, 'the event was not consumed by the failed run');
});

test('AGENT_MANAGER_QUEUE_EVENTS=off is the old behaviour: a full listing every run and no journal files written', async () => {
  const p = project('j8', { 'redo-1': merged('old-task-1') });
  const c = countingFs();
  for (let i = 0; i < 3; i++) await sweep({ projects: [p], request: fakeRequest([]), env: OFF, log: quiet, fsImpl: c.impl, now: T0 + i * MIN });
  assert.equal(c.doneListings(), 3);
  assert.equal(fs.existsSync(path.join(p.pipelineDir, 'queue-events')), false);
});
