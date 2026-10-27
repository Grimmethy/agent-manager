'use strict';

// trajectoryLinkHtml (task-detail-modal.js, brain-dump 1892): the one link the task detail modal and the Workers
// card use to open routes/trajectories.py's page. task-detail-modal.js is a plain global <script> holding only
// declarations at top level, so it loads into a bare vm context (as in index-script-order.test.js).
// Run: node --test python/dashboard/static/js/trajectory-link.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('trajectoryLinkHtml encodes the task id; the modal and the Workers card both use it', () => {
  const ctx = vm.createContext({ console, setInterval: () => 0, setTimeout: () => 0, document: {}, window: {}, localStorage: {}, encodeURIComponent });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'task-detail-modal.js'), 'utf8'), ctx, { filename: 'task-detail-modal.js' });
  const html = vm.runInContext('trajectoryLinkHtml("adhoc a/b?c")', ctx);
  assert.match(html, /href="\/trajectory\/adhoc%20a%2Fb%3Fc"/);
  assert.match(html, /target="_blank"/);
  assert.match(fs.readFileSync(path.join(__dirname, 'task-detail-modal.js'), 'utf8'), /trajectoryLinkHtml\(task\.id\)/);
  assert.match(fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8'), /trajectoryLinkHtml\(inst\.currentTaskId\)/);
});
