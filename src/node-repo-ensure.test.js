'use strict';

// Tests for src/node-repo-ensure.js ensureRepo(): clone on first use, fetch at every call, fast-forward only when safe.
// Real git against temp repos (a local bare origin); the url validator is replaced by an injected one, in tests only. No network, no timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureRepo, defaultValidate, validName } = require('./node-repo-ensure.js');

const allowAny = () => true;

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout).trim();
}

function commit(dir, file, text, message) {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, ['add', file]);
  git(dir, ['commit', '-q', '-m', message]);
}

// A bare origin with branch `branch` (default main) holding one commit, plus a working clone `seed` to push more commits from.
function makeOrigin(t, branch = 'main') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-ensure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  git(root, ['init', '-q', '--bare', '-b', branch, origin]);
  const seed = path.join(root, 'seed');
  git(root, ['clone', '-q', origin, seed]);
  git(seed, ['checkout', '-q', '-b', branch]);
  commit(seed, 'a.txt', 'one\n', 'first');
  git(seed, ['push', '-q', 'origin', branch]);
  return { root, origin, seed, reposDir: path.join(root, 'repos') };
}

const spec = (o, extra = {}) => ({ name: 'project', remoteUrl: o.origin, baseBranch: 'main', ...extra });
const opts = (o, extra = {}) => ({ reposDir: o.reposDir, validate: allowAny, ...extra });

test('a missing checkout is cloned into reposDir/<name> and reports its head', (t) => {
  const o = makeOrigin(t);
  const out = ensureRepo(spec(o), opts(o));
  assert.equal(out.ok, true);
  assert.equal(out.path, path.join(o.reposDir, 'project'));
  assert.equal(out.updated, true);
  assert.equal(out.reason, 'cloned');
  assert.equal(out.head, git(o.seed, ['rev-parse', 'HEAD']));
  assert.equal(fs.readFileSync(path.join(out.path, 'a.txt'), 'utf8'), 'one\n');
});

test('an existing up-to-date checkout is fetched and left alone', (t) => {
  const o = makeOrigin(t);
  ensureRepo(spec(o), opts(o));
  const out = ensureRepo(spec(o), opts(o));
  assert.equal(out.ok, true);
  assert.equal(out.updated, false);
  assert.equal(out.reason, 'already up to date');
});

test('new commits on origin are fetched and fast-forwarded into the checked-out base branch', (t) => {
  const o = makeOrigin(t);
  const first = ensureRepo(spec(o), opts(o));
  commit(o.seed, 'b.txt', 'two\n', 'second');
  git(o.seed, ['push', '-q', 'origin', 'main']);
  const out = ensureRepo(spec(o), opts(o));
  assert.equal(out.ok, true);
  assert.equal(out.updated, true);
  assert.notEqual(out.head, first.head);
  assert.equal(out.head, git(o.seed, ['rev-parse', 'HEAD']));
  assert.equal(fs.readFileSync(path.join(out.path, 'b.txt'), 'utf8'), 'two\n');
});

test('a tracked change in the working tree is never touched, even when origin moved', (t) => {
  const o = makeOrigin(t);
  const first = ensureRepo(spec(o), opts(o));
  fs.writeFileSync(path.join(first.path, 'a.txt'), 'local edit\n');
  commit(o.seed, 'b.txt', 'two\n', 'second');
  git(o.seed, ['push', '-q', 'origin', 'main']);
  const out = ensureRepo(spec(o), opts(o));
  assert.equal(out.ok, true);
  assert.equal(out.updated, false);
  assert.match(out.reason, /tracked changes/);
  assert.equal(out.head, first.head);
  assert.equal(fs.readFileSync(path.join(first.path, 'a.txt'), 'utf8'), 'local edit\n');
});

test('an untracked file does not block the fast-forward', (t) => {
  const o = makeOrigin(t);
  const first = ensureRepo(spec(o), opts(o));
  fs.writeFileSync(path.join(first.path, 'scratch.txt'), 'x');
  commit(o.seed, 'b.txt', 'two\n', 'second');
  git(o.seed, ['push', '-q', 'origin', 'main']);
  const out = ensureRepo(spec(o), opts(o));
  assert.equal(out.updated, true);
  assert.equal(fs.existsSync(path.join(first.path, 'scratch.txt')), true);
});

test('a diverged local branch is left alone', (t) => {
  const o = makeOrigin(t);
  const first = ensureRepo(spec(o), opts(o));
  commit(first.path, 'local.txt', 'mine\n', 'local commit');
  const localHead = git(first.path, ['rev-parse', 'HEAD']);
  commit(o.seed, 'b.txt', 'two\n', 'second');
  git(o.seed, ['push', '-q', 'origin', 'main']);
  const out = ensureRepo(spec(o), opts(o));
  assert.equal(out.ok, true);
  assert.equal(out.updated, false);
  assert.match(out.reason, /diverged/);
  assert.equal(out.head, localHead);
});

