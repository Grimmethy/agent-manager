'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GIT_OWNERSHIP_RULE, dropGitWriteCriteria, isGitWriteRequest } = require('./git-ownership.js');

test('dropGitWriteCriteria drops history-dependent criteria and keeps file/command criteria', () => {
  const kept = [
    '`.env.tower.example` contains a comment stating six Prices',
    '`grep -c \'STRIPE_PRICE_\' .env.tower.example` returns 6',
    'No other line in the file still says "five Prices"',
    '`git diff --stat` shows only `.env.tower.example` changed',
    '`npm test` passes',
  ];
  const dropped = [
    '`git log --oneline master` contains a commit whose subject is exactly `fix(env.example): update price count`',
    'The change is merged to master',
    'The throwaway branch is no longer listed in `git branch --list` or is recorded as merged',
    '`git status` on `master` is clean (no uncommitted changes) after the merge',
    'A commit with message "fix: x" exists on main',
  ];
  assert.deepEqual(dropGitWriteCriteria([...kept, ...dropped]), kept);
});

test('isGitWriteRequest: git-write deliverables are refused, tasks that merely mention git are not', () => {
  for (const r of [
    { title: 'Commit stale-comment fix in .env.tower.example', description: 'x' },
    { title: 'Merge agent/observability-fix-ac-57 into master', description: 'x' },
    { title: 'Push the fix', description: 'x' },
    { title: 'Land the change', description: 'x' },
    { title: 'Tidy comment', description: 'Commit it with message `fix: x`, then merge to master.' },
    { title: 'Tidy comment', description: 'please merge the branch into main afterwards' },
  ]) assert.equal(isGitWriteRequest(r), true, JSON.stringify(r));
  for (const r of [
    { title: 'Fix the git-runner so it survives a detached HEAD', description: 'git merge-base returns empty; add a fallback' },
    { title: 'Add a merge-driver for candidates docs', description: 'setup-merge-drivers.sh should register it' },
    { title: 'Update price comment', description: 'Change one comment line in .env.tower.example.' },
    { title: 'Explain how commit hooks run', description: 'documentation only' },
  ]) assert.equal(isGitWriteRequest(r), false, JSON.stringify(r));
});

test('the rule text forbids history-writing git and tolerates read-only git', () => {
  for (const w of ['commit', 'merge', 'push', 'Read-only file system', 'Read-only git']) {
    assert.ok(GIT_OWNERSHIP_RULE.includes(w), w);
  }
});
