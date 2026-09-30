'use strict';

// Tests for branch-verdicts.js (the Unmerged Branches verdict rendering helpers). Pure functions, no DOM.
// Run: node --test python/dashboard/static/js/branch-verdicts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { branchVerdictKey, branchVerdictBorderStyle, branchVerdictBadgeHtml, branchVerdictDetailHtml, filterBranchesByVerdict, branchVerdictFilterBarHtml } = require('./branch-verdicts.js');

const B = (verdict, extra = {}) => ({ branch: 'agent/x', verdict, reasons: ['r1', 'r2'], source: 'manual', stale: false, ...extra });

test('border color: green merge, yellow needs-work, red discard, grey unverified', () => {
  assert.match(branchVerdictBorderStyle(B('merge')), /var\(--ok\)/);
  assert.match(branchVerdictBorderStyle(B('needs-work')), /var\(--warn\)/);
  assert.match(branchVerdictBorderStyle(B('discard')), /var\(--bad\)/);
  assert.match(branchVerdictBorderStyle(B(null)), /var\(--muted\)/);
});

test('a stale verdict is grey/unverified and shows the older-commit note', () => {
  const b = B(null, { stale: true, reasons: ['verdict is for an older commit'] });
  assert.equal(branchVerdictKey(b), 'unverified');
  assert.match(branchVerdictBorderStyle(b), /var\(--muted\)/);
  assert.match(branchVerdictBadgeHtml(b), /verdict is for an older commit/);
});

test('even a stale record that still names a verdict renders as unverified, not green', () => {
  assert.equal(branchVerdictKey(B('merge', { stale: true })), 'unverified');
});

test('badge shows the verdict word and only the first reason; detail lists them all', () => {
  const badge = branchVerdictBadgeHtml(B('discard'));
  assert.match(badge, />discard</);
  assert.match(badge, /r1/);
  assert.doesNotMatch(badge, /r2/);
  const detail = branchVerdictDetailHtml(B('discard'));
  assert.match(detail, /r1/);
  assert.match(detail, /r2/);
});

test('reasons are HTML-escaped', () => {
  assert.doesNotMatch(branchVerdictBadgeHtml(B('needs-work', { reasons: ['<script>x</script>'] })), /<script>/);
});

test('filter buckets: All / Unverified / Ready to merge / Needs work / Discard', () => {
  const list = [B('merge'), B('needs-work'), B('discard'), B(null), B('merge', { stale: true })];
  assert.equal(filterBranchesByVerdict(list, 'all').length, 5);
  assert.equal(filterBranchesByVerdict(list, 'unverified').length, 2);
  assert.equal(filterBranchesByVerdict(list, 'merge').length, 1);
  assert.equal(filterBranchesByVerdict(list, 'needs-work').length, 1);
  assert.equal(filterBranchesByVerdict(list, 'discard').length, 1);
});

test('filter bar shows counts and marks the active filter', () => {
  const html = branchVerdictFilterBarHtml([B('merge'), B(null)], 'merge');
  assert.match(html, /All \(2\)/);
  assert.match(html, /Ready to merge \(1\)/);
  assert.match(html, /Unverified \(1\)/);
  assert.match(html, /class="action" data-verdict-filter="merge"/);
});
