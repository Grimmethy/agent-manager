'use strict';

// Piece 3 of the manifest-driven dashboard tab (Docs/hub-tasks-extraction-plan.md section
// 5): mergePluginTabs()/isValidPluginTab() in python/dashboard/static/js/core-ui.js fold a
// plugin's declared `tab` into the nav's TABS array, on top of the hardcoded CORE_TABS row
// set. There is no browser-JS test harness in this repo (the design doc's own finding);
// this loads core-ui.js with Node's real V8 parser via `vm`, the same oracle approach
// scripts/extract-core-ui.js uses, and calls the merge functions directly with a fake
// CORE_TABS -- no DOM needed, since neither function touches one.
//
// mergePluginTabs() both assigns the module-level `TABS` (what renderNav actually reads in
// the browser) and returns the merged array -- the return value is what these tests read,
// since a vm context's top-level `let`/`const` bindings (same as a real <script> tag's)
// aren't visible as sandbox properties from the outside.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE_UI_JS = path.join(__dirname, '..', 'python', 'dashboard', 'static', 'js', 'core-ui.js');

const FAKE_CORE_TABS = [
  { key: 'project', label: '📁 Project' },
  { key: 'plugins', label: '🧩 Plugins' },
  { group: 'Job Status', children: [
    { key: 'pending', label: '⏳ Pending' },
    { key: 'coordinating', label: '🧭 Hub Tasks' },
  ] },
];

function loadSandbox() {
  const source = fs.readFileSync(CORE_UI_JS, 'utf8');
  const sandbox = { CORE_TABS: FAKE_CORE_TABS, console };
  vm.createContext(sandbox);
  // Only the merge functions are under test; other top-level declarations in the file
  // (renderNav, fetchJson, ...) reference DOM/fetch but are never invoked here, so they
  // parse and hoist fine without a DOM.
  new vm.Script(source, { filename: CORE_UI_JS }).runInContext(sandbox);
  return sandbox;
}

// assert.deepEqual/deepStrictEqual compares prototypes too, and plain objects created
// inside a vm.createContext sandbox are a different realm's Object -- so a value born in
// the sandbox never strictly-deep-equals an identical-looking value from this file's own
// realm. Round-tripping through JSON collapses both to this realm's plain objects first.
function sameShape(a, b) {
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}

function scriptTab(overrides) {
  return { key: 'hub-tasks', label: 'Hub Tasks', kind: 'script', script: 'ui/hub-tasks.js', ...overrides };
}

test('isValidPluginTab accepts a well-formed tab', () => {
  const sb = loadSandbox();
  assert.equal(sb.isValidPluginTab(scriptTab()), true);
});

test('isValidPluginTab rejects missing/empty key, label, or script, and a non-script kind', () => {
  const sb = loadSandbox();
  assert.equal(sb.isValidPluginTab(null), false);
  assert.equal(sb.isValidPluginTab(scriptTab({ key: '' })), false);
  assert.equal(sb.isValidPluginTab(scriptTab({ label: '  ' })), false);
  assert.equal(sb.isValidPluginTab(scriptTab({ script: '' })), false);
  assert.equal(sb.isValidPluginTab(scriptTab({ kind: 'iframe' })), false);
});

test('mergePluginTabs is a no-op with no plugins -- result matches CORE_TABS by content', () => {
  const sb = loadSandbox();
  const merged = sb.mergePluginTabs([], true);
  sameShape(merged, FAKE_CORE_TABS);
});

test('mergePluginTabs appends a top-level tab for an enabled plugin with a valid tab', () => {
  const sb = loadSandbox();
  const merged = sb.mergePluginTabs([{ name: 'hub-tasks-plugin', enabled: true, tab: scriptTab() }], true);
  const added = merged.find((t) => t.key === 'hub-tasks');
  assert.ok(added, 'expected the hub-tasks row to be appended');
  assert.equal(added.label, 'Hub Tasks');
  assert.equal(added.pluginName, 'hub-tasks-plugin');
  assert.equal(added.pluginScript, 'ui/hub-tasks.js');
});

