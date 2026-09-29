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

// --- Stale-render guard + refresh in-flight guard (2026-09-29, "display stutters and switches
// to the wrong tab"). The first group tests the exported DOM-free helpers directly; the second
// loads the REAL core-ui.js / concepts-and-adhoc-tab.js / branches-joblist-hardware-tabs.js into
// one vm context (they are plain global <script>s in the browser, sharing one scope) with the
// few browser globals stubbed, so switchToTab, renderAdhocTasksTab and refresh run unmodified.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const helpers = require('./core-ui.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('runRefreshGuarded: a second call while the first is pending does not run fn; it runs again once the first settles', async () => {
  helpers._resetRenderStateForTest();
  let calls = 0;
  const gate = deferred();
  const fn = async () => { calls += 1; await gate.promise; };
  const first = helpers.runRefreshGuarded(fn);
  await helpers.runRefreshGuarded(fn);
  assert.equal(calls, 1);
  gate.resolve();
  await first;
  await helpers.runRefreshGuarded(async () => { calls += 1; });
  assert.equal(calls, 2);
});

test('runRefreshGuarded: a cycle older than maxMs no longer blocks a new one, and a throwing fn still clears the guard', async () => {
  helpers._resetRenderStateForTest();
  let t = 1000;
  const now = () => t;
  const stuck = deferred();
  let calls = 0;
  const first = helpers.runRefreshGuarded(async () => { calls += 1; await stuck.promise; }, { now, maxMs: 30000 });
  t += 29000;
  await helpers.runRefreshGuarded(async () => { calls += 1; }, { now, maxMs: 30000 });
  assert.equal(calls, 1, 'younger than maxMs: still blocked');
  t += 2000;
  await helpers.runRefreshGuarded(async () => { calls += 1; }, { now, maxMs: 30000 });
  assert.equal(calls, 2, 'older than maxMs: allowed through');
  stuck.resolve();
  await first;
  helpers._resetRenderStateForTest();
  await assert.rejects(helpers.runRefreshGuarded(async () => { throw new Error('boom'); }));
  let ran = false;
  await helpers.runRefreshGuarded(async () => { ran = true; });
  assert.equal(ran, true, 'guard was cleared by finally after the throw');
});

test('renderStaleCheck: fresh until the render generation is bumped, and a check taken after the bump is fresh again', () => {
  helpers._resetRenderStateForTest();
  const isStale = helpers.renderStaleCheck();
  assert.equal(isStale(), false);
  helpers.bumpRenderGeneration();
  assert.equal(isStale(), true);
  assert.equal(helpers.renderStaleCheck()(), false);
});

function loadDashboardScripts(overrides = {}) {
  const jsDir = __dirname;
  const main = { innerHTML: '', querySelectorAll: () => [] };
  const fetchCalls = [];
  const pending = new Map();
  const ctx = {
    console,
    document: { getElementById: () => main, activeElement: null },
    window: { scrollY: 0 },
    localStorage: { getItem: () => null, setItem() {} },
    activeTab: 'adhoc',
    counts: {},
    CORE_TABS: [{ key: 'adhoc', label: 'Adhoc' }, { key: 'models', label: 'Models' }],
    renderModelsTab: async () => {},
    leaveProjectTab() {}, leaveBrainDumpTab() {}, leaveBranchesTab() {}, leaveHygieneTab() {},
    enterProjectTab() {}, enterBrainDumpTab() {}, enterBranchesTab() {}, enterHygieneTab() {},
    renderNav() {},
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeHtmlBright: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    ...overrides,
  };
  vm.createContext(ctx);
  for (const f of ['core-ui.js', 'concepts-and-adhoc-tab.js', 'branches-joblist-hardware-tabs.js']) {
    vm.runInContext(fs.readFileSync(path.join(jsDir, f), 'utf8'), ctx, { filename: f });
  }
  ctx.renderNav = () => {}; // real one builds DOM nodes; not under test here
  // fetchJson replaced AFTER load: every URL becomes a controllable pending promise.
  ctx.fetchJson = (url) => {
    fetchCalls.push(url);
    const d = deferred();
    pending.set(url, [...(pending.get(url) || []), d]);
    return d.promise;
  };
  return { ctx, main, fetchCalls, resolve: (url, value) => pending.get(url).shift().resolve(value) };
}

test('real switchToTab + renderAdhocTasksTab: a render that resolves AFTER a tab switch does not paint over #main', async () => {
  const { ctx, main, resolve } = loadDashboardScripts();
  const render = ctx.renderAdhocTasksTab();
  ctx.switchToTab('models');
  resolve('/api/adhoc-tasks', { tasks: [{ id: 'adhoc-x', title: 'STALE-TAB-CONTENT', state: 'pending' }] });
  await render;
  assert.doesNotMatch(main.innerHTML, /STALE/, 'the adhoc render was superseded by the tab switch and must not write');
});

test('real switchToTab to a SELF-RENDERED tab (project) also supersedes an in-flight render, even though it never calls renderMain', async () => {
  const { ctx, main, resolve } = loadDashboardScripts();
  let projectEntered = false;
  ctx.enterProjectTab = () => { projectEntered = true; };
  const render = ctx.renderAdhocTasksTab();
  ctx.switchToTab('project');
  assert.equal(projectEntered, true);
  resolve('/api/adhoc-tasks', { tasks: [{ id: 'adhoc-x', title: 'STALE-OVER-PROJECT', state: 'pending' }] });
  await render;
  assert.doesNotMatch(main.innerHTML, /STALE/);
});

test('real renderAdhocTasksTab: with nothing overlapping it writes exactly as before', async () => {
  const { ctx, main, resolve } = loadDashboardScripts();
  const render = ctx.renderAdhocTasksTab();
  resolve('/api/adhoc-tasks', { tasks: [{ id: 'adhoc-x', title: 'REAL-CONTENT', state: 'pending' }] });
  await render;
  assert.match(main.innerHTML, /REAL-.*CONTENT/);
});

test('real refresh(): the 5s timer firing while a cycle (including its render) is pending makes no extra fetch', async () => {
  const { ctx, fetchCalls, resolve } = loadDashboardScripts();
  const first = ctx.refresh();
  assert.deepEqual(fetchCalls, ['/api/summary']);
  await ctx.refresh();
  assert.deepEqual(fetchCalls, ['/api/summary'], 'second refresh() returned without fetching');
  resolve('/api/summary', {});
  await new Promise((r) => setImmediate(r));
  resolve('/api/plugins', { plugins: [] });
  await new Promise((r) => setImmediate(r));
  resolve('/api/adhoc-tasks', { tasks: [] });
  await first;
  const after = fetchCalls.length;
  const next = ctx.refresh();
  assert.equal(fetchCalls.length, after + 1, 'after the first cycle settled, the next refresh() runs');
  resolve('/api/summary', {});
  await new Promise((r) => setImmediate(r));
  resolve('/api/plugins', { plugins: [] });
  await new Promise((r) => setImmediate(r));
  resolve('/api/adhoc-tasks', { tasks: [] });
  await next;
});
