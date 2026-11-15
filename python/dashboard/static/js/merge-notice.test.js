'use strict';
// Run: node --test python/dashboard/static/js/merge-notice.test.js
// After a merge that SUCCEEDED but left something undone (2026-11-03: a git timeout while fast-forwarding the dashboard's own checkout), the owner is told, in words, that the merge is on origin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'branches-joblist-hardware-tabs.js'), 'utf8');
const a = src.indexOf('function mergeNoticeText(result) {');
const b = src.indexOf('function wireBranchCard(card) {');
assert.ok(a >= 0 && b > a, 'mergeNoticeText is defined before wireBranchCard');
const mergeNoticeText = new Function(`${src.slice(a, b)}; return mergeNoticeText;`)();

test('a clean merge shows nothing', () => {
  assert.equal(mergeNoticeText({ succeeded: true, liveSync: { synced: true, changed: true }, warnings: [] }), '');
  assert.equal(mergeNoticeText({ succeeded: true }), '');
  assert.equal(mergeNoticeText(null), '');
});

test('a synced:false live sync shows its reason', () => {
  const t = mergeNoticeText({ succeeded: true, liveSync: { synced: false, reason: 'git did not answer in time' }, warnings: [] });
  assert.match(t, /^Merged, but not everything finished/);
  assert.match(t, /git did not answer in time/);
});

test('a skipped sync (another project) is not a problem and shows nothing', () => {
  assert.equal(mergeNoticeText({ succeeded: true, liveSync: { skipped: 'not the dashboard\'s own repo' }, warnings: [] }), '');
});

test('warnings are listed, and the same sentence is not repeated when the sync reason is also a warning', () => {
  const t = mergeNoticeText({ succeeded: true, liveSync: { synced: false, reason: 'A' }, warnings: ['A', 'B'] });
  assert.equal(t.split('A').length - 1, 1);
  assert.match(t, /B/);
});

test('a warning alone (record stamp failed) shows even when the sync worked', () => {
  const t = mergeNoticeText({ succeeded: true, liveSync: { synced: true }, warnings: ['Problem while stamping the task record: disk full.'] });
  assert.match(t, /stamping the task record/);
});

test('a synced:false without a reason shows nothing (no empty bullet)', () => {
  assert.equal(mergeNoticeText({ succeeded: true, liveSync: { synced: false }, warnings: [] }), '');
});

test('the merge button handler uses it and still treats a succeeded response as a success', () => {
  const h = src.slice(src.indexOf('const notice = mergeNoticeText(result);'));
  assert.ok(h.startsWith('const notice = mergeNoticeText(result);\n        if (notice) alert(notice);'));
  assert.match(src, /if \(!resp\.ok \|\| !result\.succeeded\) throw new Error\(result\.reason/);
});

test('only an explicit synced:false is a problem: a sync result that merely carries a reason shows nothing', () => {
  assert.equal(mergeNoticeText({ succeeded: true, liveSync: { skipped: 'not the dashboard\'s own repo', reason: 'n/a' }, warnings: [] }), '');
  assert.equal(mergeNoticeText({ succeeded: true, liveSync: { synced: true, reason: 'fine' }, warnings: [] }), '');
});
