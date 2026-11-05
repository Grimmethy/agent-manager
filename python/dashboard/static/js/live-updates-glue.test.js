'use strict';
// The page glue in branches-joblist-hardware-tabs.js (refreshSummary / refreshPluginTabs / refreshMain / refreshCycle / applyLivePlan / startPageLiveUpdates), run for real in a vm
// with the page's other functions stubbed. Run: node --test python/dashboard/static/js/live-updates-glue.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = {}; this.readyState = 0; FakeEventSource.last = this; }
  addEventListener(n, f) { (this.listeners[n] = this.listeners[n] || []).push(f); }
  emit(n) { (this.listeners[n] || []).forEach((f) => f({})); }
  close() { this.readyState = 2; }
}

function load(over = {}) {
  const calls = [];
  const status = { textContent: '' };
  const timers = [];
  const ctx = {
    console,
    document: { getElementById: () => status, activeElement: null },
    window: { scrollY: 0 },
    localStorage: { getItem: () => null, setItem() {} },
    activeTab: 'pending',
    counts: {},
    CORE_TABS: [{ key: 'pending', label: 'Pending' }],
    EventSource: FakeEventSource,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval() {},
    ...over,
  };
  vm.createContext(ctx);
  for (const f of ['core-ui.js', 'concepts-and-adhoc-tab.js', 'live-updates.js', 'branches-joblist-hardware-tabs.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
  }
  ctx.fetchJson = async (url) => { calls.push(['fetch', url]); return url === '/api/summary' ? { memory: { state: 'ok' } } : { plugins: [] }; };
  ctx.syncPluginTabs = async () => { calls.push(['sync']); };
  ctx.redirectFromGoneActiveTab = () => { calls.push(['redirect?']); return !!ctx.__redirect; };
  ctx.renderNav = () => calls.push(['nav']);
  ctx.renderMain = async () => { calls.push(['main']); };
  ctx.renderMemoryChip = () => calls.push(['chip']);
  ctx.refreshBranchesTab = async () => { calls.push(['branches']); };
  return { ctx, calls, status, timers };
}
const names = (calls) => calls.map((c) => c[0] + (c[1] && c[0] === 'fetch' ? ':' + c[1] : ''));
const settle = () => new Promise((r) => setTimeout(r, 15));

test('refreshSummary: fetches /api/summary, shows connected and the chip; a failure shows disconnected', async () => {
  const { ctx, calls, status } = load();
  await ctx.refreshSummary();
  assert.deepEqual(names(calls), ['fetch:/api/summary', 'chip']);
  assert.equal(status.textContent, 'connected');
  ctx.fetchJson = async () => { throw new Error('down'); };
  await ctx.refreshSummary();
  assert.equal(status.textContent, 'disconnected');
});

test('refreshCycle: summary, plugin sync, nav, then the tab', async () => {
  const { ctx, calls } = load();
  await ctx.refreshCycle();
  assert.deepEqual(names(calls), ['fetch:/api/summary', 'chip', 'sync', 'redirect?', 'nav', 'main']);
});

test('refreshCycle: when the active tab vanished and was redirected, nothing is rendered on top of the redirect', async () => {
  const { ctx, calls } = load();
  ctx.__redirect = true;
  await ctx.refreshCycle();
  assert.deepEqual(names(calls), ['fetch:/api/summary', 'chip', 'sync', 'redirect?']);
});

test('refreshMain: a self-rendering tab is not redrawn, any other is', async () => {
  const { ctx, calls } = load();
  for (const tab of ['project', 'brain-dump', 'branches', 'promptforge']) {
    ctx.activeTab = tab;
    await ctx.refreshMain();
  }
  assert.deepEqual(calls, []);
  ctx.activeTab = 'workers';
  await ctx.refreshMain();
  assert.deepEqual(names(calls), ['main']);
});

test('applyLivePlan: only what the plan asks for, in the cycle order', async () => {
  const { ctx, calls } = load();
  await ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: false });
  assert.deepEqual(calls, []);
  await ctx.applyLivePlan({ summary: true, plugins: true, nav: true, main: true, branches: true });
  assert.deepEqual(names(calls), ['fetch:/api/summary', 'chip', 'sync', 'redirect?', 'nav', 'main', 'branches']);
});

test('applyLivePlan: a redirect stops everything after the plugin sync', async () => {
  const { ctx, calls } = load();
  ctx.__redirect = true;
  await ctx.applyLivePlan({ summary: false, plugins: true, nav: true, main: true, branches: true });
  assert.deepEqual(names(calls), ['sync', 'redirect?']);
});

test('applyLivePlan: a plugin plan without a redirect carries on to nav and main', async () => {
  const { ctx, calls } = load();
  await ctx.applyLivePlan({ summary: false, plugins: true, nav: true, main: true, branches: false });
  assert.deepEqual(names(calls), ['sync', 'redirect?', 'nav', 'main']);
});

test('startPageLiveUpdates: events are applied through the in-flight guard for the active tab', async () => {
  const { ctx, calls } = load();
  ctx.startPageLiveUpdates();
  assert.equal(FakeEventSource.last.url, '/api/stream');
  FakeEventSource.last.emit('counts-changed');
  await settle();
  assert.deepEqual(names(calls), ['fetch:/api/summary', 'chip', 'nav', 'main']);
});

test('startPageLiveUpdates: when the stream is closed the fallback timer runs the full refresh', async () => {
  const { ctx, calls, timers, status } = load();
  ctx.startPageLiveUpdates();
  FakeEventSource.last.readyState = 2;
  FakeEventSource.last.emit('error');
  assert.equal(status.textContent, 'disconnected (polling)');
  assert.equal(timers.length, 2);
  timers[1].fn();
  await settle();
  assert.deepEqual(names(calls), ['fetch:/api/summary', 'chip', 'sync', 'redirect?', 'nav', 'main']);
});

test('startPageLiveUpdates: a plugin-owned active tab is redrawn by the transitional timer', async () => {
  const { ctx, calls, timers } = load({ activeTab: 'myplugin' });
  ctx.findTabByKey = (k) => (k === 'myplugin' ? { key: k, pluginScript: 'x.js' } : null);
  ctx.startPageLiveUpdates();
  timers[0].fn();
  await settle();
  assert.deepEqual(names(calls), ['main']);
});

test('startPageLiveUpdates: a queue tab is not redrawn by the transitional timer', async () => {
  const { ctx, calls, timers } = load({ activeTab: 'pending' });
  ctx.findTabByKey = () => null;
  ctx.startPageLiveUpdates();
  timers[0].fn();
  await settle();
  assert.deepEqual(calls, []);
});
