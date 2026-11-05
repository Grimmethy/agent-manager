'use strict';
// Run: node --test python/dashboard/static/js/live-updates.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lu = require('./live-updates.js');

const plan = (o) => ({ ...lu.NO_PLAN, ...o });

class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = {}; this.readyState = 0; this.closed = false; FakeEventSource.last = this; }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  emit(name) { (this.listeners[name] || []).forEach((fn) => fn({ type: name })); }
  close() { this.closed = true; this.readyState = 2; }
}

function harness(over = {}) {
  const applied = [];
  const polls = [];
  const statuses = [];
  const timers = [];
  const cleared = [];
  let tab = over.tab || 'pending';
  const h = {
    applied, polls, statuses, timers, cleared,
    setTab: (t) => { tab = t; },
    fire: (i) => timers[i].fn(),
  };
  h.live = lu.startLiveUpdates({
    EventSource: over.EventSource === undefined ? FakeEventSource : over.EventSource,
    apply: over.apply || (async (p) => { applied.push(p); }),
    poll: async () => { polls.push(1); },
    getTab: () => tab,
    isPluginTab: over.isPluginTab,
    setStatus: (t) => statuses.push(t),
    setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearIntervalFn: (id) => cleared.push(id),
  });
  return h;
}

test('counts-changed: summary and nav always, a redraw only for a queue tab', () => {
  assert.deepEqual(lu.planForEvent('counts-changed', 'pending'), plan({ summary: true, nav: true, main: true }));
  assert.deepEqual(lu.planForEvent('counts-changed', 'blocked'), plan({ summary: true, nav: true, main: true }));
  assert.deepEqual(lu.planForEvent('counts-changed', 'workers'), plan({ summary: true, nav: true, main: true }));      // the Workers tab lists completed tasks
  assert.deepEqual(lu.planForEvent('counts-changed', 'project'), plan({ summary: true, nav: true }));
  assert.deepEqual(lu.planForEvent('counts-changed', 'myplugin', (t) => t === 'myplugin'), plan({ summary: true, nav: true }));
});

test('a queue tab that is also self-rendering is never redrawn', () => {
  assert.equal(lu.isQueueTab('filed'), false);
  assert.equal(lu.planForEvent('counts-changed', 'filed').main, false);
});

test('memory-changed refreshes only the summary', () => {
  assert.deepEqual(lu.planForEvent('memory-changed', 'pending'), plan({ summary: true }));
  assert.deepEqual(lu.planForEvent('memory-changed', 'workers'), plan({ summary: true }));
});

test('plugins-changed re-syncs the plugin tabs and redraws only the Plugins tab', () => {
  assert.deepEqual(lu.planForEvent('plugins-changed', 'pending'), plan({ plugins: true, nav: true }));
  assert.deepEqual(lu.planForEvent('plugins-changed', 'plugins'), plan({ plugins: true, nav: true, main: true }));
});

test('workers-changed redraws only the Workers tab', () => {
  assert.deepEqual(lu.planForEvent('workers-changed', 'workers'), plan({ main: true }));
  for (const tab of ['pending', 'hardware', 'joblist', 'adhoc']) assert.deepEqual(lu.planForEvent('workers-changed', tab), lu.NO_PLAN, tab);
});

test('worker-panels-changed redraws the Workers, Job List and Models tabs only', () => {
  for (const tab of ['workers', 'joblist', 'models']) assert.deepEqual(lu.planForEvent('worker-panels-changed', tab), plan({ main: true }), tab);
  for (const tab of ['pending', 'hardware', 'adhoc']) assert.deepEqual(lu.planForEvent('worker-panels-changed', tab), lu.NO_PLAN, tab);
});

test('settings-changed redraws only the Job List and Models tabs', () => {
  for (const tab of ['joblist', 'models']) assert.deepEqual(lu.planForEvent('settings-changed', tab), plan({ main: true }), tab);
  for (const tab of ['pending', 'workers', 'adhoc', 'hardware']) assert.deepEqual(lu.planForEvent('settings-changed', tab), lu.NO_PLAN, tab);
});

