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
    enterProjectTab() {}, enterBrainDumpTab() {}, enterBranchesTab() {}, enterHygieneTab() {},
    renderNav() {},
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeHtmlBright: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    ...overrides,
  };
  vm.createContext(ctx);
  for (const f of ['core-ui.js', 'concepts-and-adhoc-tab.js', 'live-updates.js', 'branches-joblist-hardware-tabs.js']) {
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
  const resolve = (url, value) => {
    const queue = pending.get(url);
    if (!queue || queue.length === 0) {
      const reason = queue ? 'already consumed' : 'never fetched';
      const open = [...pending.entries()].filter(([, q]) => q.length > 0).map(([u]) => u);
      throw new Error(`resolve(): ${url} was ${reason}. Pending URLs: ${open.length ? open.join(', ') : '(none)'}`);
    }
    queue.shift().resolve(value);
  };
  return { ctx, main, fetchCalls, resolve };
}

test('resolve: an unfetched URL fails with a readable message naming it', () => {
  const { resolve } = loadDashboardScripts();
  assert.throws(
    () => resolve('/api/never-fetched', {}),
    (e) => /\/api\/never-fetched.*never fetched/.test(e.message) && !/Cannot read properties/.test(e.message),
  );
});

test('resolve: resolving the same URL twice fails on the second call naming it as already consumed', () => {
  const { ctx, resolve } = loadDashboardScripts();
  ctx.fetchJson('/api/double');
  resolve('/api/double', {});
  assert.throws(
    () => resolve('/api/double', {}),
    (e) => /\/api\/double.*already consumed/.test(e.message) && !/Cannot read properties/.test(e.message),
  );
});

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

// --- Forges first on a phone (2026-10-14): the owner uses the Forges group most from the phone and does not want to scroll the tab strip for it.
// navOrder(tabs, narrow) is the pure ordering step renderNav() uses; the second group renders the REAL renderNav into a fake #nav.

const { navOrder } = require('./core-ui.js');

const NAV_TABS = [
  { key: 'project', label: 'Project' }, { key: 'workers', label: 'Workers' },
  { group: 'Forges', children: [{ key: 'promptforge', label: 'PromptForge' }, { key: 'stageforge', label: 'StageForge' }] },
  { key: 'branches', label: 'Branches' },
  { group: 'Job Status', children: [{ key: 'pending', label: 'Pending' }] },
];
const names = tabs => tabs.map(t => t.group || t.key);

test('navOrder: on a narrow screen the Forges group comes first and everything else keeps its order', () => {
  assert.deepEqual(names(navOrder(NAV_TABS, true)), ['Forges', 'project', 'workers', 'branches', 'Job Status']);
});

test('navOrder: on a wide screen the order is untouched', () => {
  assert.deepEqual(names(navOrder(NAV_TABS, false)), ['project', 'workers', 'Forges', 'branches', 'Job Status']);
});

test('navOrder: no Forges group (no plugin declares one) leaves the list alone, and the input is never mutated', () => {
  const noForges = NAV_TABS.filter(t => t.group !== 'Forges');
  assert.deepEqual(names(navOrder(noForges, true)), names(noForges));
  const before = JSON.stringify(NAV_TABS);
  navOrder(NAV_TABS, true);
  assert.equal(JSON.stringify(NAV_TABS), before);
});

test('real renderNav on a phone puts the Forges header first, followed by its tabs, then the rest', () => {
  const buttons = [];
  const mkBtn = () => ({ className: '', style: {}, innerHTML: '', title: '', onclick: null });
  const nav = { innerHTML: '', appendChild(b) { buttons.push(b); } };
  const ctx = vm.createContext({
    console, localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: id => (id === 'nav' ? nav : null), createElement: mkBtn },
    window: { matchMedia: q => ({ matches: /max-width:\s*860px/.test(q), addEventListener() {} }) },
    counts: {}, activeTab: 'project', severityForTab: () => '', TAB_COUNT_SEVERITY_THRESHOLDS: {}, switchToTab() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'core-ui.js'), 'utf8'), ctx);
  vm.runInContext('TABS = ' + JSON.stringify(NAV_TABS), ctx);   // TABS is a `let` in the script: a property on the context would not reach it
  ctx.renderNav();
  const text = b => b.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.match(text(buttons[0]), /Forges/);
  assert.match(text(buttons[1]), /PromptForge/);
  assert.match(text(buttons[2]), /StageForge/);
  assert.match(text(buttons[3]), /Project/);
});

