'use strict';

// workers-render-signature.js: the Workers tab skips an event/poll-driven redraw when nothing shown has changed (ADR-0024).
// Run: node --test python/dashboard/static/js/workers-render-signature.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'workers-render-signature.js'), 'utf8'), ctx, { filename: 'workers-render-signature.js' });
  return ctx;
}
const run = (ctx, expr, ...args) => { ctx.__a = args; return vm.runInContext(`(${expr})(...__a)`, ctx); };
const json = (v) => JSON.parse(JSON.stringify(v));

const inst = (over = {}) => ({ instanceId: 'worker-3090', status: 'working', currentTaskId: 'T1', pid: 7, stale: false, heartbeatAgeSeconds: 2, stateAgeSeconds: 40, lastHeartbeat: '2026-11-14T01:00:00Z', ...over });
const parts = (over = {}) => ({ instances: [inst()], stalledWorker: { trigger: { checkedAgeS: 5, endedAgeS: 90, state: 'idle' } }, ...over });
const ui = { expanded: null, pinned: {}, chosen: {}, completed: 25, newest: 'T0' };

test('workersStripVolatile: ages and heartbeat clock readings go, everything else stays, nesting included', () => {
  const ctx = load();
  const out = json(run(ctx, 'workersStripVolatile', { a: 1, heartbeatAgeSeconds: 3, stateAgeSeconds: 4, lastHeartbeat: 'x', _fetchedAtMs: 9, checkedAgeS: 1, endedAgeMs: 2, plain: { endedAgeS: 5, keep: [{ lastHeartbeat: 'y', n: 1 }] } }));
  assert.deepEqual(out, { a: 1, plain: { keep: [{ n: 1 }] } });
  assert.equal(run(ctx, 'workersStripVolatile', 5), 5);
  assert.equal(run(ctx, 'workersStripVolatile', null), null);
});

test('workersStripVolatile: a key that merely contains age is kept (stage, message, page)', () => {
  const out = json(run(load(), 'workersStripVolatile', { stage: 1, message: 2, page: 3, ageGroup: 4, Age: 5 }));
  assert.deepEqual(out, { stage: 1, message: 2, page: 3, ageGroup: 4 });
});

test('workersRenderSignature: the same page with only the ages moved gives the same signature', () => {
  const ctx = load();
  const a = run(ctx, 'workersRenderSignature', parts(), ui);
  const b = run(ctx, 'workersRenderSignature', parts({ instances: [inst({ heartbeatAgeSeconds: 9, stateAgeSeconds: 47, lastHeartbeat: '2026-11-14T01:00:07Z' })], stalledWorker: { trigger: { checkedAgeS: 12, endedAgeS: 97, state: 'idle' } } }), ui);
  assert.equal(a, b);
});

test('workersRenderSignature: a change of status, task, pid, staleness, a panel field or a new instance changes it', () => {
  const ctx = load();
  const base = run(ctx, 'workersRenderSignature', parts(), ui);
  for (const over of [{ instances: [inst({ status: 'idle' })] }, { instances: [inst({ currentTaskId: 'T2' })] }, { instances: [inst({ pid: 8 })] }, { instances: [inst({ stale: true })] },
    { stalledWorker: { trigger: { checkedAgeS: 5, endedAgeS: 90, state: 'running' } } }, { instances: [inst(), inst({ instanceId: 'reviewer' })] }]) {
    assert.notEqual(run(ctx, 'workersRenderSignature', parts(over), ui), base, JSON.stringify(over));
  }
});

test('workersRenderSignature: operator-side state changes it too (expanded card, pinned task, chosen type, completed log size or newest)', () => {
  const ctx = load();
  const base = run(ctx, 'workersRenderSignature', parts(), ui);
  for (const over of [{ expanded: 'worker-3090' }, { pinned: { 'worker-3090': 'T9' } }, { chosen: { 'worker-3090': 'draft' } }, { completed: 26 }, { newest: 'T5' }]) {
    assert.notEqual(run(ctx, 'workersRenderSignature', parts(), { ...ui, ...over }), base, JSON.stringify(over));
  }
});

function fakeMain(hasBar) { return { querySelector: (sel) => (sel === '.worker-filter-bar' && hasBar ? {} : null) }; }

