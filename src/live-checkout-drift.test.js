'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { checkDrift } = require('./live-checkout-drift');

const CLI = path.join(__dirname, 'live-checkout-drift.js');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'drift-test',
      GIT_AUTHOR_EMAIL: 'drift-test@example.invalid',
      GIT_COMMITTER_NAME: 'drift-test',
      GIT_COMMITTER_EMAIL: 'drift-test@example.invalid',
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

// Temp bare remote, a work clone that pushes, and a checkout that is only read.
function makeRepos(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-drift-'));
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

test('four states from rev-list counts (injected execGit)', () => {
  const cases = [
    ['0 0', { state: 'current', ahead: 0, behind: 0 }],
    ['41 0', { state: 'behind', ahead: 0, behind: 41 }],
    ['0 1', { state: 'ahead', ahead: 1, behind: 0 }],
    ['41 1', { state: 'diverged', ahead: 1, behind: 41 }],
  ];
  for (const [revList, expected] of cases) {
    const execGit = (args) => {
      if (args[0] === 'symbolic-ref') return 'master\n';
      if (args[0] === 'rev-list') return revList + '\n';
      throw new Error('unexpected git call: ' + args.join(' '));
    };
    assert.deepEqual(checkDrift('/unused', { execGit }), { ...expected, branch: 'master' }, revList);
  }
});

test('rev-list left count is behind and right count is ahead', () => {
  const execGit = (args) => (args[0] === 'symbolic-ref' ? 'master\n' : '3 1\n');
  assert.deepEqual(checkDrift('/unused', { execGit }), { state: 'diverged', ahead: 1, behind: 3, branch: 'master' });
});

test('rev-list compares refs/remotes/origin/<branch> with HEAD', () => {
  const calls = [];
  const execGit = (args) => {
    calls.push(args);
    if (args[0] === 'symbolic-ref') return 'feature/x\n';
    return '0 0\n';
  };
  checkDrift('/unused', { execGit });
  assert.deepEqual(calls[1], ['rev-list', '--left-right', '--count', 'refs/remotes/origin/feature/x...HEAD']);
});

test('detached HEAD falls back to master (injected execGit)', () => {
  const execGit = (args) => {
    if (args[0] === 'symbolic-ref') throw new Error('fatal: ref HEAD is not a symbolic ref');
    if (args[0] === 'rev-list') {
      assert.ok(args.includes('refs/remotes/origin/master...HEAD'));
      return '0 0\n';
    }
    throw new Error('unexpected git call: ' + args.join(' '));
  };
  assert.deepEqual(checkDrift('/unused', { execGit }), { state: 'current', ahead: 0, behind: 0, branch: 'master' });
});

test('an empty symbolic-ref answer falls back to master', () => {
  const calls = [];
  const execGit = (args) => {
    calls.push(args);
    if (args[0] === 'symbolic-ref') return '\n';
    return '0 0\n';
  };
  const r = checkDrift('/unused', { execGit });
  assert.deepEqual(calls[1], ['rev-list', '--left-right', '--count', 'refs/remotes/origin/master...HEAD']);
  assert.equal(r.branch, 'master');
});

test('git failure returns an error result and does not throw', () => {
  const execGit = (args) => {
    if (args[0] === 'symbolic-ref') return 'feature/x\n';
    throw new Error('fatal: bad revision');
  };
  const r = checkDrift('/unused', { execGit });
  assert.equal(r.state, 'error');
  assert.equal(r.ahead, null);
  assert.equal(r.behind, null);
  assert.equal(r.branch, 'feature/x');
  assert.match(r.error, /bad revision/);
});

test('total git failure, even symbolic-ref, returns an error result', () => {
  const execGit = () => {
    throw new Error('spawn git ENOENT');
  };
  const r = checkDrift('/unused', { execGit });
  assert.equal(r.state, 'error');
});

test('unparseable rev-list output is an error result', () => {
  const execGit = (args) => (args[0] === 'symbolic-ref' ? 'master\n' : 'garbage\n');
  const r = checkDrift('/unused', { execGit });
  assert.equal(r.state, 'error');
  assert.match(r.error, /unexpected rev-list output/);
});

test('end to end on a real temp repo: current, behind, ahead, diverged', (t) => {
  const r = makeRepos(t);
  assert.deepEqual(checkDrift(r.checkout), { state: 'current', ahead: 0, behind: 0, branch: 'master' });

  commit(r.work, 'remote-1');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']); // test setup only; the module never fetches
  assert.deepEqual(checkDrift(r.checkout), { state: 'behind', ahead: 0, behind: 1, branch: 'master' });

  git(r.checkout, ['merge', '-q', '--ff-only', 'origin/master']);
  commit(r.checkout, 'local-1');
  assert.deepEqual(checkDrift(r.checkout), { state: 'ahead', ahead: 1, behind: 0, branch: 'master' });

  for (const m of ['remote-2', 'remote-3', 'remote-4']) commit(r.work, m);
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);
  // ahead 1 (local-1) and behind 3 (remote-2..4): the counts must not be swapped.
  assert.deepEqual(checkDrift(r.checkout), { state: 'diverged', ahead: 1, behind: 3, branch: 'master' });
});

test('detached HEAD compares against master end to end', (t) => {
  const r = makeRepos(t);
  git(r.checkout, ['checkout', '-q', '--detach']);
  assert.deepEqual(checkDrift(r.checkout), { state: 'current', ahead: 0, behind: 0, branch: 'master' });
});

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('CLI exit codes on a real temp repo: 0 current, 0 ahead, 1 diverged', (t) => {
  const r = makeRepos(t);
  let res = runCli([r.checkout]);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'current: ahead 0, behind 0 on master\n');

  commit(r.checkout, 'cli-local');
  res = runCli([r.checkout]);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'ahead: ahead 1, behind 0 on master\n');

  commit(r.work, 'cli-remote');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);
  res = runCli([r.checkout]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, 'diverged: ahead 1, behind 1 on master\n');
});

test('CLI exit 1 for behind on a real temp repo', (t) => {
  const r = makeRepos(t);
  commit(r.work, 'cli-remote');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);
  const res = runCli([r.checkout]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, 'behind: ahead 0, behind 1 on master\n');
});

test('CLI usage and non-repo errors exit 2', (t) => {
  const noArg = runCli([]);
  assert.equal(noArg.status, 2);
  assert.match(noArg.stderr, /usage/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-drift-nonrepo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const res = runCli([dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /^error: /);
});
