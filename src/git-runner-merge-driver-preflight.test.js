'use strict';

// Pre-flight in git-runner.js: warn when .gitattributes names a merge driver whose merge.<name>.driver is unset in this clone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRealGitRunner } = require('./git-runner.js');

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
}

function makeRepo(attrs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-driver-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  if (attrs !== null) fs.writeFileSync(path.join(dir, '.gitattributes'), attrs);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function captureErrors(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { fn(); } finally { console.error = orig; }
  return lines;
}

const ATTR = 'Docs/*_CANDIDATES.md merge=candidates-doc\n';

test('warns when the attribute names a driver that is not configured', () => {
  const repo = makeRepo(ATTR);
  const runner = createRealGitRunner(repo);
  let ret;
  const lines = captureErrors(() => { ret = runner.warnIfMergeDriverMissing(); });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /candidates-doc/);
  assert.match(lines[0], /setup-merge-drivers\.sh/);
  assert.ok(ret);
});

test('no warning when the driver is configured', () => {
  const repo = makeRepo(ATTR);
  git(repo, 'config', 'merge.candidates-doc.driver', 'true');
  const runner = createRealGitRunner(repo);
  const lines = captureErrors(() => { runner.warnIfMergeDriverMissing(); });
  assert.deepEqual(lines, []);
});

test('no warning when no merge attribute applies', () => {
  const repo = makeRepo(null);
  const runner = createRealGitRunner(repo);
  const lines = captureErrors(() => { runner.warnIfMergeDriverMissing(); });
  assert.deepEqual(lines, []);
});
