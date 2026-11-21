// Tests for branch-confirm-message.js (pure merge/discard confirm text builder).
// Run: node --test python/dashboard/static/js/branch-confirm-message.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchConfirmMessage } from './branch-confirm-message.js';

test('active project: names the project as active and shows no repoRoot line', () => {
  const msg = branchConfirmMessage({
    action: 'merge', branch: 'agent/x', mainBranch: 'main',
    projectLabel: 'agent-manager', repoRoot: '/repos/agent-manager', active: true, isDashboardRepo: true,
  });
  assert.match(msg, /Project: agent-manager \(active\)/);
  assert.doesNotMatch(msg, /\/repos\/agent-manager/);
});

test('other project: repoRoot is shown', () => {
  const msg = branchConfirmMessage({
    action: 'merge', branch: 'agent/x', mainBranch: 'main',
    projectLabel: 'other-proj', repoRoot: '/repos/other-proj', active: false, isDashboardRepo: false,
  });
  assert.match(msg, /Project: other-proj \(not the active project, runs in \/repos\/other-proj\)\./);
});

test('mainBranch main: merge line names main', () => {
  const msg = branchConfirmMessage({
    action: 'merge', branch: 'agent/x', mainBranch: 'main',
    projectLabel: 'p', repoRoot: '/r', active: true, isDashboardRepo: false,
  });
  assert.match(msg, /Merge "agent\/x" into main\?/);
});

test('mainBranch master: confirm contains "into master?"', () => {
  const msg = branchConfirmMessage({
    action: 'merge', branch: 'agent/x', mainBranch: 'master',
    projectLabel: 'p', repoRoot: '/r', active: true, isDashboardRepo: false,
  });
  assert.ok(msg.includes('into master?'), msg);
});

test('dashboard own repo merge: says sync the live dashboard and no does-not-change line', () => {
  const msg = branchConfirmMessage({
    action: 'merge', branch: 'agent/x', mainBranch: 'main',
    projectLabel: 'agent-manager', repoRoot: '/r', active: true, isDashboardRepo: true,
  });
  assert.ok(msg.includes('and sync the live dashboard'), msg);
  assert.doesNotMatch(msg, /does not change/);
});

test('non-dashboard merge: says does not change the running dashboard and no sync wording', () => {
  const msg = branchConfirmMessage({
    action: 'merge', branch: 'agent/x', mainBranch: 'main',
    projectLabel: 'other-proj', repoRoot: '/r', active: false, isDashboardRepo: false,
  });
  assert.ok(msg.includes('This does not change the running dashboard.'), msg);
  assert.doesNotMatch(msg, /sync the live dashboard/);
});

test('discard: has no sync wording', () => {
  const msg = branchConfirmMessage({
    action: 'discard', branch: 'agent/x', mainBranch: 'main',
    projectLabel: 'agent-manager', repoRoot: '/r', active: true, isDashboardRepo: true,
  });
  assert.match(msg, /Discard "agent\/x"\?/);
  assert.doesNotMatch(msg, /sync/i);
});

test('extraWarnings: each warning appears unchanged in the output', () => {
  const warnings = [
    '"agent/x" is flagged as WILL CONFLICT with master on: a.js, b.js.',
    '⚠ mid-flight — not ready to merge',
  ];
  const msg = branchConfirmMessage({
    action: 'merge', branch: 'agent/x', mainBranch: 'main',
    projectLabel: 'p', repoRoot: '/r', active: true, isDashboardRepo: false,
    extraWarnings: warnings,
  });
  for (const w of warnings) assert.ok(msg.split('\n').includes(w), msg);
});
