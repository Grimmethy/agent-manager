'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'setup-merge-drivers.sh');
const LINE = 'Docs/*_CANDIDATES.md merge=candidates-doc';
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const setup = (repo) => execFileSync('bash', [SCRIPT, repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo({ attributes = null } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-drivers-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(repo, 'Docs'));
  fs.writeFileSync(path.join(repo, 'Docs', 'A_CANDIDATES.md'), 'x\n');
  if (attributes !== null) fs.writeFileSync(path.join(repo, '.gitattributes'), attributes);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}
const driverActive = (repo) => /merge: candidates-doc/.test(git(repo, 'check-attr', 'merge', '--', 'Docs/A_CANDIDATES.md'));
const dirty = (repo) => git(repo, 'status', '--porcelain', '--untracked-files=no').trim();

test('tracked .gitattributes without the line: driver activated through info/attributes, tracked file never touched', () => {
  const repo = makeRepo({ attributes: '* text=auto\n*.bat text eol=crlf\n' });
  setup(repo);
  assert.equal(driverActive(repo), true);
  assert.equal(dirty(repo), '');
  assert.equal(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8'), '* text=auto\n*.bat text eol=crlf\n');
  assert.match(git(repo, 'config', 'merge.candidates-doc.driver'), /candidates-doc-merge-driver\.js/);
});

test('no .gitattributes at all: driver active, no working-tree file created', () => {
  const repo = makeRepo();
  setup(repo);
  assert.equal(driverActive(repo), true);
  assert.equal(fs.existsSync(path.join(repo, '.gitattributes')), false);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
});

test('a repo that commits the line itself: nothing is added anywhere', () => {
  const repo = makeRepo({ attributes: `${LINE}\n` });
  setup(repo);
  assert.equal(driverActive(repo), true);
  const info = path.join(repo, '.git', 'info', 'attributes');
  assert.equal(fs.existsSync(info) && fs.readFileSync(info, 'utf8').includes(LINE), false);
  assert.equal(dirty(repo), '');
});

test('repairs the old behaviour: the line an earlier version appended to a tracked file is removed, everything else kept', () => {
  const repo = makeRepo({ attributes: '* text=auto\n' });
  fs.appendFileSync(path.join(repo, '.gitattributes'), `${LINE}\n`);
  assert.notEqual(dirty(repo), '');
  const out = setup(repo);
  assert.match(out, /restored/);
  assert.equal(dirty(repo), '');
  assert.equal(driverActive(repo), true);
});

test('repairs the old behaviour: an untracked .gitattributes holding only the line is removed', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, '.gitattributes'), `${LINE}\n`);
  setup(repo);
  assert.equal(fs.existsSync(path.join(repo, '.gitattributes')), false);
  assert.equal(driverActive(repo), true);
});

test('other uncommitted edits in .gitattributes are never touched, even when the line is in there too', () => {
  const repo = makeRepo({ attributes: '* text=auto\n' });
  fs.writeFileSync(path.join(repo, '.gitattributes'), `* text=auto\n*.png binary\n${LINE}\n`);
  setup(repo);
  assert.equal(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8'), `* text=auto\n*.png binary\n${LINE}\n`);
  assert.equal(driverActive(repo), true);
});

test('an untracked .gitattributes with other content is left alone', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, '.gitattributes'), `*.png binary\n${LINE}\n`);
  setup(repo);
  assert.equal(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8'), `*.png binary\n${LINE}\n`);
});

test('idempotent: a second run changes nothing and adds no duplicate line', () => {
  const repo = makeRepo({ attributes: '* text=auto\n' });
  setup(repo); setup(repo);
  const info = fs.readFileSync(path.join(repo, '.git', 'info', 'attributes'), 'utf8');
  assert.equal(info.split('\n').filter((l) => l === LINE).length, 1);
});

test('survives `git stash -u` (the apply-clone reset path)', () => {
  const repo = makeRepo();
  setup(repo);
  fs.writeFileSync(path.join(repo, 'stray.txt'), 'x');
  git(repo, 'stash', 'push', '-u', '-q', '-m', 'reset');
  assert.equal(driverActive(repo), true);
});
