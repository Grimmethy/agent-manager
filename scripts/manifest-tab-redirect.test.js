'use strict';

// Piece 5 of the manifest-driven dashboard tab (Docs/hub-tasks-extraction-plan.md section
// 5): the enable/disable lifecycle's active-tab redirect in python/dashboard/static/js/
// core-ui.js. switchToTab() is the shared transition renderTabButton's onclick handlers
// use (extracted here so the redirect can reuse the real leave/enter semantics instead of
// just reassigning activeTab); redirectFromGoneActiveTab() fires it when the currently
// active tab is a plugin-declared one whose plugin just got disabled/removed.
//
// switchToTab calls leave*Tab/enter*Tab/renderMain, which live in OTHER static/js files,
// not core-ui.js -- this sandbox stubs them as spies, same as CORE_TABS is stubbed in the
// other manifest-tab-*.test.js files. They're only referenced inside function bodies
// (deferred), so core-ui.js's own top-level execution doesn't need them to exist either.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE_UI_JS = path.join(__dirname, '..', 'python', 'dashboard', 'static', 'js', 'core-ui.js');

function spy() {
  const fn = (...args) => { fn.calls.push(args); };
  fn.calls = [];
  return fn;
}

function loadSandbox({ activeTab = 'project', coreTabs } = {}) {
  const source = fs.readFileSync(CORE_UI_JS, 'utf8');
  const sandbox = {
    console,
    CORE_TABS: coreTabs || [
      { key: 'project', label: 'Project' },
      { key: 'plugins', label: 'Plugins' },
      { group: 'Job Status', children: [
        { key: 'pending', label: 'Pending' },
        { key: 'coordinating', label: 'Hub Tasks' },
      ] },
    ],
    activeTab,
    counts: {},
    TAB_COUNT_SEVERITY_THRESHOLDS: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    leaveProjectTab: spy(), enterProjectTab: spy(),
    leaveBrainDumpTab: spy(), enterBrainDumpTab: spy(),
    leaveBranchesTab: spy(), enterBranchesTab: spy(),
    leaveHygieneTab: spy(), enterHygieneTab: spy(),
    renderMain: spy(),
    document: {
      getElementById: () => ({ innerHTML: '', appendChild: () => {} }),
      createElement: () => ({ appendChild: () => {}, style: {}, dataset: {}, set innerHTML(_v) {}, get innerHTML() { return ''; }, set className(_v) {}, set title(_v) {}, onclick: null }),
    },
  };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: CORE_UI_JS }).runInContext(sandbox);
  sandbox.mergePluginTabs([], true); // populate TABS from CORE_TABS, as syncPluginTabs() would
  return sandbox;
}

test('switchToTab to a plain tab updates activeTab, re-renders nav, and calls the generic renderMain', () => {
  const sb = loadSandbox({ activeTab: 'plugins' });
  sb.switchToTab('coordinating');
  assert.equal(sb.activeTab, 'coordinating');
  assert.equal(sb.renderMain.calls.length, 1);
});

test('switchToTab away from project calls leaveProjectTab; switching to project calls enterProjectTab instead of renderMain', () => {
  const sb = loadSandbox({ activeTab: 'project' });
  sb.switchToTab('plugins');
  assert.equal(sb.leaveProjectTab.calls.length, 1);
  assert.equal(sb.renderMain.calls.length, 1);

  sb.switchToTab('project');
  assert.equal(sb.enterProjectTab.calls.length, 1);
  // renderMain must not have been called a second time for the 'project' destination.
  assert.equal(sb.renderMain.calls.length, 1);
});

test('switchToTab is a no-op leave/enter-wise when the key does not actually change tab family', () => {
  const sb = loadSandbox({ activeTab: 'project' });
  sb.switchToTab('project');
  assert.equal(sb.leaveProjectTab.calls.length, 0, 'must not leave-then-immediately-re-enter the same tab');
  assert.equal(sb.enterProjectTab.calls.length, 1);
});

