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
  emit(n, d) { (this.listeners[n] || []).forEach((f) => f(d === undefined ? {} : { data: JSON.stringify(d) })); }
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
  assert.equal(timers.length, 1);
  timers[0].fn();
  await settle();
  assert.deepEqual(names(calls), ['fetch:/api/summary', 'chip', 'sync', 'redirect?', 'nav', 'main']);
});

test('startPageLiveUpdates: a plugin announcement redraws the active tab of that plugin through the guard, nothing else does', async () => {
  const { ctx, calls, timers } = load({ activeTab: 'myplugin' });
  ctx.findTabByKey = (k) => (k === 'myplugin' ? { key: k, pluginScript: 'x.js', pluginName: 'my-plugin' } : null);
  ctx.startPageLiveUpdates();
  assert.equal(timers.length, 0);                                    // no interval is started at all while the stream is open
  FakeEventSource.last.emit('plugin-changed', { plugin: 'other-plugin' });
  await settle();
  assert.deepEqual(calls, []);
  FakeEventSource.last.emit('plugin-changed', { plugin: 'my-plugin' });
  await settle();
  assert.deepEqual(names(calls), ['main']);
});

test('startPageLiveUpdates: a queue tab has no owner plugin and no timer', async () => {
  const { ctx, calls, timers } = load({ activeTab: 'pending' });
  ctx.findTabByKey = () => null;
  ctx.startPageLiveUpdates();
  assert.equal(timers.length, 0);
  FakeEventSource.last.emit('plugin-changed', { plugin: 'my-plugin' });
  await settle();
  assert.deepEqual(calls, []);
});

test('applyLivePlan: a panels plan refreshes the Project tab pipeline and status panels, in that order, and only for that tab', async () => {
  const { ctx, calls } = load({ activeTab: 'project' });
  ctx.refreshPipelineStatus = async () => { calls.push(['pipeline-panel']); };
  ctx.refreshProjectStatus = async () => { calls.push(['status-panel']); };
  await ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: false, panels: true });
  assert.deepEqual(names(calls), ['pipeline-panel', 'status-panel']);
  const other = load({ activeTab: 'pending' });
  other.ctx.refreshPipelineStatus = async () => { other.calls.push(['pipeline-panel']); };
  other.ctx.refreshProjectStatus = async () => { other.calls.push(['status-panel']); };
  await other.ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: false, panels: true });
  assert.deepEqual(other.calls, []);
  const none = load({ activeTab: 'project' });
  none.ctx.refreshPipelineStatus = async () => { none.calls.push(['pipeline-panel']); };
  await none.ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: false, panels: false });
  assert.deepEqual(none.calls, []);
});

test('startPageLiveUpdates: the stream events refresh the Project tab panels, and the closed-stream fallback does too', async () => {
  const { ctx, calls, timers } = load({ activeTab: 'project' });
  ctx.refreshPipelineStatus = async () => { calls.push(['pipeline-panel']); };
  ctx.refreshProjectStatus = async () => { calls.push(['status-panel']); };
  ctx.startPageLiveUpdates();
  assert.equal(timers.length, 0);
  FakeEventSource.last.emit('pipeline-state-changed');
  await settle();
  assert.deepEqual(names(calls), ['pipeline-panel', 'status-panel']);
  calls.length = 0;
  FakeEventSource.last.emit('project-build-changed', { path: '/x' });
  await settle();
  assert.deepEqual(names(calls), ['pipeline-panel', 'status-panel']);
  calls.length = 0;
  FakeEventSource.last.readyState = 2;
  FakeEventSource.last.emit('error');
  timers[0].fn();
  await settle();
  assert.deepEqual(names(calls).slice(-2), ['pipeline-panel', 'status-panel']);
});

test('the Project tab has no timer of its own and core no longer calls a leaveProjectTab hook', () => {
  const tab = fs.readFileSync(path.join(__dirname, 'project-tab.js'), 'utf8');
  assert.doesNotMatch(tab, /setInterval|projectStatusInterval|leaveProjectTab/);
  const core = fs.readFileSync(path.join(__dirname, 'core-ui.js'), 'utf8');
  assert.doesNotMatch(core, /leaveProjectTab/);
});

test('applyLivePlan: a panels plan refreshes the Brain Dump entry list UNFORCED, and only for that tab', async () => {
  const { ctx, calls } = load({ activeTab: 'brain-dump' });
  ctx.refreshBrainDumpEntries = async (...a) => { calls.push(['entries:' + JSON.stringify(a)]); };
  ctx.refreshPipelineStatus = async () => { calls.push(['pipeline-panel']); };
  await ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: false, panels: true });
  assert.deepEqual(names(calls), ['entries:[]']);                          // no argument: the entry list keeps its guard against an open edit or discussion
  const other = load({ activeTab: 'pending' });
  other.ctx.refreshBrainDumpEntries = async () => { other.calls.push(['entries']); };
  await other.ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: false, panels: true });
  assert.deepEqual(other.calls, []);
});

test('startPageLiveUpdates: brain-dump-changed refreshes the open Brain Dump tab and no interval is started', async () => {
  const { ctx, calls, timers } = load({ activeTab: 'brain-dump' });
  ctx.refreshBrainDumpEntries = async () => { calls.push(['entries']); };
  ctx.startPageLiveUpdates();
  assert.equal(timers.length, 0);
  FakeEventSource.last.emit('brain-dump-changed');
  await settle();
  assert.deepEqual(names(calls), ['entries']);
});