test('hardware-changed, tokenfold-changed and reports-changed redraw only their own tabs', () => {
  const want = { 'hardware-changed': ['hardware'], 'tokenfold-changed': ['tokenfold', 'reports'], 'reports-changed': ['reports'] };
  for (const [name, tabs] of Object.entries(want)) {
    for (const tab of tabs) assert.deepEqual(lu.planForEvent(name, tab), plan({ main: true }), name + ' ' + tab);
    for (const tab of ['pending', 'workers', 'joblist', 'models', 'hardware', 'tokenfold', 'reports'].filter((t) => !tabs.includes(t))) assert.deepEqual(lu.planForEvent(name, tab), lu.NO_PLAN, name + ' ' + tab);
  }
  assert.deepEqual([...lu.HARDWARE_DRIVEN_TABS], ['hardware']);
  assert.deepEqual([...lu.TOKENFOLD_DRIVEN_TABS], ['tokenfold', 'reports']);
  assert.deepEqual([...lu.REPORTS_DRIVEN_TABS], ['reports']);
});

test('discovery-changed redraws only the Deep Dive and Discovery tabs', () => {
  for (const tab of ['deepdive', 'discovery']) assert.deepEqual(lu.planForEvent('discovery-changed', tab), plan({ main: true }), tab);
  for (const tab of ['pending', 'workers', 'models', 'reports', 'plugins']) assert.deepEqual(lu.planForEvent('discovery-changed', tab), lu.NO_PLAN, tab);
  assert.deepEqual([...lu.DISCOVERY_DRIVEN_TABS], ['deepdive', 'discovery']);
});

test('plugin-states-changed redraws only the Plugins tab and touches no nav or summary', () => {
  assert.deepEqual(lu.planForEvent('plugin-states-changed', 'plugins'), plan({ main: true }));
  for (const tab of ['pending', 'workers', 'models', 'deepdive', 'branches']) assert.deepEqual(lu.planForEvent('plugin-states-changed', tab), lu.NO_PLAN, tab);
  assert.ok(lu.LIVE_EVENTS.includes('plugin-states-changed'));
});

test('benchmark-changed redraws only the Models tab', () => {
  assert.deepEqual(lu.planForEvent('benchmark-changed', 'models'), plan({ main: true }));
  for (const tab of ['pending', 'workers', 'joblist', 'hardware']) assert.deepEqual(lu.planForEvent('benchmark-changed', tab), lu.NO_PLAN, tab);
  assert.deepEqual([...lu.BENCHMARK_DRIVEN_TABS], ['models']);
});

test('counts-changed also redraws the Workers, Adhoc and Job List tabs', () => {
  for (const tab of ['workers', 'adhoc', 'joblist', 'discovery']) assert.deepEqual(lu.planForEvent('counts-changed', tab), plan({ summary: true, nav: true, main: true }), tab);
  assert.deepEqual(lu.planForEvent('counts-changed', 'deepdive'), plan({ summary: true, nav: true }));
  assert.deepEqual([...lu.COUNT_DRIVEN_TABS], ['workers', 'adhoc', 'joblist', 'discovery']);
  assert.deepEqual([...lu.PANEL_DRIVEN_TABS], ['workers', 'joblist', 'models']);
  assert.deepEqual([...lu.SETTINGS_DRIVEN_TABS], ['joblist', 'models']);
});

test('branches-changed refreshes only the Branches tab', () => {
  assert.deepEqual(lu.planForEvent('branches-changed', 'branches'), plan({ branches: true }));
  assert.deepEqual(lu.planForEvent('branches-changed', 'pending'), lu.NO_PLAN);
});

test('snapshot and project-changed refresh everything the active tab allows', () => {
  for (const name of ['snapshot', 'project-changed']) {
    assert.deepEqual(lu.planForEvent(name, 'pending'), plan({ summary: true, plugins: true, nav: true, main: true }));
    assert.deepEqual(lu.planForEvent(name, 'project'), plan({ summary: true, plugins: true, nav: true }));
    assert.deepEqual(lu.planForEvent(name, 'branches'), plan({ summary: true, plugins: true, nav: true, branches: true }));
  }
});

test('an unknown event asks for nothing', () => {
  assert.deepEqual(lu.planForEvent('nonsense-changed', 'pending'), lu.NO_PLAN);
});

test('merge and empty-plan helpers', () => {
  assert.deepEqual(lu.mergePlans(plan({ summary: true }), plan({ main: true })), plan({ summary: true, main: true }));
  assert.equal(lu.isEmptyPlan(lu.NO_PLAN), true);
  assert.equal(lu.isEmptyPlan(plan({ branches: true })), false);
  for (const k of Object.keys(lu.NO_PLAN)) assert.equal(lu.isEmptyPlan(plan({ [k]: true })), false, k);
});