// --- fetchJson in-flight dedupe + failure memory (HUB0531 2/4). fetchJson is not exported from
// core-ui.js, so every test loads the REAL core-ui.js into a fresh vm context (fresh module state:
// fetchInFlight and fetchFailures start empty). fetchJson calls Date.now() directly and has no
// now() override, so the fake clock is the context's own Date global, swapped in after load.
// No timer is added to the code under test. fetch is a stub: destructive URLs throw (tripwire).

const DESTRUCTIVE_URL = /pipeline\/(stop|start)|\/workers?\/.*\/(enable|disable)|\/pause/;

function loadFetchJson() {
  const clock = { t: 1000 };
  const calls = [];
  const destructiveHits = [];
  let behaviour = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const ctx = vm.createContext({
    console,
    AbortController, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null, createElement: () => ({}) },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    counts: {}, activeTab: 'project', severityForTab: () => '', TAB_COUNT_SEVERITY_THRESHOLDS: {}, switchToTab() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'core-ui.js'), 'utf8'), ctx, { filename: 'core-ui.js' });
  ctx.Date = { now: () => clock.t };
  ctx.fetch = async (url) => {
    calls.push(url);
    if (DESTRUCTIVE_URL.test(url)) {
      destructiveHits.push(url);
      throw new Error('tripwire: destructive URL ' + url);
    }
    return behaviour(url);
  };
  return {
    fetchJson: ctx.fetchJson, calls, destructiveHits, clock,
    setBehaviour(fn) { behaviour = fn; },
  };
}

const okResponse = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
const failResponse = () => ({ ok: false, status: 500, json: async () => ({}) });

test('fetchJson: concurrent identical calls make one fetch and share one result', async () => {
  const h = loadFetchJson();
  const gate = deferred();
  h.setBehaviour(async () => { await gate.promise; return okResponse(); });
  const a = h.fetchJson('/api/x');
  const b = h.fetchJson('/api/x');
  assert.equal(h.calls.length, 1, 'second identical call shares the in-flight fetch');
  gate.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, rb);
  assert.deepEqual(h.calls, ['/api/x']);
  assert.equal(h.destructiveHits.length, 0);
});

test('fetchJson: a recent failure is returned without a second fetch', async () => {
  const h = loadFetchJson();
  h.setBehaviour(() => failResponse());
  await assert.rejects(h.fetchJson('/api/y'), /\/api\/y -> 500/);
  await assert.rejects(h.fetchJson('/api/y'), /\/api\/y -> 500/);
  assert.deepEqual(h.calls, ['/api/y'], 'the second call was served from failure memory');
  assert.equal(h.destructiveHits.length, 0);
});

test('fetchJson: after 15 s on a fake clock a new fetch happens', async () => {
  const h = loadFetchJson();
  let fail = true;
  h.setBehaviour(() => (fail ? failResponse() : okResponse()));
  await assert.rejects(h.fetchJson('/api/z'), /-> 500/);
  h.clock.t += 14999;
  await assert.rejects(h.fetchJson('/api/z'), /-> 500/);
  assert.equal(h.calls.length, 1, 'at 14999 ms the stored failure is still served');
  h.clock.t += 1;
  fail = false;
  const ok = await h.fetchJson('/api/z');
  assert.deepEqual(ok, { ok: true });
  assert.equal(h.calls.length, 2, 'at 15000 ms the failure expires and a new fetch runs');
  assert.equal(h.destructiveHits.length, 0);
});

test('fetchJson: a different URL is unaffected by a failure on another URL', async () => {
  const h = loadFetchJson();
  h.setBehaviour((url) => (url === '/api/a' ? failResponse() : okResponse()));
  await assert.rejects(h.fetchJson('/api/a'), /-> 500/);
  const b = await h.fetchJson('/api/b');
  assert.deepEqual(b, { ok: true });
  assert.deepEqual(h.calls, ['/api/a', '/api/b']);
  assert.equal(h.destructiveHits.length, 0);
});