test('mergePluginTabs skips a disabled plugin', () => {
  const sb = loadSandbox();
  const merged = sb.mergePluginTabs([{ name: 'hub-tasks-plugin', enabled: false, tab: scriptTab() }], true);
  assert.equal(merged.find((t) => t.key === 'hub-tasks'), undefined);
});

test('mergePluginTabs skips a plugin with a malformed tab rather than throwing', () => {
  const sb = loadSandbox();
  let merged;
  assert.doesNotThrow(() => {
    merged = sb.mergePluginTabs([{ name: 'broken-plugin', enabled: true, tab: { key: 'x' } }], true);
  });
  sameShape(merged, FAKE_CORE_TABS);
});

test('mergePluginTabs honours the kill switch: manifestTabsEnabled === false drops every plugin tab', () => {
  const sb = loadSandbox();
  const merged = sb.mergePluginTabs([{ name: 'hub-tasks-plugin', enabled: true, tab: scriptTab() }], false);
  sameShape(merged, FAKE_CORE_TABS);
});

test('mergePluginTabs replaces a top-level core tab when tab.replaces matches its key', () => {
  const sb = loadSandbox();
  const merged = sb.mergePluginTabs([{ name: 'hub-tasks-plugin', enabled: true, tab: scriptTab({ replaces: 'plugins' }) }], true);
  assert.equal(merged.length, FAKE_CORE_TABS.length);
  assert.equal(merged.find((t) => t.key === 'plugins'), undefined);
  const replaced = merged.find((t) => t.key === 'hub-tasks');
  assert.ok(replaced);
});

test('mergePluginTabs replaces a grouped core tab (e.g. the coordinating/Hub Tasks row) in place', () => {
  const sb = loadSandbox();
  const merged = sb.mergePluginTabs([{ name: 'hub-tasks-plugin', enabled: true, tab: scriptTab({ replaces: 'coordinating' }) }], true);
  const jobStatus = merged.find((t) => t.group === 'Job Status');
  assert.equal(jobStatus.children.length, 2);
  const replaced = jobStatus.children.find((c) => c.key === 'hub-tasks');
  assert.ok(replaced, 'expected the coordinating slot to now hold the plugin row');
  assert.equal(jobStatus.children.find((c) => c.key === 'coordinating'), undefined);
});

test('mergePluginTabs groups a new tab under an existing group name instead of duplicating the group header', () => {
  const sb = loadSandbox();
  const merged = sb.mergePluginTabs([{ name: 'p', enabled: true, tab: scriptTab({ group: 'Job Status' }) }], true);
  const groups = merged.filter((t) => t.group === 'Job Status');
  assert.equal(groups.length, 1);
  assert.ok(groups[0].children.some((c) => c.key === 'hub-tasks'));
});

test('mergePluginTabs creates a new group when tab.group names one that does not exist yet', () => {
  const sb = loadSandbox();
  const merged = sb.mergePluginTabs([{ name: 'p', enabled: true, tab: scriptTab({ group: 'Plugin Extras' }) }], true);
  const group = merged.find((t) => t.group === 'Plugin Extras');
  assert.ok(group);
  assert.equal(group.children[0].key, 'hub-tasks');
});

test('mergePluginTabs never mutates CORE_TABS itself', () => {
  const sb = loadSandbox();
  sb.mergePluginTabs([{ name: 'hub-tasks-plugin', enabled: true, tab: scriptTab({ replaces: 'coordinating' }) }], true);
  const jobStatus = FAKE_CORE_TABS.find((t) => t.group === 'Job Status');
  assert.ok(jobStatus.children.some((c) => c.key === 'coordinating'), 'CORE_TABS must be untouched');
});

test('mergePluginTabs rebuilds from CORE_TABS on each call, so a removed plugin drops back out', () => {
  const sb = loadSandbox();
  const withPlugin = sb.mergePluginTabs([{ name: 'hub-tasks-plugin', enabled: true, tab: scriptTab() }], true);
  assert.ok(withPlugin.find((t) => t.key === 'hub-tasks'));
  const withoutPlugin = sb.mergePluginTabs([], true);
  assert.equal(withoutPlugin.find((t) => t.key === 'hub-tasks'), undefined);
});
