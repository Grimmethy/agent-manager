'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'size-ratchet-check.js');
const lines = (n) => 'const x = 1;\n'.repeat(n);

function git(root, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}
// A repository on branch main with the given files committed, plus an allowlist file outside the tree.
function repo(files, allowlist) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'size-check-'));
  git(root, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const al = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'size-check-al-')), 'allowlist.json');
  fs.writeFileSync(al, JSON.stringify(allowlist));
  return { root, al };
}
function run(r, args) {
  const p = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: r.root,
    env: { ...process.env, AGENT_MANAGER_SIZE_RATCHET_ROOT: r.root, AGENT_MANAGER_SIZE_RATCHET_ALLOWLIST: r.al, AGENT_MANAGER_MAX_FILE_LINES: '500', AGENT_MANAGER_MAX_FUNCTION_LINES: '100' },
    encoding: 'utf8',
  });
  return { status: p.status, out: p.stdout, err: p.stderr };
}
function branch(r, edits) {
  git(r.root, 'checkout', '-q', '-b', 'work');
  for (const [rel, text] of Object.entries(edits)) write(r.root, rel, text);
  git(r.root, 'add', '-A');
  git(r.root, 'commit', '-q', '-m', 'work');
}

test('a branch that grows a listed file past its cap fails and names the file', () => {
  const r = repo({ 'src/big.js': lines(510) }, { files: { 'src/big.js': 510 }, functions: {} });
  branch(r, { 'src/big.js': lines(520) });
  const res = run(r, ['--base', 'main']);
  assert.equal(res.status, 1);
  assert.match(res.err, /file src\/big\.js grew to 520 lines \(cap 510\)/);
});

test('a branch that adds a new file over the limit fails as not on the allowlist', () => {
  const r = repo({ 'src/a.js': lines(3) }, { files: {}, functions: {} });
  branch(r, { 'src/new.js': lines(501) });
  const res = run(r, ['--base', 'main']);
  assert.equal(res.status, 1);
  assert.match(res.err, /file src\/new\.js has 501 lines and is not on the allowlist/);
});

test('only changed files are scanned: an unrelated unlisted oversized file does not fail the check', () => {
  const r = repo({ 'src/legacy.js': lines(900), 'src/small.js': lines(3) }, { files: {}, functions: {} });
  branch(r, { 'src/small.js': lines(4) });
  const res = run(r, ['--base', 'main']);
  assert.equal(res.status, 0, res.err);
  assert.match(res.out, /scanned 1 changed file\(s\)/);
});

test('a branch that shrinks a listed file passes', () => {
  const r = repo({ 'src/big.js': lines(520) }, { files: { 'src/big.js': 520 }, functions: {} });
  branch(r, { 'src/big.js': lines(505) });
  assert.equal(run(r, ['--base', 'main']).status, 0);
});

test('a trial merge that is staged but not committed is checked too', () => {
  const r = repo({ 'src/a.js': lines(3) }, { files: {}, functions: {} });
  branch(r, { 'src/new.js': lines(501) });
  git(r.root, 'checkout', '-q', 'main');
  git(r.root, 'merge', '--no-commit', '--no-ff', 'work');
  const res = run(r, ['--base', 'main']);
  assert.equal(res.status, 1);
  assert.match(res.err, /file src\/new\.js has 501 lines/);
});

test('a missing --base, or a base that does not exist, exits 2', () => {
  const r = repo({ 'src/a.js': lines(3) }, { files: {}, functions: {} });
  assert.equal(run(r, []).status, 2);
  assert.equal(run(r, ['--base', 'no-such-ref']).status, 2);
});
