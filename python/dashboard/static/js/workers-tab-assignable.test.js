'use strict';

// canAssignTask (workers-tab.js): which Workers-tab cards get the assign-task UI. A worker-* heartbeat
// with assignable:false (brain-dump 1903, e.g. an external eval runner) opts out; same rule as app.py's
// _worker_lane_refusal. workers-tab.js is a plain global <script> holding only declarations at top level,
// so it loads into a bare vm context (same approach as index-script-order.test.js).
// Run: node --test python/dashboard/static/js/workers-tab-assignable.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWorkersTab() {
  const ctx = vm.createContext({ console, setInterval: () => 0, setTimeout: () => 0, document: {}, window: {}, localStorage: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8'), ctx, { filename: 'workers-tab.js' });
  return ctx;
}

test('canAssignTask: a worker that opts out with assignable:false gets no assign UI; lanes keep it; non-workers never had it', () => {
  const ctx = loadWorkersTab();
  const can = (inst) => vm.runInContext(`canAssignTask(${JSON.stringify(inst)})`, ctx);
  assert.equal(can({ instanceId: 'worker-kaggle-p40', assignable: false }), false);
  assert.equal(can({ instanceId: 'worker-3090' }), true);
  assert.equal(can({ instanceId: 'worker-3090', assignable: true }), true);
  assert.equal(can({ instanceId: 'worker-3090', assignable: null }), true);
  assert.equal(can({ instanceId: 'reviewer' }), false);
});
