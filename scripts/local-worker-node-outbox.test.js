'use strict';
// A worker on a NODE (AGENT_MANAGER_NODE_ID set and not wok) files a successful draft in queue/node-outbox/ instead of queue/review/; a wok worker is unchanged
// and every other result (blocked, recorded) goes where it always went. Same sandbox as scripts/local-worker-recorded.test.js: the worker runs for real, only
// src/local-draft.js is a stub that prints STUB_DRAFT_RESULT, every other src entry is a symlink.
// Run: node --test scripts/local-worker-node-outbox.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REAL = path.join(__dirname, '..');
// node-outbox is NOT created here: the worker makes it itself on a node that has never drafted anything.
const QUEUES = ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'done'];

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-outbox-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const pkg = mk('pkg'); mk('pkg', 'scripts'); mk('pkg', 'src'); mk('repo'); mk('home');
  for (const f of fs.readdirSync(path.join(REAL, 'scripts'))) fs.symlinkSync(path.join(REAL, 'scripts', f), path.join(pkg, 'scripts', f));
  for (const f of fs.readdirSync(path.join(REAL, 'src'))) if (f !== 'local-draft.js') fs.symlinkSync(path.join(REAL, 'src', f), path.join(pkg, 'src', f));
  fs.writeFileSync(path.join(pkg, 'src', 'local-draft.js'), "process.stdout.write(process.env.STUB_DRAFT_RESULT + '\\n');\n");
  fs.symlinkSync(path.join(REAL, 'node_modules'), path.join(pkg, 'node_modules'));
  const P = mk('P');
  for (const d of QUEUES) mk('P', 'queue', d);
  mk('P', 'queue', 'drafting', 'worker-x');
  fs.writeFileSync(path.join(P, 'task-domains.json'), '{}');
  fs.writeFileSync(path.join(P, 'queue', 'drafting', 'worker-x', 't-1.json'), JSON.stringify({ id: 't-1', domain: 'default', source: 'trouble_log', title: 't', status: 'drafting', history: [] }));
  // The worker yields while the host's memory marker says critical (this host often does); a fresh 'ok' marker of its own keeps the test independent of the load.
  const marker = path.join(root, 'mem-marker.json');
  fs.writeFileSync(marker, JSON.stringify({ state: 'ok', seq: 1, at: new Date().toISOString() }));
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([{ repoRoot: path.join(root, 'repo'), pipelineDir: P, domainsPath: path.join(P, 'task-domains.json'), label: 'P' }]));
  return { root, pkg, P, projectsPath, marker };
}

function run(draftResult, nodeId) {
  const { root, pkg, P, projectsPath, marker } = sandbox();
  const env = { ...process.env, HOME: path.join(root, 'home'), OLLAMA_URL: 'http://127.0.0.1:9', MODEL_URL: 'http://127.0.0.1:9', LOCAL_MODEL: 'x', AGENT_MANAGER_TASK_SOURCES: 'none-such',
    AGENT_MANAGER_PROJECTS_PATH: projectsPath, AGENT_MANAGER_POOL_STATE_PATH: path.join(root, 'pool-state.json'), ORC_TICK_SECS: '2', AGENT_MANAGER_ENDPOINT_PROBE: 'off', AGENT_MANAGER_MEM_PRESSURE_MARKER: marker,
    AGENT_MANAGER_REPO_ROOT: path.join(root, 'repo'), AGENT_MANAGER_PIPELINE_DIR: P, AGENT_MANAGER_DOMAINS_PATH: path.join(P, 'task-domains.json'),
    AGENT_MANAGER_INSTANCES_DIR: path.join(P, 'instances'), STUB_DRAFT_RESULT: JSON.stringify(draftResult) };
  delete env.AGENT_MANAGER_NODE_ID;
  if (nodeId !== undefined) env.AGENT_MANAGER_NODE_ID = nodeId;
  const r = spawnSync('bash', [path.join(pkg, 'scripts', 'local-worker.sh'), 'worker-x', '--once'], { encoding: 'utf8', timeout: 120000, env });
  const where = {};
  for (const d of ['review', 'blocked', 'done', 'node-outbox']) {
    const dir = path.join(P, 'queue', d);
    where[d] = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  }
  where.drafting = fs.readdirSync(path.join(P, 'queue', 'drafting', 'worker-x'));
  return { r, where, P };
}

test('a successful draft on a node ends in node-outbox/, untouched, and not in review/', () => {
  const { r, where, P } = run({ succeeded: true }, 'grimm');
  assert.deepEqual(where['node-outbox'], ['t-1.json'], r.stderr);
  assert.deepEqual(where.review, []);
  assert.deepEqual(where.drafting, []);
  assert.match(r.stderr, /draft complete on a node, ready to send to wok: t-1/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(P, 'queue', 'node-outbox', 't-1.json'), 'utf8')).id, 't-1');
});

test('a successful draft on wok (no node id, a blank one, or wok) still goes to review/', () => {
  for (const nodeId of [undefined, '', '  ', 'wok']) {
    const { where } = run({ succeeded: true }, nodeId);
    assert.deepEqual(where.review, ['t-1.json'], JSON.stringify(nodeId));
    assert.deepEqual(where['node-outbox'], [], JSON.stringify(nodeId));
  }
});

test('on a node a blocked result still ends in blocked/, a recorded one in done/, and a failed draft stays out of the outbox', () => {
  const blocked = run({ succeeded: true, blocked: true }, 'grimm');
  assert.deepEqual(blocked.where.blocked, ['t-1.json']);
  assert.deepEqual(blocked.where['node-outbox'], []);
  const recorded = run({ succeeded: true, recorded: true }, 'grimm');
  assert.deepEqual(recorded.where.done, ['t-1.json']);
  assert.deepEqual(recorded.where['node-outbox'], []);
  const failed = run({ succeeded: false }, 'grimm');
  assert.deepEqual(failed.where['node-outbox'], []);
  assert.deepEqual(failed.where.review, []);
});
