'use strict';

// Unit test for core-ui.js's safeSourceNames() (AC-56, 2026-09-25) -- this is the FIRST
// test coverage this file has ever had. core-ui.js is a plain global <script> with no
// module system, DOM calls throughout, and heavy fetch/localStorage/document usage, so a
// full jsdom harness for the whole file is out of scope for this one bug fix.
// safeSourceNames is deliberately extracted as a small, dependency-injectable (accepts a
// sourceNamesFn override), DOM-free async function specifically so this one regression --
// an /api/job-types failure blanking an otherwise-successful task list -- is testable in
// isolation, without needing a browser.
//
// Run: node --test python/dashboard/static/js/core-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeSourceNames } = require('./core-ui.js');

// Test A (fails on the pre-fix code, passes after): the exact regression from the task --
// a rejected /api/job-types fetch must not propagate as an unhandled rejection; it must
// degrade to an empty array so the caller's already-successful task list still renders.
test('Test A: safeSourceNames falls back to [] when the source-names fetch rejects, instead of throwing', async () => {
  const failingFetch = () => Promise.reject(new Error('HTTP 500'));
  const result = await safeSourceNames(failingFetch);
  assert.deepEqual(result, []);
});

// Test B (must still pass after the fix): a successful fetch is passed through unchanged.
test('Test B: safeSourceNames returns the real names on a successful fetch, unchanged', async () => {
  const okFetch = () => Promise.resolve(['change_review', 'observability_fix']);
  const result = await safeSourceNames(okFetch);
  assert.deepEqual(result, ['change_review', 'observability_fix']);
});
