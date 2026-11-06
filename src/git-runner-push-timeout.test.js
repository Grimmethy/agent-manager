'use strict';

// A push that times out but landed is a success (2026-11-04). apply's `git push -u origin agent/<id>` hit the 60 s cap while the branch was arriving on GitHub; apply recorded
// a failure for work already on origin and its sanctioned retry then collided with its own first push (non-fast-forward). After a TIMED-OUT push, and only then, the runner asks
// the remote what it holds: the push succeeded exactly when the remote tip of the branch is the local tip. Scripted fakes cover every case; a real-git test uses a bare origin.
// Run: node --test src/git-runner-push-timeout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRealGitRunner } = require('./git-runner.js');

const TIP = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BRANCH = 'agent/some-task-1';

function realRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushto-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@x'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
  return dir;
}
const timeoutError = () => Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
const rejected = () => Object.assign(new Error('! [rejected] HEAD -> agent/some-task-1 (non-fast-forward)'), { status: 1 });

// A fake exec driven by a function of the git arguments; records every call.
function scripted(handler) {
  const calls = [];
  const exec = (cmd, args) => { calls.push(args); return handler(args); };
  return { exec, calls };
}
function runnerFor(handler) {
  const f = scripted(handler);
  const runner = createRealGitRunner(realRepo(), { exec: f.exec, sleepMs: () => {} });
  f.calls.length = 0;                       // detectDefaultBranch ran real git at construction
  return { runner, calls: f.calls };
}
const lsRemote = (tip) => (args) => (args[0] === 'ls-remote' ? (tip ? `${tip}\trefs/heads/${BRANCH}\n` : '') : null);
const revParse = (tip) => (args) => (args[0] === 'rev-parse' ? `${tip}\n` : null);
const either = (...fns) => (args) => { for (const f of fns) { const r = f(args); if (r !== null && r !== undefined) return r; } return ''; };

