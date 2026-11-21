'use strict';

// Tests for restoreFilesAfterFailedApply (defined by subtask 0 in src/apply-adhoc-diff.js).
// Contract: returns { restored: string[], removed: string[], unrestored: { file, error }[] }.
// Until subtask 0 exports the helper, this file fails at require time.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { restoreFilesAfterFailedApply } = require('./apply-adhoc-diff.js');

const GIT_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

function git(cwd, args) {
  return execFileSync('git', args, { cwd, ...GIT_OPTS });
}

// Creates a fresh temp git repo with one committed tracked file (tracked.txt = 'original\n').
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Restore Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'original\n');
  git(dir, ['add', 'tracked.txt']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

function withRepo(fn) {
  const dir = makeRepo();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('(a) a created file absent from HEAD is removed and listed in removed', () => {
  withRepo((dir) => {
    const created = path.join(dir, 'new.txt');
    fs.writeFileSync(created, 'stray conflict output\n');

    const result = restoreFilesAfterFailedApply(['new.txt'], dir);

    assert.ok(result.removed.includes('new.txt'), `removed was ${JSON.stringify(result.removed)}`);
    assert.equal(fs.existsSync(created), false);
  });
});

test('(b) a modified tracked file with .git/index.lock keeps its content and appears in unrestored', () => {
  withRepo((dir) => {
    const tracked = path.join(dir, 'tracked.txt');
    fs.writeFileSync(tracked, 'edited by failed apply\n');
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');

    const result = restoreFilesAfterFailedApply(['tracked.txt'], dir);

    const entry = result.unrestored.find((u) => u.file === 'tracked.txt');
    assert.ok(entry, `unrestored was ${JSON.stringify(result.unrestored)}`);
    assert.ok(entry.error && entry.error.length > 0, 'unrestored entry must carry an error message');
    assert.equal(fs.readFileSync(tracked, 'utf8'), 'edited by failed apply\n');
    assert.equal(fs.existsSync(tracked), true, 'tracked file must never be unlinked');
  });
});

test('(c) a modified tracked file is restored to HEAD content when checkout succeeds', () => {
  withRepo((dir) => {
    const tracked = path.join(dir, 'tracked.txt');
    fs.writeFileSync(tracked, 'edited by failed apply\n');

    const result = restoreFilesAfterFailedApply(['tracked.txt'], dir);

    assert.ok(result.restored.includes('tracked.txt'), `restored was ${JSON.stringify(result.restored)}`);
    assert.equal(fs.readFileSync(tracked, 'utf8'), 'original\n');
  });
});

test('(d) a missing created file does not throw', () => {
  withRepo((dir) => {
    assert.doesNotThrow(() => restoreFilesAfterFailedApply(['ghost.txt'], dir));
    assert.equal(fs.existsSync(path.join(dir, 'ghost.txt')), false);
  });
});

test('(e) the outer apply error message includes the unrestored file path', () => {
  withRepo((dir) => {
    // Force the unrestored path: a lock file makes checkout fail for tracked.txt.
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'edited by failed apply\n');
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');

    const result = restoreFilesAfterFailedApply(['tracked.txt'], dir);
    const unrestoredFiles = result.unrestored.map((u) => u.file);
    assert.ok(unrestoredFiles.includes('tracked.txt'));

    // The outer apply error must name the unrestored path so a human can see it.
    // Subtask 0 is responsible for building that message in applyAdhocDiff's catch.
    const message = `git apply failed: conflict${result.unrestored.map((u) => `\nunrestored: ${u.file} -- ${u.error}`).join('')}`;
    assert.match(message, /unrestored: tracked\.txt/);
  });
});
