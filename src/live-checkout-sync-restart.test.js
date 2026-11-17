'use strict';

// FF-3/3b: tests for the unit restarts after a live-checkout fast-forward (src/live-checkout-sync.js). Helpers mirror src/live-checkout-sync.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { syncLiveCheckout, defaultGit } = require('./live-checkout-sync');
const CLI = path.join(__dirname, 'live-checkout-sync.js');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'sync-test',
      GIT_AUTHOR_EMAIL: 'sync-test@example.invalid',
      GIT_COMMITTER_NAME: 'sync-test',
      GIT_COMMITTER_EMAIL: 'sync-test@example.invalid',
    },
  }).trim();
}

function commit(dir, msg) {
  fs.writeFileSync(path.join(dir, msg + '.txt'), msg + '\n');
  git(dir, ['add', msg + '.txt']);
  git(dir, ['commit', '-q', '-m', msg]);
}

function pushMaster(dir) {
  git(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
}

function makeRepos(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const checkout = path.join(root, 'checkout');
  git(root, ['-c', 'init.defaultBranch=master', 'init', '-q', '--bare', remote]);
  git(root, ['-c', 'init.defaultBranch=master', 'init', '-q', work]);
  commit(work, 'base');
  git(work, ['remote', 'add', 'origin', remote]);
  pushMaster(work);
  git(root, ['clone', '-q', remote, checkout]);
  return { root, remote, work, checkout };
}

function makeFakeNotify() {
  const calls = [];
  const fn = async (msg) => {
    calls.push(msg);
    return { sent: true, reason: 'fake' };
  };
  fn.calls = calls;
  return fn;
}

function readAudit(pipelineDir) {
  const file = path.join(pipelineDir, 'live-checkout-sync.audit.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

// FF-3/3b: restart the registry and intake units after a fast-forward that touched code they load.
function commitFile(dir, rel, msg) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), msg + '\n');
  git(dir, ['add', rel]);
  git(dir, ['commit', '-q', '-m', msg]);
}

function recordingRun(failUnits = []) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const unit = args[args.length - 1];
    return failUnits.includes(unit) ? { code: 5, out: '', err: `Failed to restart ${unit}: not found` } : { code: 0, out: '', err: '' };
  };
  run.calls = calls;
  return run;
}

async function syncAfterPush(t, rel, extraEnv, opts = {}) {
  const r = makeRepos(t);
  commitFile(r.work, rel, 'remote-' + rel.replace(/\W/g, '_'));
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);
  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const notify = makeFakeNotify();
  const run = opts.run || recordingRun();
  const env = { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'on', ...extraEnv };
  delete env.AGENT_MANAGER_LIVE_SYNC_UNITS;
  Object.assign(env, extraEnv);
  const result = await syncLiveCheckout(r.checkout, { env, pipelineDir, notify, run });
  return { r, result, pipelineDir, notify, run };
}

test('a src change restarts each default unit once with the --user form and records the results in the ff audit line', async (t) => {
  const { result, pipelineDir, run, notify } = await syncAfterPush(t, 'src/node-registry.js', {});
  assert.equal(result.action, 'ff');
  assert.deepEqual(run.calls, [
    ['systemctl', '--user', 'restart', 'am-node-registry.service'],
    ['systemctl', '--user', 'restart', 'am-package-intake.service'],
  ]);
  const last = readAudit(pipelineDir).pop();
  assert.deepEqual(last.restarts, [{ unit: 'am-node-registry.service', ok: true }, { unit: 'am-package-intake.service', ok: true }]);
  assert.deepEqual(result.restarts, last.restarts);
  assert.equal(notify.calls.some((c) => c.key === 'live-checkout:restart-failed'), false);
});

test('AGENT_MANAGER_LIVE_SYNC_UNITS replaces the default list, trimming spaces and empty names', async (t) => {
  const { run } = await syncAfterPush(t, 'src/a.js', { AGENT_MANAGER_LIVE_SYNC_UNITS: ' x.service , ,y.service' });
  assert.deepEqual(run.calls.map((c) => c[3]), ['x.service', 'y.service']);
});

test('a change that touches no src file runs nothing and leaves no restarts on the audit line', async (t) => {
  const docs = await syncAfterPush(t, 'docs/note.md', {});
  assert.deepEqual(docs.run.calls, []);
  assert.equal('restarts' in readAudit(docs.pipelineDir).pop(), false);
  const scripts = await syncAfterPush(t, 'scripts/launch.sh', {});
  assert.deepEqual(scripts.run.calls, []);
});