test('redirectFromGoneActiveTab is a no-op when the active tab still exists', () => {
  const sb = loadSandbox({ activeTab: 'coordinating' });
  const redirected = sb.redirectFromGoneActiveTab();
  assert.equal(redirected, false);
  assert.equal(sb.activeTab, 'coordinating');
  assert.equal(sb.renderMain.calls.length, 0);
});

test('redirectFromGoneActiveTab switches to the fallback (default "project") when the plugin tab is gone', () => {
  const sb = loadSandbox({ activeTab: 'hub-tasks' }); // not in CORE_TABS and no plugin merged it in
  const redirected = sb.redirectFromGoneActiveTab();
  assert.equal(redirected, true);
  assert.equal(sb.activeTab, 'project');
  assert.equal(sb.enterProjectTab.calls.length, 1);
});

test('redirectFromGoneActiveTab honours a custom fallback key', () => {
  const sb = loadSandbox({ activeTab: 'hub-tasks' });
  const redirected = sb.redirectFromGoneActiveTab('plugins');
  assert.equal(redirected, true);
  assert.equal(sb.activeTab, 'plugins');
});

test('a plugin tab that replaced a core tab (tab.replaces) is found while the plugin is active, then triggers a redirect once the plugin disables', () => {
  const sb = loadSandbox({ activeTab: 'project' });
  // The plugin is live: mergePluginTabs replaces the 'coordinating' slot with its own key.
  sb.mergePluginTabs([{ name: 'hub-tasks-plugin', enabled: true, tab: { key: 'hub-tasks', label: 'Hub Tasks', kind: 'script', script: 'ui/hub-tasks.js', replaces: 'coordinating' } }], true);
  sb.switchToTab('hub-tasks');
  assert.equal(sb.redirectFromGoneActiveTab(), false, 'the plugin tab is still declared -- no redirect yet');

  // The plugin gets disabled: the next sync rebuilds TABS from CORE_TABS with nothing to
  // replace 'coordinating' any more, so the plugin's key disappears.
  sb.mergePluginTabs([{ name: 'hub-tasks-plugin', enabled: false, tab: { key: 'hub-tasks', label: 'Hub Tasks', kind: 'script', script: 'ui/hub-tasks.js', replaces: 'coordinating' } }], true);
  assert.equal(sb.redirectFromGoneActiveTab(), true);
  assert.equal(sb.activeTab, 'project');
});

test('refresh() (branches-joblist-hardware-tabs.js) syncs plugin tabs and checks the redirect before its own renderNav/renderMain', () => {
  // Same "pin the shape" approach as manifest-tab-dispatch.test.js's renderMain check --
  // refresh() depends on globals from several files across the app, so this asserts the
  // ordering by source inspection rather than trying to run the whole app standalone.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'python', 'dashboard', 'static', 'js', 'branches-joblist-hardware-tabs.js'),
    'utf8',
  );
  const start = source.indexOf('async function refresh()');
  const end = source.indexOf('function escapeAttr', start);
  assert.ok(start !== -1 && end !== -1, 'refresh()/escapeAttr boundary not found');
  const body = source.slice(start, end);
  // Search each needle starting after the previous match, not from 0 -- the surrounding
  // comment prose mentions "redirectFromGoneActiveTab()" too, so a bare indexOf(needle)
  // from the start of body would find that mention instead of the real call.
  const syncIdx = body.indexOf('await syncPluginTabs()');
  const redirectIdx = body.indexOf('if (redirectFromGoneActiveTab()) return;', syncIdx);
  const navIdx = body.indexOf('renderNav()', redirectIdx);
  assert.ok(syncIdx !== -1 && redirectIdx !== -1 && navIdx !== -1);
  assert.ok(syncIdx < redirectIdx && redirectIdx < navIdx, 'expected sync, then redirect check, then renderNav, in that order');
});