test('a push that times out but whose branch is on the remote at the local tip counts as a success, and asks the remote exactly once', () => {
  const w = runnerFor((args) => {
    if (args[0] === 'push') throw timeoutError();
    return either(lsRemote(TIP), revParse(TIP))(args);
  });
  assert.doesNotThrow(() => w.runner.push(BRANCH));
  assert.deepEqual(w.calls.map((a) => a[0]), ['push', 'ls-remote', 'rev-parse'], 'the push ran once and was never repeated');
  assert.deepEqual(w.calls[0], ['push', '-u', 'origin', BRANCH]);
  assert.deepEqual(w.calls[1], ['ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`]);
  assert.deepEqual(w.calls[2], ['rev-parse', `refs/heads/${BRANCH}`]);
});

test('a timed-out push whose remote tip is a DIFFERENT commit still throws the original timeout error naming the push', () => {
  const w = runnerFor((args) => {
    if (args[0] === 'push') throw timeoutError();
    return either(lsRemote(OTHER), revParse(TIP))(args);
  });
  assert.throws(() => w.runner.push(BRANCH), (e) => e.code === 'ETIMEDOUT' && /git push -u origin .* timed out after \d+ms/.test(e.message));
});

test('a timed-out push with no such branch on the remote still throws', () => {
  const w = runnerFor((args) => {
    if (args[0] === 'push') throw timeoutError();
    return either(lsRemote(null), revParse(TIP))(args);
  });
  assert.throws(() => w.runner.push(BRANCH), (e) => e.code === 'ETIMEDOUT');
});

test('if the remote cannot be asked either (ls-remote fails) the ORIGINAL timeout error is thrown, not the ls-remote one', () => {
  const w = runnerFor((args) => {
    if (args[0] === 'push') throw timeoutError();
    if (args[0] === 'ls-remote') throw Object.assign(new Error('fatal: unable to access remote'), { status: 128 });
    return revParse(TIP)(args);
  });
  assert.throws(() => w.runner.push(BRANCH), (e) => e.code === 'ETIMEDOUT' && /push/.test(e.message) && !/unable to access/.test(e.message));
});

test('if the local tip cannot be read (rev-parse fails) the timed-out push is not treated as landed', () => {
  const w = runnerFor((args) => {
    if (args[0] === 'push') throw timeoutError();
    if (args[0] === 'rev-parse') throw Object.assign(new Error('fatal: bad revision'), { status: 128 });
    return lsRemote(TIP)(args);
  });
  assert.throws(() => w.runner.push(BRANCH), (e) => e.code === 'ETIMEDOUT');
});

test('an empty tip on both sides is not a match (an empty remote answer never counts as landed)', () => {
  const w = runnerFor((args) => {
    if (args[0] === 'push') throw timeoutError();
    return either(lsRemote(null), revParse(''))(args);
  });
  assert.throws(() => w.runner.push(BRANCH), (e) => e.code === 'ETIMEDOUT');
});

test('a push the remote REJECTED is never looked up and always throws (only a timeout is ambiguous)', () => {
  const w = runnerFor((args) => {
    if (args[0] === 'push') throw rejected();
    return either(lsRemote(TIP), revParse(TIP))(args);
  });
  assert.throws(() => w.runner.push(BRANCH), /non-fast-forward/);
  assert.deepEqual(w.calls.map((a) => a[0]), ['push'], 'no ls-remote after a rejection');
});

test('a push that works makes exactly one git call', () => {
  const w = runnerFor(() => '');
  w.runner.push(BRANCH);
  assert.deepEqual(w.calls.map((a) => a[0]), ['push']);
});

test('pushMain gets the same check, for the main branch name, once the ungated main push is allowed', () => {
  const saved = process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = 'true';
  try {
    const asked = [];
    const w = runnerFor((args) => {
      if (args[0] === 'push') throw timeoutError();
      if (args[0] === 'ls-remote') { asked.push(args[args.length - 1]); return `${TIP}\t${args[args.length - 1]}\n`; }
      return revParse(TIP)(args);
    });
    assert.doesNotThrow(() => w.runner.pushMain());
    assert.deepEqual(asked, ['refs/heads/main']);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH; else process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = saved;
  }
});

test('pushMain with the gate closed still refuses before any git call', () => {
  const saved = process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  try {
    const w = runnerFor(() => '');
    assert.throws(() => w.runner.pushMain(), /pushMain refused/);
    assert.equal(w.calls.length, 0);
  } finally {
    if (saved !== undefined) process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = saved;
  }
});

// ---- real git, a bare origin ----
function worldWithBranch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pushto-real-'));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const work = path.join(root, 'work');
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  const g = (...a) => execFileSync('git', a, { cwd: work, stdio: 'pipe', encoding: 'utf8' });
  g('config', 'user.email', 't@x'); g('config', 'user.name', 'T'); g('checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'init'); g('push', '-q', 'origin', 'main');
  g('checkout', '-q', '-b', BRANCH); fs.writeFileSync(path.join(work, 'b.txt'), 'b\n'); g('add', '.'); g('commit', '-q', '-m', 'the work');
  return { origin, work, remoteHas: () => execFileSync('git', ['ls-remote', '--heads', origin, `refs/heads/${BRANCH}`], { encoding: 'utf8' }).trim() };
}
const realExecWith = (mode) => (cmd, args, opts) => {
  if (args[0] === 'push' && mode === 'land-then-timeout') { execFileSync(cmd, args, opts); throw timeoutError(); }
  if (args[0] === 'push' && mode === 'timeout-only') throw timeoutError();
  return execFileSync(cmd, args, opts);
};

test('real git: a push that really lands and then reports a timeout is a success, and the branch is on the remote at the local tip', () => {
  const w = worldWithBranch();
  const runner = createRealGitRunner(w.work, { exec: realExecWith('land-then-timeout'), sleepMs: () => {} });
  assert.equal(w.remoteHas(), '');
  assert.doesNotThrow(() => runner.push(BRANCH));
  const local = execFileSync('git', ['rev-parse', BRANCH], { cwd: w.work, encoding: 'utf8' }).trim();
  assert.ok(w.remoteHas().startsWith(local));
});

test('real git: a timeout where nothing was pushed still fails, and nothing is on the remote', () => {
  const w = worldWithBranch();
  const runner = createRealGitRunner(w.work, { exec: realExecWith('timeout-only'), sleepMs: () => {} });
  assert.throws(() => runner.push(BRANCH), (e) => e.code === 'ETIMEDOUT');
  assert.equal(w.remoteHas(), '');
});

test('real git: a timeout when the remote has an OLDER commit of the branch still fails (the new commit did not land)', () => {
  const w = worldWithBranch();
  execFileSync('git', ['push', '-q', 'origin', BRANCH], { cwd: w.work });       // the first commit is already there
  fs.writeFileSync(path.join(w.work, 'c.txt'), 'c\n');
  execFileSync('git', ['add', '.'], { cwd: w.work });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'second'], { cwd: w.work });
  const runner = createRealGitRunner(w.work, { exec: realExecWith('timeout-only'), sleepMs: () => {} });
  assert.throws(() => runner.push(BRANCH), (e) => e.code === 'ETIMEDOUT');
});
