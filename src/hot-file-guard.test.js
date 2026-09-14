'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-file-guard-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'x'], { cwd: dir });
  return dir;
}

test('fileHasRecentCommits: true for a file committed just now, false for one never committed', () => {
  const { fileHasRecentCommits } = require('./hot-file-guard.js');
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, 'a.js'), 'x');
  execFileSync('git', ['add', 'a.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'add'], { cwd: dir });

  assert.equal(fileHasRecentCommits(dir, 'a.js'), true);
  assert.equal(fileHasRecentCommits(dir, 'never-existed.js'), false);
});

test('fileHasRecentCommits: false when days<=0, and a bad repoRoot fails safe to false (not an unhandled throw)', () => {
  const { fileHasRecentCommits } = require('./hot-file-guard.js');
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, 'a.js'), 'x');
  execFileSync('git', ['add', 'a.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'add'], { cwd: dir });

  assert.equal(fileHasRecentCommits(dir, 'a.js', 0), false);
  assert.equal(fileHasRecentCommits('/definitely/not/a/repo/path', 'a.js'), false);
});

test('HOT_FILE_DAYS: defaults to 7, honours AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS at require-time', () => {
  delete require.cache[require.resolve('./hot-file-guard.js')];
  const { HOT_FILE_DAYS: defaultDays } = require('./hot-file-guard.js');
  assert.equal(defaultDays, 7);

  const prev = process.env.AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS;
  process.env.AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS = '2';
  try {
    delete require.cache[require.resolve('./hot-file-guard.js')];
    const { HOT_FILE_DAYS: overridden } = require('./hot-file-guard.js');
    assert.equal(overridden, 2);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS; else process.env.AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS = prev;
    delete require.cache[require.resolve('./hot-file-guard.js')];
  }
});