test('a checkout on another branch is fetched but not moved', (t) => {
  const o = makeOrigin(t);
  const first = ensureRepo(spec(o), opts(o));
  git(first.path, ['checkout', '-q', '-b', 'feature']);
  commit(o.seed, 'b.txt', 'two\n', 'second');
  git(o.seed, ['push', '-q', 'origin', 'main']);
  const before = git(first.path, ['rev-parse', 'HEAD']);
  const out = ensureRepo(spec(o), opts(o));
  assert.equal(out.updated, false);
  assert.match(out.reason, /not main/);
  assert.equal(out.head, before);
  assert.equal(git(first.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature');
});

test('the base branch defaults to origin/HEAD when baseBranch is not given', (t) => {
  const o = makeOrigin(t);
  const first = ensureRepo(spec(o), opts(o));
  commit(o.seed, 'b.txt', 'two\n', 'second');
  git(o.seed, ['push', '-q', 'origin', 'main']);
  const out = ensureRepo(spec(o, { baseBranch: undefined }), opts(o));
  assert.equal(out.updated, true);
  assert.notEqual(out.head, first.head);
});

test('names that are not letters, digits, dots, dashes or underscores are refused before any git call', () => {
  const calls = [];
  const fakeGit = (args) => { calls.push(args); return { ok: true, out: '' }; };
  for (const name of ['', '.', '..', '../escape', 'a/b', 'a b', 'a;b', '$(x)', undefined, 7]) {
    const out = ensureRepo({ name, remoteUrl: 'https://github.com/o/r.git' }, { reposDir: os.tmpdir(), git: fakeGit });
    assert.equal(out.ok, false, String(name));
    assert.equal(out.reason, 'invalid repo name');
  }
  assert.equal(calls.length, 0);
});

test('only https://github.com/<owner>/<name>(.git) urls pass the default validator', () => {
  for (const good of ['https://github.com/Grimmethy/feature-forge', 'https://github.com/Grimmethy/feature-forge.git', 'https://github.com/o/r.x']) {
    assert.equal(defaultValidate(good), true, good);
  }
  for (const bad of ['http://github.com/o/r', 'git@github.com:o/r.git', 'ssh://github.com/o/r', 'https://evil.example/o/r', 'https://github.com/o', 'https://github.com/o/r/extra', 'https://github.com/o/r --upload-pack=x', 'https://githubXcom/o/r', 'https://github.com.evil.example/o/r', '-oProxyCommand=x', '', null, undefined]) {
    assert.equal(defaultValidate(bad), false, String(bad));
  }
  const calls = [];
  const out = ensureRepo({ name: 'r', remoteUrl: 'https://evil.example/o/r' }, { reposDir: os.tmpdir(), git: (a) => { calls.push(a); return { ok: true, out: '' }; } });
  assert.deepEqual(out, { ok: false, reason: 'invalid remote url' });
  assert.equal(calls.length, 0);
});

test('validName accepts ordinary repository names', () => {
  for (const ok of ['agent-manager', 'a_b', 'v1.2', 'X']) assert.equal(validName(ok), true, ok);
});

test('clone passes -- before the url and runs in the repos directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-ensure-args-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const fakeGit = (args, cwd) => { calls.push({ args, cwd }); return { ok: true, out: 'abc' }; };
  const out = ensureRepo({ name: 'r', remoteUrl: 'https://github.com/o/r.git' }, { reposDir: path.join(root, 'repos'), git: fakeGit });
  assert.equal(out.ok, true);
  assert.deepEqual(calls[0].args, ['clone', '--', 'https://github.com/o/r.git', path.join(root, 'repos', 'r')]);
  assert.equal(calls[0].cwd, path.join(root, 'repos'));
});

test('a failed clone and a failed fetch return ok:false with a reason', (t) => {
  const o = makeOrigin(t);
  const bad = ensureRepo({ name: 'project', remoteUrl: path.join(o.root, 'nope.git') }, opts(o));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'clone failed');
  const first = ensureRepo(spec(o), opts(o));
  assert.equal(first.ok, true);
  fs.rmSync(o.origin, { recursive: true, force: true });
  const out = ensureRepo(spec(o), opts(o));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'fetch failed');
});

test('reposDir defaults from AGENT_MANAGER_NODE_REPOS_DIR', (t) => {
  const o = makeOrigin(t);
  const out = ensureRepo(spec(o), { env: { AGENT_MANAGER_NODE_REPOS_DIR: o.reposDir }, validate: allowAny });
  assert.equal(out.ok, true);
  assert.equal(out.path, path.join(o.reposDir, 'project'));
});

test('the base branch defaults to origin/HEAD, whatever the default branch is called', (t) => {
  const o = makeOrigin(t, 'trunk');
  const first = ensureRepo({ name: 'project', remoteUrl: o.origin }, opts(o));
  assert.equal(first.ok, true);
  commit(o.seed, 'b.txt', 'two\n', 'second');
  git(o.seed, ['push', '-q', 'origin', 'trunk']);
  const out = ensureRepo({ name: 'project', remoteUrl: o.origin }, opts(o));
  assert.equal(out.ok, true);
  assert.equal(out.updated, true);
  assert.equal(out.head, git(o.seed, ['rev-parse', 'HEAD']));
});
