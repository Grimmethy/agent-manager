'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { branchPendingListHtml } = require('../python/dashboard/static/js/branch-pending-list.js');

// Fixed "now" timestamp for deterministic elapsed-time assertions.
// 2026-05-20 12:00:00 UTC in ms.
const NOW_MS = 1_779_552_000_000;

test('names the stuck project in the error line and keeps other projects rendering', () => {
  const scan = {
    pending: [
      { label: 'alpha', state: 'pending', startedAt: null },
      { label: 'beta', state: 'pending', startedAt: Math.floor((NOW_MS - 60_000) / 1000) },
      { label: 'gamma', state: 'pending', startedAt: Math.floor((NOW_MS - 3_600_000) / 1000) },
    ],
    errors: [
      { label: 'stuck-project', error: 'Scan timed out after 30s' },
    ],
  };

  const html = branchPendingListHtml(scan, NOW_MS);

  // Error section names the stuck project and includes its error message.
  assert.match(html, />Errors</);
  assert.match(html, /stuck-project/);
  assert.match(html, /Scan timed out after 30s/);

  // Other projects still render with elapsed time.
  assert.match(html, /Scanning \(3 projects\)/);
  assert.match(html, /alpha/);
  assert.match(html, /beta/);
  assert.match(html, /gamma/);

  // Beta elapsed ~ 1 minute (NOW_MS - 60_000 = 1 min ago).
  assert.match(html, /1m 0s/);

  // Gamma elapsed ~ 1 hour (NOW_MS - 3_600_000 = 1 hour ago).
  assert.match(html, />1h<|>1h </);

  // Scan buttons present (data-scan-project attribute on every item).
  assert.match(html, /data-scan-project="stuck-project"/);
  assert.match(html, /data-scan-project="alpha"/);
  assert.match(html, /data-scan-project="beta"/);
  assert.match(html, /data-scan-project="gamma"/);

  // Container element present.
  assert.match(html, /class="branch-pending-list"/);
});

test('pending item with no startedAt shows "waiting" instead of elapsed', () => {
  const scan = {
    pending: [
      { label: 'alpha', state: 'pending', startedAt: null },
    ],
    errors: [],
  };

  const html = branchPendingListHtml(scan, NOW_MS);
  assert.match(html, />Scanning \(1 project\)/);
  assert.match(html, /waiting/);
  assert.match(html, /data-scan-project="alpha"/);
});

test('returns empty string when there is nothing to show', () => {
  assert.equal(branchPendingListHtml({}, NOW_MS), '');
  assert.equal(branchPendingListHtml(null, NOW_MS), '');
  assert.equal(branchPendingListHtml({ pending: [], errors: [] }, NOW_MS), '');
});
