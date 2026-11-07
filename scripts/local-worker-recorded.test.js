'use strict';
// local-worker.sh files a draft result by its flags: recorded -> done/, blocked -> blocked/ (wins), plain success -> review/. The worker runs for real in a
// sandbox; only src/local-draft.js is replaced by a stub that prints the JSON result in STUB_DRAFT_RESULT (every other src entry is a symlink).
// Run: node --test scripts/local-worker-recorded.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REAL = path.join(__dirname, '..');

function run(draftResult) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-recorded-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const pkg = mk('pkg');
  fs.symlinkSync(path.join(REAL, 'scripts'), path.join(pkg, 'scripts'));
  // scripts must resolve ../src to the STUBBED src, so scripts is a real dir of symlinks instead.
  fs.rmSync(path.join(pkg, 'scripts'));
  mk('pkg', 'scripts'); mk('pkg', 'src');
  for (const f of fs.readdirSync(path.join(REAL, 'scripts'))) fs.symlinkSync(path.join(REAL, 'scripts', f), path.join(pkg, 'scripts', f));
  for (const f of fs.readdirSync(path.join(REAL, 'src'))) if (f !== 'local-draft.js') fs.symlinkSync(path.join(REAL, 'src', f), path.join(pkg, 'src', f));
  fs.writeFileSync(path.join(pkg, 'src', 'local-draft.js'), "process.stdout.write(process.env.STUB_DRAFT_RESULT + '\\n');\n");
  fs.symlinkSync(path.join(REAL, 'node_modules'), path.join(pkg, 'node_modules'));
  const P = mk('P'); mk('repo'); mk('home');
  for (const d of ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'done']) mk('P', 'queue', d);
  mk('P', 'queue', 'drafting', 'worker-x');
  fs.writeFileSync(path.join(P, 'task-domains.json'), '{}');
  fs.writeFileSync(path.join(P, 'queue', 'drafting', 'worker-x', 't-1.json'), JSON.stringify({ id: 't-1', domain: 'default', source: 'trouble_log', title: 't', status: 'drafting', history: [] }));
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([{ repoRoot: path.join(root, 'repo'), pipelineDir: P, domainsPath: path.join(P, 'task-domains.json'), label: 'P' }]));
  const r = spawnSync('bash', [path.join(pkg, 'scripts', 'local-worker.sh'), 'worker-x', '--once'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, HOME: path.join(root, 'home'), OLLAMA_URL: 'http://127.0.0.1:9', MODEL_URL: 'http://127.0.0.1:9', LOCAL_MODEL: 'x', AGENT_MANAGER_TASK_SOURCES: 'none-such',
      AGENT_MANAGER_PROJECTS_PATH: projectsPath, AGENT_MANAGER_POOL_STATE_PATH: path.join(root, 'pool-state.json'), ORC_TICK_SECS: '2', AGENT_MANAGER_ENDPOINT_PROBE: 'off',
      AGENT_MANAGER_REPO_ROOT: path.join(root, 'repo'), AGENT_MANAGER_PIPELINE_DIR: P, AGENT_MANAGER_DOMAINS_PATH: path.join(P, 'task-domains.json'),
      AGENT_MANAGER_INSTANCES_DIR: path.join(P, 'instances'), STUB_DRAFT_RESULT: JSON.stringify(draftResult) },
  });
  const where = {};
  for (const d of ['review', 'blocked', 'done']) where[d] = fs.readdirSync(path.join(P, 'queue', d)).filter((f) => f.endsWith('.json'));
  where.drafting = fs.readdirSync(path.join(P, 'queue', 'drafting', 'worker-x'));
  return { r, where };
}

test('a recorded draft result moves the task to done/ with no review', () => {
  const { r, where } = run({ succeeded: true, recorded: true });
  assert.deepEqual(where.done, ['t-1.json'], r.stderr);
  assert.deepEqual(where.review, []);
  assert.deepEqual(where.blocked, []);
  assert.match(r.stderr, /recorded t-1 -- script handler finished, no review needed/);
});

test('blocked keeps priority over recorded', () => {
  const { where } = run({ succeeded: true, recorded: true, blocked: true });
  assert.deepEqual(where.blocked, ['t-1.json']);
  assert.deepEqual(where.done, []);
});

test('a plain successful draft still goes to review/', () => {
  const { where } = run({ succeeded: true });
  assert.deepEqual(where.review, ['t-1.json']);
  assert.deepEqual(where.done, []);
});

test('recorded without succeeded does not reach done/', () => {
  const { where } = run({ succeeded: false, recorded: true });
  assert.deepEqual(where.done, []);
});
