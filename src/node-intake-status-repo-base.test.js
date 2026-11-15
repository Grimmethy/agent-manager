'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectTaskState, resolveBase } = require('./node-intake-server.js');

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-base-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function putDone(pipelineDir, id, record) {
  const dir = path.join(pipelineDir, 'queue', 'done');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, ...record }));
}

function appliedRecord(extra = {}) {
  return { history: [{ stage: 'applied', detail: 'agent/t1' }], ...extra };
}

// A fake base-resolving git: symbolic-ref answers headRef, and rev-parse answers for the refs that exist.
function fakeBaseGit({ headRef = '', refs = [] } = {}) {
  return (repoDir, args) => {
    if (args[0] === 'symbolic-ref') return headRef;
    if (args[0] === 'rev-parse') return refs.includes(args[args.length - 1]) ? args[args.length - 1] : '';
    return '';
  };
}

function recordingGit(answer = false) {
  const calls = [];
  const fn = (branch, base, dir) => { calls.push({ branch, base, dir }); return answer; };
  return { fn, calls };
}

test('a record with generatedForRepoRoot uses that directory as the git cwd', (t) => {
  const root = tmpRoot(t);
  const recorded = path.join(root, 'recorded-repo');
  fs.mkdirSync(recorded);
  const injected = path.join(root, 'injected-repo');
  fs.mkdirSync(injected);
  const pipelineDir = path.join(root, 'pipeline');
  putDone(pipelineDir, 't1', appliedRecord({ generatedForRepoRoot: recorded }));
  const git = recordingGit(false);
  detectTaskState('t1', pipelineDir, git.fn, injected, { env: {}, baseGitFn: fakeBaseGit() });
  assert.equal(git.calls.length, 1);
  assert.equal(git.calls[0].dir, recorded);
});

test('a record without generatedForRepoRoot falls back to the injected repoDir', (t) => {
  const root = tmpRoot(t);
  const injected = path.join(root, 'injected-repo');
  fs.mkdirSync(injected);
  const pipelineDir = path.join(root, 'pipeline');
  putDone(pipelineDir, 't1', appliedRecord());
  const git = recordingGit(false);
  detectTaskState('t1', pipelineDir, git.fn, injected, { env: {}, baseGitFn: fakeBaseGit() });
  assert.equal(git.calls.length, 1);
  assert.equal(git.calls[0].dir, injected);
});

test('a non-existent generatedForRepoRoot answers unknown and git is not called', (t) => {
  const root = tmpRoot(t);
  const pipelineDir = path.join(root, 'pipeline');
  putDone(pipelineDir, 't1', appliedRecord({ generatedForRepoRoot: path.join(root, 'nope') }));
  const git = recordingGit(true);
  const state = detectTaskState('t1', pipelineDir, git.fn, root, { env: {}, baseGitFn: fakeBaseGit() });
  assert.equal(state, 'unknown');
  assert.equal(git.calls.length, 0);
});

