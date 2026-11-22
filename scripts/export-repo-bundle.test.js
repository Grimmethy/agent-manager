'use strict';
// Tests for scripts/export-repo-bundle.sh (multi-node plan, piece 8a): real git repos in temp dirs, the script run with spawnSync.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'export-repo-bundle.sh');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost' };

function tmp() { return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'export-bundle-')); }
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function makeRepo(root, name = 'demo') {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'first');
  return repo;
}
function run(args) { return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' }); }

test('exports master as a verified bundle and prints one line with the real sha', () => {
  const root = tmp();
  const repo = makeRepo(root);
  const out = path.join(root, 'out');
  const r = run([repo, out]);
  assert.equal(r.status, 0, r.stderr);
  const sha = git(repo, 'rev-parse', 'master');
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `bundle=${out}/demo-${sha.slice(0, 8)}.bundle sha=${sha} branch=master`);
  assert.ok(fs.existsSync(`${out}/demo-${sha.slice(0, 8)}.bundle`));
  assert.equal(spawnSync('git', ['bundle', 'verify', `${out}/demo-${sha.slice(0, 8)}.bundle`], { cwd: repo }).status, 0);
  assert.deepEqual(fs.readdirSync(out), [`demo-${sha.slice(0, 8)}.bundle`], 'no temporary file is left behind');
});

test('a second run for the same sha keeps the same file name and prints the same line', () => {
  const root = tmp();
  const repo = makeRepo(root);
  const out = path.join(root, 'out');
  const first = run([repo, out]);
  const second = run([repo, out]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.equal(fs.readdirSync(out).length, 1);
});

test('a new commit gives a new file name', () => {
  const root = tmp();
  const repo = makeRepo(root);
  const out = path.join(root, 'out');
  run([repo, out]);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
  git(repo, 'add', 'b.txt');
  git(repo, 'commit', '-q', '-m', 'second');
  const r = run([repo, out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readdirSync(out).length, 2);
});

test('another branch can be exported and the repo is not changed', () => {
  const root = tmp();
  const repo = makeRepo(root);
  git(repo, 'branch', 'feature');
  const before = git(repo, 'status', '--porcelain=v1') + git(repo, 'for-each-ref');
  const r = run([repo, path.join(root, 'out'), 'feature']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, / branch=feature\n$/);
  assert.equal(git(repo, 'status', '--porcelain=v1') + git(repo, 'for-each-ref'), before);
});

test('refusals exit 2 and write nothing', () => {
  const root = tmp();
  const repo = makeRepo(root);
  const notRepo = path.join(root, 'plain');
  fs.mkdirSync(notRepo);
  const out = path.join(root, 'out');
  const cases = [
    [[], /usage/], [[repo], /usage/], [[repo, out, 'master', 'extra'], /usage/], [[notRepo, out], /not a git work tree/],
    [[path.join(root, 'missing'), out], /not a git work tree/], [[repo, out, 'nope'], /no such branch: nope/], [['', out], /empty/], [[repo, ''], /empty/],
  ];
  for (const [args, message] of cases) {
    const r = run(args);
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, message);
    assert.match(r.stderr, /export-repo-bundle:/);
  }
  assert.equal(fs.existsSync(out), false, 'the out dir is not created for a refused call');
});

test('a bundle that fails verification exits 1, says so and leaves no file', () => {
  const root = tmp();
  const repo = makeRepo(root);
  const out = path.join(root, 'out');
  const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const stubDir = path.join(root, 'stub');
  fs.mkdirSync(stubDir);
  fs.writeFileSync(path.join(stubDir, 'git'), `#!/usr/bin/env bash\ncase " $* " in *" bundle verify "*) exit 1;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const r = spawnSync('bash', [SCRIPT, repo, out], { encoding: 'utf8', env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` } });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /the new bundle does not verify/);
  assert.equal(r.stdout, '');
  assert.deepEqual(fs.readdirSync(out), [], 'neither a bundle nor a part file is left');
});