test('workersCanSkipRender: only a poll/event redraw of an identical page over the cards drawn last time', () => {
  const ctx = load();
  run(ctx, 'rememberWorkersSignature', 'sig-1');
  assert.equal(run(ctx, 'workersCanSkipRender', 'sig-1', true, fakeMain(true)), true);
  assert.equal(run(ctx, 'workersCanSkipRender', 'sig-1', false, fakeMain(true)), false, 'an operator action always redraws');
  assert.equal(run(ctx, 'workersCanSkipRender', 'sig-1', undefined, fakeMain(true)), false);
  assert.equal(run(ctx, 'workersCanSkipRender', 'sig-2', true, fakeMain(true)), false, 'a different page redraws');
  assert.equal(run(ctx, 'workersCanSkipRender', 'sig-1', true, fakeMain(false)), false, 'another tab replaced #main: redraw');
  assert.equal(run(ctx, 'workersCanSkipRender', 'sig-1', true, null), false);
  assert.equal(run(ctx, 'workersCanSkipRender', 'sig-1', true, {}), false);
});

test('workersCanSkipRender: nothing is skipped before a first draw or after the memory is cleared', () => {
  const ctx = load();
  assert.equal(run(ctx, 'workersCanSkipRender', '', true, fakeMain(true)), false);
  assert.equal(run(ctx, 'workersCanSkipRender', 'sig-1', true, fakeMain(true)), false);
  run(ctx, 'rememberWorkersSignature', 'sig-1');
  run(ctx, 'rememberWorkersSignature', '');
  assert.equal(run(ctx, 'workersCanSkipRender', 'sig-1', true, fakeMain(true)), false);
  run(ctx, 'rememberWorkersSignature', undefined);
  assert.equal(run(ctx, 'workersCanSkipRender', '', true, fakeMain(true)), false);
});

test('wiring: index.html loads the module right after workers-tab.js and renderWorkers asks before drawing and remembers after', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  const tab = html.indexOf('/static/js/workers-tab.js'), sig = html.indexOf('/static/js/workers-render-signature.js');
  assert.ok(tab > 0 && sig > tab);
  const src = fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8');
  const ask = src.indexOf('workersCanSkipRender(renderSignature, isPoll, main)'), draw = src.indexOf('main.innerHTML = filterBar'), remember = src.indexOf('rememberWorkersSignature(renderSignature)');
  assert.ok(ask > 0 && draw > ask && remember > draw, 'ask, then draw, then remember');
  assert.match(src, /workersRenderSignature\(\s*\{ instances, workerModels, costSummary, recentTasks, cloudMeter, stalledWorker, verifierWorker, needsworkWorker, contextMapWorker, contextMemoryWorker, contextImpactWorker, pipelineOpsWorkers, assignableByInstance \}/);
  assert.match(src, /expanded: expandedWorkerId, pinned: pendingWorkerAssign, chosen: selectedWorkerTaskType, completed: completedTasksLog\.length/);
});

test('buildWorkersFilterBarHtml (moved out of renderWorkers to keep it under its size cap): the bar markup, the view toggle and the checked state of the Pause Claude box', () => {
  const src = fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8');
  const start = src.indexOf('function buildWorkersFilterBarHtml(');
  assert.ok(start > 0);
  const end = src.indexOf('\n}\n', start) + 3;
  const ctx = vm.createContext({ workersViewToggleHtml: (mode) => `<TOGGLE ${mode}>` });
  vm.runInContext(src.slice(start, end), ctx);
  const on = vm.runInContext('buildWorkersFilterBarHtml({ claudePaused: true })', ctx);
  const off = vm.runInContext('buildWorkersFilterBarHtml({ claudePaused: false })', ctx);
  assert.match(on, /class="worker-filter-bar"/);
  assert.match(on, /<TOGGLE cards>/);
  assert.match(on, /id="claude-pause-toggle"[^>]*checked/);
  assert.doesNotMatch(off, /id="claude-pause-toggle"[^>]*checked/);
  assert.match(src, /const filterBar = buildWorkersFilterBarHtml\(workerModels\);/);
  const noToggle = vm.createContext({});
  vm.runInContext(src.slice(start, end), noToggle);
  assert.match(vm.runInContext('buildWorkersFilterBarHtml({})', noToggle), /<div><\/div>/);
});