test('AGENT_MANAGER_MERGED_BASE overrides the base', () => {
  const seen = [];
  const baseGitFn = fakeBaseGit({ headRef: 'origin/develop', refs: ['refs/remotes/origin/master'] });
  assert.equal(resolveBase('/repo', { AGENT_MANAGER_MERGED_BASE: 'release' }, baseGitFn), 'release');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-base-env-'));
  try {
    const pipelineDir = path.join(root, 'pipeline');
    putDone(pipelineDir, 't1', appliedRecord({ generatedForRepoRoot: root }));
    const git = (branch, base) => { seen.push(base); return false; };
    detectTaskState('t1', pipelineDir, git, root, { env: { AGENT_MANAGER_MERGED_BASE: 'release' }, baseGitFn });
    assert.deepEqual(seen, ['origin/release']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the base comes from origin/HEAD when no override is set', () => {
  const baseGitFn = fakeBaseGit({ headRef: 'origin/develop', refs: ['refs/remotes/origin/master'] });
  assert.equal(resolveBase('/repo', {}, baseGitFn), 'develop');
});

test('the base falls back to master when origin/master exists, otherwise main', () => {
  assert.equal(resolveBase('/repo', {}, fakeBaseGit({ refs: ['refs/remotes/origin/master'] })), 'master');
  assert.equal(resolveBase('/repo', {}, fakeBaseGit({})), 'main');
});

test('an applied task whose branch is an ancestor of origin/master answers merged with a fake git that only knows master', (t) => {
  const root = tmpRoot(t);
  const pipelineDir = path.join(root, 'pipeline');
  putDone(pipelineDir, 't1', appliedRecord({ generatedForRepoRoot: root }));
  const git = (branch, base) => branch === 'agent/t1' && base === 'origin/master';
  const baseGitFn = fakeBaseGit({ refs: ['refs/remotes/origin/master'] });
  assert.equal(detectTaskState('t1', pipelineDir, git, root, { env: {}, baseGitFn }), 'merged');
});

test('a git function that throws counts as not merged', (t) => {
  const root = tmpRoot(t);
  const pipelineDir = path.join(root, 'pipeline');
  putDone(pipelineDir, 't1', appliedRecord({ generatedForRepoRoot: root }));
  const git = () => { throw new Error('git failed'); };
  assert.equal(detectTaskState('t1', pipelineDir, git, root, { env: {}, baseGitFn: fakeBaseGit() }), 'unknown');
});

test('a generatedForRepoRoot that is a file, not a directory, answers unknown and git is not called', (t) => {
  const root = tmpRoot(t);
  const pipelineDir = path.join(root, 'pipeline');
  const aFile = path.join(root, 'not-a-dir');
  fs.writeFileSync(aFile, 'x');
  putDone(pipelineDir, 't1', appliedRecord({ generatedForRepoRoot: aFile }));
  const git = recordingGit(true);
  assert.equal(detectTaskState('t1', pipelineDir, git.fn, root, { env: {}, baseGitFn: fakeBaseGit() }), 'unknown');
  assert.equal(git.calls.length, 0);
});

test('a generatedForRepoRoot padded with whitespace is trimmed before it is used', (t) => {
  const root = tmpRoot(t);
  const recorded = path.join(root, 'recorded-repo');
  fs.mkdirSync(recorded);
  const pipelineDir = path.join(root, 'pipeline');
  putDone(pipelineDir, 't1', appliedRecord({ generatedForRepoRoot: `  ${recorded}\n` }));
  const git = recordingGit(false);
  detectTaskState('t1', pipelineDir, git.fn, root, { env: {}, baseGitFn: fakeBaseGit() });
  assert.equal(git.calls.length, 1);
  assert.equal(git.calls[0].dir, recorded);
});

test('POST /status passes the server environment to the base resolution (AGENT_MANAGER_MERGED_BASE reaches the git call)', async (t) => {
  const http = require('node:http');
  const { createServer } = require('./node-intake-server.js');
  const root = tmpRoot(t);
  const pipelineDir = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'queue'), { recursive: true });
  putDone(pipelineDir, 't1', appliedRecord({ generatedForRepoRoot: root }));
  const tokenFile = path.join(root, 'lender-token');
  fs.writeFileSync(tokenFile, 'repo-base-token\n', { mode: 0o600 });
  const seen = [];
  const env = { HOME: root, AGENT_MANAGER_LENDER_TOKEN_FILE: tokenFile, AGENT_MANAGER_PIPELINE_DIR: pipelineDir, AGENT_MANAGER_MERGED_BASE: 'release' };
  const server = createServer({ env, gitFn: (branch, base, dir) => { seen.push({ base, dir }); return true; }, repoDir: root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((done) => server.close(done)));
  const body = JSON.stringify({ taskIds: ['t1'] });
  const answer = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/status', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer repo-base-token' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.deepEqual(answer.tasks, { t1: 'merged' });
  assert.deepEqual(seen, [{ base: 'origin/release', dir: root }]);
});
