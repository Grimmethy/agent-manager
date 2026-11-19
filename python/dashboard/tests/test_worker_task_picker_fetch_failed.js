'use strict';
// Covers the fetch-failure placeholder added to buildTaskPickerHtml (workers-tab.js passes a per-instance fetchFailed flag).
const { test } = require('node:test');
const assert = require('node:assert/strict');
// The picker reads escapeHtml / escapeAttr / hubTag from the browser's global scope; stub them here as the sibling tests do.
global.escapeHtml = global.escapeHtml || ((s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
global.escapeAttr = global.escapeAttr || ((s) => String(s == null ? '' : s).replace(/"/g, '&quot;'));
global.hubTag = global.hubTag || (() => '');
const { buildTaskPickerHtml } = require('../static/js/worker-task-picker.js');

test('a failed assignable-tasks fetch shows the distinct unavailable placeholder', () => {
  const html = buildTaskPickerHtml({ instanceId: 'worker-1' }, [], 'autodecomp', true);
  assert.match(html, /assignable tasks unavailable: fetch failed/);
  assert.doesNotMatch(html, /\(assign a task…\)/);
});

test('a successful fetch with zero tasks keeps the original placeholder', () => {
  const html = buildTaskPickerHtml({ instanceId: 'worker-1' }, [], 'autodecomp', false);
  assert.match(html, /\(assign a task…\)/);
  assert.doesNotMatch(html, /fetch failed/);
});