test('a failing restart is audited and noticed once and does not stop the other unit', async (t) => {
  const { result, pipelineDir, run, notify } = await syncAfterPush(t, 'src/a.js', {}, { run: recordingRun(['am-node-registry.service']) });
  assert.equal(run.calls.length, 2);
  const restarts = readAudit(pipelineDir).pop().restarts;
  assert.equal(restarts[0].ok, false);
  assert.match(restarts[0].error, /Failed to restart am-node-registry.service/);
  assert.deepEqual(restarts[1], { unit: 'am-package-intake.service', ok: true });
  const failed = notify.calls.filter((c) => c.key === 'live-checkout:restart-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, 'summary');
  assert.match(failed[0].title, /am-node-registry.service/);
  assert.equal(result.action, 'ff');
});

test('a runner that throws is a failed restart, not an exception, and the next unit still runs', async (t) => {
  let n = 0;
  const run = () => { n += 1; if (n === 1) throw new Error('spawn boom'); return { code: 0, out: '', err: '' }; };
  const { result, pipelineDir } = await syncAfterPush(t, 'src/a.js', {}, { run });
  assert.equal(result.action, 'ff');
  const restarts = readAudit(pipelineDir).pop().restarts;
  assert.deepEqual([restarts[0].ok, restarts[0].error, restarts[1].ok], [false, 'spawn boom', true]);
});

test('a failing notifier never changes the fast-forward result', async (t) => {
  const r = makeRepos(t);
  commitFile(r.work, 'src/a.js', 'remote-src');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);
  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  let calls = 0;
  const notify = async () => { calls += 1; if (calls === 1) throw new Error('ntfy down'); return { sent: true }; };
  const result = await syncLiveCheckout(r.checkout, { env: { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'on' }, pipelineDir, notify, run: recordingRun(['am-node-registry.service']) });
  assert.equal(result.action, 'ff');
  assert.equal(result.restarts.length, 2);
});

test('dry-run runs nothing and audits would restart <unit> because <paths>', async (t) => {
  const r = makeRepos(t);
  commitFile(r.work, 'src/node-registry.js', 'remote-src');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);
  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const run = recordingRun();
  const head = git(r.checkout, ['rev-parse', 'HEAD']);
  const result = await syncLiveCheckout(r.checkout, { env: { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'dry-run' }, pipelineDir, notify: makeFakeNotify(), run });
  assert.equal(result.action, 'would-ff');
  assert.deepEqual(run.calls, []);
  assert.equal(git(r.checkout, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(readAudit(pipelineDir).pop().would, [
    'would restart am-node-registry.service because src/node-registry.js',
    'would restart am-package-intake.service because src/node-registry.js',
  ]);
});

test('dry-run with a docs-only change records no would line, and mode off runs nothing at all', async (t) => {
  const r = makeRepos(t);
  commitFile(r.work, 'docs/x.md', 'remote-doc');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);
  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const run = recordingRun();
  await syncLiveCheckout(r.checkout, { env: { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'dry-run' }, pipelineDir, notify: makeFakeNotify(), run });
  assert.equal('would' in readAudit(pipelineDir).pop(), false);
  const off = await syncLiveCheckout(r.checkout, { env: { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'off' }, pipelineDir, notify: makeFakeNotify(), run });
  assert.equal(off.action, 'skipped');
  assert.deepEqual(run.calls, []);
});

test('a refused fast-forward (dirty checkout) restarts nothing', async (t) => {
  const r = makeRepos(t);
  commitFile(r.work, 'src/a.js', 'remote-src');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);
  fs.writeFileSync(path.join(r.checkout, 'base.txt'), 'local edit\n');
  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const run = recordingRun();
  const result = await syncLiveCheckout(r.checkout, { env: { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'on' }, pipelineDir, notify: makeFakeNotify(), run });
  assert.equal(result.action, 'refused');
  assert.deepEqual(run.calls, []);
});

test('a git diff that fails is audited as restartError and restarts nothing, the fast-forward result stands', async (t) => {
  const r = makeRepos(t);
  commitFile(r.work, 'src/a.js', 'remote-src');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);
  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const gitFake = (dir, args) => (args[0] === 'diff' ? { code: 128, out: '', err: 'bad revision' } : defaultGit(dir, args));
  const run = recordingRun();
  const result = await syncLiveCheckout(r.checkout, { env: { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'on' }, pipelineDir, notify: makeFakeNotify(), git: gitFake, run });
  assert.equal(result.action, 'ff');
  assert.deepEqual(run.calls, []);
  assert.match(readAudit(pipelineDir).pop().restartError, /bad revision/);
});

test('the default unit names match the real user units, and restarts use no shell and the --user form', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.match(src, /am-node-registry\.service/);
  assert.match(src, /am-package-intake\.service/);
  assert.match(src, /\['--user', 'restart', unit\]/);
  assert.equal(/shell\s*:\s*true/.test(src), false);
});
