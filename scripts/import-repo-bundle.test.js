'use strict';
// Tests for scripts/import-repo-bundle.sh (multi-node plan, piece 8b): bundles are made with plain git here, so this file does not depend on export-repo-bundle.sh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'import-repo-bundle.sh');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost' };

function tmp() { return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'import-bundle-')); }
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(repo, file, text) {
  fs.writeFileSync(path.join(repo, file), text);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', `add ${file}`);
}
function makeSource(root) {
  const repo = path.join(root, 'source');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  commit(repo, 'a.txt', 'one\n');
  return repo;
}
function bundle(repo, root, name, branch = 'master') {
  const file = path.join(root, name);
  git(repo, 'bundle', 'create', file, `refs/heads/${branch}`);
  return file;
}
function run(args) { return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: GIT_ENV }); }

test('a fresh import clones the branch, leaves no remote and sets the node identity', () => {
  const root = tmp();
  const source = makeSource(root);
  const sha = git(source, 'rev-parse', 'master');
  const dest = path.join(root, 'nested', 'node-copy');
  const r = run([bundle(source, root, 'one.bundle'), dest]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `head=${sha} dest=${fs.realpathSync(dest)}\n`);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(git(dest, 'remote'), '', 'the clone has no remote');
  assert.equal(git(dest, 'config', 'user.name'), 'agent-manager-node');
  assert.equal(git(dest, 'config', 'user.email'), 'agent-manager-node@localhost');
  assert.equal(git(dest, 'symbolic-ref', '--short', 'HEAD'), 'master');
});

test('an empty existing directory is accepted as the destination', () => {
  const root = tmp();
  const source = makeSource(root);
  const dest = path.join(root, 'empty');
  fs.mkdirSync(dest);
  const r = run([bundle(source, root, 'one.bundle'), dest]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dest, 'a.txt')));
});

test('the same bundle again changes nothing, a newer bundle fast-forwards, an older one changes nothing', () => {
  const root = tmp();
  const source = makeSource(root);
  const dest = path.join(root, 'copy');
  const first = bundle(source, root, 'one.bundle');
  assert.equal(run([first, dest]).status, 0);
  const again = run([first, dest]);
  assert.equal(again.status, 0, again.stderr);
  commit(source, 'b.txt', 'two\n');
  const second = bundle(source, root, 'two.bundle');
  const newer = run([second, dest]);
  assert.equal(newer.status, 0, newer.stderr);
  assert.equal(git(dest, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'master'));
  assert.equal(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8'), 'two\n');
  const older = run([first, dest]);
  assert.equal(older.status, 0, older.stderr);
  assert.equal(git(dest, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'master'), 'an older bundle does not move the clone back');
});

test('a dirty clone is refused with exit 3 and stays as it was', () => {
  const root = tmp();
  const source = makeSource(root);
  const dest = path.join(root, 'copy');
  assert.equal(run([bundle(source, root, 'one.bundle'), dest]).status, 0);
  commit(source, 'b.txt', 'two\n');
  const second = bundle(source, root, 'two.bundle');
  const before = git(dest, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dest, 'a.txt'), 'edited\n');
  const r = run([second, dest]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /uncommitted changes/);
  assert.equal(git(dest, 'rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'edited\n');
});

test('a clone with its own commit (diverged) is refused with exit 3 and stays as it was', () => {
  const root = tmp();
  const source = makeSource(root);
  const dest = path.join(root, 'copy');
  assert.equal(run([bundle(source, root, 'one.bundle'), dest]).status, 0);
  commit(dest, 'local.txt', 'mine\n');
  commit(source, 'b.txt', 'two\n');
  const before = git(dest, 'rev-parse', 'HEAD');
  const r = run([bundle(source, root, 'two.bundle'), dest]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /history that the bundle/);
  assert.equal(git(dest, 'rev-parse', 'HEAD'), before);
});

test('a clone on another branch is refused with exit 3', () => {
  const root = tmp();
  const source = makeSource(root);
  const dest = path.join(root, 'copy');
  const one = bundle(source, root, 'one.bundle');
  assert.equal(run([one, dest]).status, 0);
  git(dest, 'checkout', '-q', '-b', 'side');
  const r = run([one, dest]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not on branch master/);
});

test('another branch can be imported by name', () => {
  const root = tmp();
  const source = makeSource(root);
  git(source, 'checkout', '-q', '-b', 'main');
  commit(source, 'm.txt', 'main\n');
  const file = path.join(root, 'both.bundle');
  git(source, 'bundle', 'create', file, 'refs/heads/master', 'refs/heads/main');
  const dest = path.join(root, 'copy');
  const r = run([file, dest, 'main']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dest, 'm.txt')));
});

test('refusals exit 2 and change nothing', () => {
  const root = tmp();
  const source = makeSource(root);
  const good = bundle(source, root, 'one.bundle');
  const corrupt = path.join(root, 'corrupt.bundle');
  fs.writeFileSync(corrupt, 'not a bundle\n');
  const busy = path.join(root, 'busy');
  fs.mkdirSync(busy);
  fs.writeFileSync(path.join(busy, 'file.txt'), 'x\n');
  const fresh = path.join(root, 'fresh');
  const cases = [
    [[], /usage/], [[good], /usage/], [[good, fresh, 'master', 'extra'], /usage/], [['', fresh], /empty/], [[good, ''], /empty/],
    [[path.join(root, 'missing.bundle'), fresh], /cannot read the bundle/], [[corrupt, fresh], /does not verify/],
    [[good, fresh, 'nope'], /has no branch nope/], [[good, busy], /not empty and not a git work tree/],
  ];
  for (const [args, message] of cases) {
    const r = run(args);
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, message);
    assert.match(r.stderr, /import-repo-bundle:/);
  }
  assert.equal(fs.existsSync(fresh), false, 'a refused call creates no destination');
  assert.deepEqual(fs.readdirSync(busy), ['file.txt']);
});
