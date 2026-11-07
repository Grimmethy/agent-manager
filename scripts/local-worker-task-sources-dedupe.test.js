'use strict';

// local-worker.sh runs task-sources.js (the generation ladder) on every tick of every lane. Lanes that tick on one project within AGENT_MANAGER_TASK_SOURCES_DEDUPE_SECS of the last run
// skip it (CPU analysis 2026-11-07). Run for real in a sandbox, like local-worker-borrow.test.js: a throwaway project, a private HOME, an Ollama URL that refuses connections.
// Run: node --test scripts/local-worker-task-sources-dedupe.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'local-worker.sh');
const RAN = 'no eligible task found';           // what task-sources.js logs when it ran and found nothing to generate

function sandbox(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-dedupe-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const A = mk('A'); mk('repoA'); mk('home');
  for (const d of ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'done']) mk('A', 'queue', d);
  fs.writeFileSync(path.join(A, 'task-domains.json'), '{}');
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([{ repoRoot: path.join(root, 'repoA'), pipelineDir: A, domainsPath: path.join(A, 'task-domains.json'), label: 'A' }]));
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'), OLLAMA_URL: 'http://127.0.0.1:9', MODEL_URL: 'http://127.0.0.1:9', LOCAL_MODEL: 'x',
    AGENT_MANAGER_TASK_SOURCES: 'none-such', AGENT_MANAGER_PROJECTS_PATH: projectsPath, AGENT_MANAGER_POOL_STATE_PATH: path.join(root, 'pool-state.json'),
    ORC_TICK_SECS: '2', AGENT_MANAGER_ENDPOINT_PROBE: 'off', AGENT_MANAGER_POOL_BORROW: 'false',
    AGENT_MANAGER_REPO_ROOT: path.join(root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: A, AGENT_MANAGER_INSTANCES_DIR: path.join(A, 'instances'), AGENT_MANAGER_DOMAINS_PATH: path.join(A, 'task-domains.json'),
    ...extraEnv,
  };
  const state = path.join(root, 'home', '.local', 'state', 'agent-manager');
  const tick = () => { const r = spawnSync('bash', [SCRIPT, 'worker-x', '--once'], { encoding: 'utf8', env, timeout: 120000 }); assert.equal(r.status, 0, r.stderr); };
  const ran = () => { try { return fs.readFileSync(path.join(state, 'logs', 'local-worker-worker-x.log'), 'utf8').split(RAN).length - 1; } catch { return 0; } };
  const stampDir = path.join(state, 'task-sources-stamps');
  const stamps = () => (fs.existsSync(stampDir) ? fs.readdirSync(stampDir) : []);
  return { root, A, env, tick, ran, stampDir, stamps, state };
}

test('two ticks on one project close together run the generation ladder ONCE; the first tick leaves a stamp named for the pipeline directory', () => {
  const sb = sandbox();
  sb.tick(); sb.tick();
  assert.equal(sb.ran(), 1);
  assert.equal(sb.stamps().length, 1);
  assert.match(fs.readFileSync(path.join(sb.stampDir, sb.stamps()[0]), 'utf8'), /^\d{9,}\n$/);
});

test('AGENT_MANAGER_TASK_SOURCES_DEDUPE_SECS=0 turns it off: every tick runs the ladder and no stamp is written', () => {
  const sb = sandbox({ AGENT_MANAGER_TASK_SOURCES_DEDUPE_SECS: '0' });
  sb.tick(); sb.tick();
  assert.equal(sb.ran(), 2);
  assert.deepEqual(sb.stamps(), []);
});

test('a stale, empty or garbled stamp does not block the run, and the run rewrites it', () => {
  for (const content of ['1\n', '', 'soon\n', '-5\n']) {
    const sb = sandbox();
    fs.mkdirSync(sb.stampDir, { recursive: true });
    fs.writeFileSync(path.join(sb.stampDir, `${sb.A.replace(/\//g, '_')}`), content);
    sb.tick();
    assert.equal(sb.ran(), 1, `stamp ${JSON.stringify(content)}`);
    assert.match(fs.readFileSync(path.join(sb.stampDir, sb.stamps()[0]), 'utf8'), /^\d{9,}\n$/);
  }
});

test('a fresh stamp from another lane skips the run on this tick without touching the stamp', () => {
  const sb = sandbox();
  fs.mkdirSync(sb.stampDir, { recursive: true });
  const stamp = path.join(sb.stampDir, sb.A.replace(/\//g, '_'));
  const now = `${Math.floor(Date.now() / 1000)}\n`;
  fs.writeFileSync(stamp, now);
  sb.tick();
  assert.equal(sb.ran(), 0);
  assert.equal(fs.readFileSync(stamp, 'utf8'), now);
});

test('a bad window setting falls back to 5 seconds instead of disabling or breaking the tick', () => {
  const sb = sandbox({ AGENT_MANAGER_TASK_SOURCES_DEDUPE_SECS: 'abc' });
  sb.tick(); sb.tick();
  assert.equal(sb.ran(), 1);
});

test('the stamp is per pipeline directory: another project is not skipped because this one just ran', () => {
  const a = sandbox();
  a.tick();
  const b = sandbox();                                           // its own HOME, but force the same state dir to prove the key is the pipeline directory
  const shared = sandbox({ AGENT_MANAGER_STATE_DIR: a.state });
  shared.tick();
  assert.equal(shared.ran(), 1, 'a different pipeline directory ran although a stamp for another one is fresh');
  assert.equal(fs.readdirSync(a.stampDir).length, 2, 'one stamp per pipeline directory');
  assert.ok(b.stamps().length === 0);
});