test('mergePlans keeps every flag from either side', () => {
  for (const k of Object.keys(lu.NO_PLAN)) {
    assert.deepEqual(lu.mergePlans(plan({ [k]: true }), lu.NO_PLAN), plan({ [k]: true }), `${k} from the first`);
    assert.deepEqual(lu.mergePlans(lu.NO_PLAN, plan({ [k]: true })), plan({ [k]: true }), `${k} from the second`);
  }
});

test('a plugin that replaces a self-rendering tab (an iframe) is never put on the transitional timer', () => {
  assert.equal(lu.transitionalPollDue('promptforge', () => true), false);
  assert.equal(lu.transitionalPollDue('project', () => true), false);
});

test('the transitional list is exactly the tabs that have no events yet', () => {
  assert.deepEqual(lu.TRANSITIONAL_POLLED_TABS, []);
  assert.equal(lu.transitionalPollDue('plugins'), false);
  for (const t of lu.TRANSITIONAL_POLLED_TABS) assert.equal(lu.transitionalPollDue(t), true, t);
  for (const t of ['pending', 'blocked', 'done']) assert.equal(lu.transitionalPollDue(t), false, t);
  for (const t of lu.SELF_RENDERING_TABS) assert.equal(lu.transitionalPollDue(t), false, t);
  assert.equal(lu.transitionalPollDue('myplugin', (x) => x === 'myplugin'), true);
});

test('the Workers, Adhoc, Job List, Models, Hardware, TokenFold and Reports tabs no longer need the redraw timer: they have events', () => {
  for (const tab of ['workers', 'adhoc', 'joblist', 'models', 'hardware', 'tokenfold', 'reports', 'deepdive', 'discovery']) assert.equal(lu.transitionalPollDue(tab), false, tab);
  for (const e of ['hardware-changed', 'tokenfold-changed', 'reports-changed', 'discovery-changed']) assert.ok(lu.LIVE_EVENTS.includes(e), e);
  assert.ok(lu.LIVE_EVENTS.includes('settings-changed'));
  assert.ok(lu.LIVE_EVENTS.includes('benchmark-changed'));
  assert.ok(lu.LIVE_EVENTS.includes('worker-panels-changed'));
});

test('every transitional or self-rendering tab is a known non-queue tab', () => {
  for (const t of [...lu.TRANSITIONAL_POLLED_TABS, ...lu.SELF_RENDERING_TABS]) assert.ok(lu.NON_QUEUE_TABS.includes(t), t);
});

test('the connection opens the stream URL and listens to every event name', () => {
  const h = harness();
  assert.equal(FakeEventSource.last.url, '/api/stream');
  assert.deepEqual(Object.keys(FakeEventSource.last.listeners).sort(), [...lu.LIVE_EVENTS, 'error', 'open'].sort());
  FakeEventSource.last.emit('open');
  assert.deepEqual(h.statuses, ['connected']);
});

test('an event applies its plan for the active tab', async () => {
  const h = harness({ tab: 'pending' });
  FakeEventSource.last.emit('counts-changed');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.applied, [plan({ summary: true, nav: true, main: true })]);
});

test('an event with nothing to do for this tab applies nothing', async () => {
  const h = harness({ tab: 'pending' });
  FakeEventSource.last.emit('workers-changed');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.applied, []);
});

test('events that arrive while a plan is being applied are merged and applied after it, never concurrently', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  let active = 0;
  let maxActive = 0;
  const h = harness({
    tab: 'pending',
    apply: async (p) => { active += 1; maxActive = Math.max(maxActive, active); seen.push(p); if (seen.length === 1) await gate; active -= 1; },
  });
  FakeEventSource.last.emit('memory-changed');
  await new Promise((r) => setImmediate(r));
  FakeEventSource.last.emit('counts-changed');
  FakeEventSource.last.emit('plugins-changed');
  assert.equal(seen.length, 1);
  assert.equal(h.live.state().pending, true);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], plan({ summary: true, plugins: true, nav: true, main: true }));
  assert.equal(maxActive, 1);
  assert.equal(h.live.state().running, false);
});

test('a failing apply does not stop the next one', async () => {
  let n = 0;
  const h = harness({ tab: 'pending', apply: async () => { n += 1; if (n === 1) throw new Error('boom'); } });
  FakeEventSource.last.emit('counts-changed');
  await new Promise((r) => setImmediate(r));
  FakeEventSource.last.emit('counts-changed');
  await new Promise((r) => setImmediate(r));
  assert.equal(n, 2);
  assert.equal(h.live.state().running, false);
});