test('the Brain Dump tab has no timer, no interval variable and core has no leaveBrainDumpTab hook', () => {
  const tab = fs.readFileSync(path.join(__dirname, 'brain-dump-and-second-brain.js'), 'utf8');
  assert.doesNotMatch(tab, /setInterval|brainDumpEntriesInterval|leaveBrainDumpTab\(\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'core-ui.js'), 'utf8'), /leaveBrainDumpTab/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8'), /brainDumpEntriesInterval/);
});

test('applyLivePlan: a panels plan reloads the Hygiene inventory QUIETLY, and only for that tab', async () => {
  const { ctx, calls } = load({ activeTab: 'hygiene' });
  ctx.loadHygiene = async (...a) => { calls.push(['hygiene:' + JSON.stringify(a)]); };
  ctx.refreshBrainDumpEntries = async () => { calls.push(['entries']); };
  await ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: false, panels: true });
  assert.deepEqual(names(calls), ['hygiene:[{"quiet":true}]']);
  const other = load({ activeTab: 'pending' });
  other.ctx.loadHygiene = async () => { other.calls.push(['hygiene']); };
  await other.ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: false, panels: true });
  assert.deepEqual(other.calls, []);
});

test('startPageLiveUpdates: counts-changed and hygiene-changed reload the open Hygiene tab and no interval is started', async () => {
  const { ctx, calls, timers } = load({ activeTab: 'hygiene' });
  ctx.loadHygiene = async () => { calls.push(['hygiene']); };
  ctx.startPageLiveUpdates();
  assert.equal(timers.length, 0);
  FakeEventSource.last.emit('hygiene-changed');
  await settle();
  assert.ok(names(calls).includes('hygiene'));
  calls.length = 0;
  FakeEventSource.last.emit('counts-changed');
  await settle();
  assert.ok(names(calls).includes('hygiene'));
});

test('the Hygiene tab has no timer, no poll constant and core has no leaveHygieneTab hook', () => {
  const tab = fs.readFileSync(path.join(__dirname, 'hygiene-tab.js'), 'utf8');
  assert.doesNotMatch(tab, /setInterval|hygienePollTimer|HYGIENE_POLL_MS|leaveHygieneTab/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'core-ui.js'), 'utf8'), /leaveHygieneTab/);
});

test('applyLivePlan: a branches plan passes the kick flag on to the Branches refresh', async () => {
  for (const kick of [true, false]) {
    const { ctx, calls } = load({ activeTab: 'branches' });
    ctx.refreshBranchesTab = async (...a) => { calls.push(['branches:' + JSON.stringify(a)]); };
    await ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: true, panels: false, kick });
    assert.deepEqual(names(calls), ['branches:[{"kick":' + kick + '}]'], 'kick=' + kick);
  }
});

test('startPageLiveUpdates: counts-changed kicks the Branches refresh, branch-list-changed does not, and no interval is started', async () => {
  const { ctx, calls, timers } = load({ activeTab: 'branches' });
  ctx.refreshBranchesTab = async (...a) => { calls.push(['branches:' + JSON.stringify(a)]); };
  ctx.startPageLiveUpdates();
  assert.equal(timers.length, 0);
  FakeEventSource.last.emit('counts-changed');
  await settle();
  assert.ok(names(calls).includes('branches:[{"kick":true}]'));
  calls.length = 0;
  FakeEventSource.last.emit('branch-list-changed', { project: 'active' });
  await settle();
  assert.deepEqual(names(calls), ['branches:[{"kick":false}]']);
});

test('fetchBranchList adds kick=1 to the list URL only when asked, and the Branches tab has no timer or leave hook', () => {
  const src = fs.readFileSync(path.join(__dirname, 'branch-projects.js'), 'utf8');
  assert.match(src, /kick \? BRANCHES_URL \+ '&kick=1' : BRANCHES_URL/);
  const tab = fs.readFileSync(path.join(__dirname, 'branches-joblist-hardware-tabs.js'), 'utf8');
  assert.doesNotMatch(tab, /branchesPollTimer|leaveBranchesTab/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'core-ui.js'), 'utf8'), /leaveBranchesTab/);
});

test('applyLivePlan: a modal plan asks the task-detail modal to refresh, and nothing else does', async () => {
  const { ctx, calls } = load({ activeTab: 'pending' });
  ctx.refreshTaskDetailModal = async () => { calls.push(['modal']); };
  await ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: false, panels: false, kick: false, modal: true });
  assert.deepEqual(names(calls), ['modal']);
  calls.length = 0;
  await ctx.applyLivePlan({ summary: false, plugins: false, nav: false, main: false, branches: false, panels: false, kick: false, modal: false });
  assert.deepEqual(calls, []);
});

test('startPageLiveUpdates: task-records-changed refreshes the modal, the closed-stream fallback does too, and no interval is started', async () => {
  const { ctx, calls, timers } = load({ activeTab: 'pending' });
  ctx.refreshTaskDetailModal = async () => { calls.push(['modal']); };
  ctx.startPageLiveUpdates();
  assert.equal(timers.length, 0);
  FakeEventSource.last.emit('task-records-changed');
  await settle();
  assert.deepEqual(names(calls), ['modal']);
  calls.length = 0;
  FakeEventSource.last.readyState = 2;
  FakeEventSource.last.emit('error');
  timers[0].fn();
  await settle();
  assert.ok(names(calls).includes('modal'));
});