test('an error while the browser is retrying shows disconnected but does not start the fallback', () => {
  const h = harness();
  FakeEventSource.last.readyState = 0;
  FakeEventSource.last.emit('error');
  assert.deepEqual(h.statuses, ['disconnected']);
  assert.equal(h.live.state().fallback, false);
  assert.equal(h.timers.length, 1);        // only the transitional timer
});

test('a closed stream (the server said no) falls back to the 5 s full refresh, once', async () => {
  const h = harness();
  FakeEventSource.last.readyState = 2;
  FakeEventSource.last.emit('error');
  FakeEventSource.last.emit('error');
  assert.equal(h.live.state().fallback, true);
  assert.equal(h.timers.length, 2);
  assert.equal(h.timers[1].ms, 5000);
  h.fire(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.polls.length, 1);
  assert.deepEqual(h.statuses, ['disconnected', 'disconnected (polling)', 'disconnected']);
});

test('no EventSource support goes straight to the fallback', () => {
  const h = harness({ EventSource: null });
  assert.equal(h.live.state().fallback, true);
  assert.deepEqual(h.statuses, ['disconnected (polling)']);
});

test('a constructor that throws goes to the fallback', () => {
  const h = harness({ EventSource: function Boom() { throw new Error('nope'); } });
  assert.equal(h.live.state().fallback, true);
});

test('the transitional timer redraws only while the active tab still depends on it (now only a plugin-owned tab)', async () => {
  const h = harness({ tab: 'pending', isPluginTab: (t) => t === 'myplugin' });
  h.fire(0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.applied, []);
  h.setTab('myplugin');
  h.fire(0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.applied, [plan({ main: true })]);
  h.setTab('plugins');                                   // the Plugins tab has events now: the timer leaves it alone
  h.fire(0);
  await new Promise((r) => setImmediate(r));
  h.setTab('project');
  h.fire(0);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.applied.length, 1);
});

test('a plugin-owned tab uses the transitional timer too', async () => {
  const h = harness({ tab: 'myplugin', isPluginTab: (t) => t === 'myplugin' });
  h.fire(0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.applied, [plan({ main: true })]);
});

test('in fallback the transitional timer stays quiet (the fallback refreshes everything)', async () => {
  const h = harness({ tab: 'hardware' });
  FakeEventSource.last.readyState = 2;
  FakeEventSource.last.emit('error');
  h.fire(0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.applied, []);
});

test('close() stops the stream and both timers and ignores later events', async () => {
  const h = harness({ tab: 'pending' });
  FakeEventSource.last.readyState = 2;
  FakeEventSource.last.emit('error');
  h.live.close();
  assert.equal(FakeEventSource.last.closed, true);
  assert.deepEqual(h.cleared.sort(), [1, 2]);
  assert.equal(h.live.state().closed, true);
  FakeEventSource.last.emit('counts-changed');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.applied, []);
});

test('close() while a plan is being applied drops what was queued behind it', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  const h = harness({ tab: 'pending', apply: async (p) => { seen.push(p); if (seen.length === 1) await gate; } });
  FakeEventSource.last.emit('memory-changed');
  await new Promise((r) => setImmediate(r));
  FakeEventSource.last.emit('counts-changed');
  h.live.close();
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 1);
});

test('close() before any fallback clears just the transitional timer', () => {
  const h = harness();
  h.live.close();
  assert.deepEqual(h.cleared, [1]);
});

test('the page loads live-updates.js before the inline script and the 5 s timer is gone from index.html', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/static/js/live-updates.js') > 0);
  assert.ok(html.indexOf('/static/js/live-updates.js') < html.lastIndexOf('<script>'));
  assert.match(html, /^startPageLiveUpdates\(\);/m);
  assert.doesNotMatch(html, /setInterval\(refresh, 5000\)/);
});

test('the page glue wires the plan keys to the refresh parts, in order', () => {
  const src = fs.readFileSync(path.join(__dirname, 'branches-joblist-hardware-tabs.js'), 'utf8');
  const apply = src.slice(src.indexOf('async function applyLivePlan'), src.indexOf('function startPageLiveUpdates'));
  const order = ['plan.summary', 'plan.plugins', 'plan.nav', 'plan.main', 'plan.branches'].map((k) => apply.indexOf(k));
  assert.ok(order.every((i) => i > 0), 'every plan key is used');
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(src, /apply: \(plan\) => runRefreshGuarded\(\(\) => applyLivePlan\(plan\)\)/);
});
