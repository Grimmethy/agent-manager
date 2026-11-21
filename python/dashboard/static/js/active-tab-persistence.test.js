'use strict';
// Run: node --test python/dashboard/static/js/active-tab-persistence.test.js
// Loads the REAL core-ui.js into a fresh vm context with a stub sessionStorage, the same way
// core-ui.test.js does. Rendering and per-tab enter hooks are stubbed out, since this test only
// cares about the active-tab key and the restore decision.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KEY = 'dashboard.activeTab';

function makeStore() {
  const store = new Map();
  return {
    store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
  };
}

function loadCoreUi(sessionStorage) {
  const ctx = vm.createContext({
    console,
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage,
    document: { getElementById: () => null, createElement: () => ({}) },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    counts: {}, activeTab: 'project', severityForTab: () => '', TAB_COUNT_SEVERITY_THRESHOLDS: {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'core-ui.js'), 'utf8'), ctx, { filename: 'core-ui.js' });
  // Rendering is not under test: replace the DOM-touching functions with no-ops.
  vm.runInContext(
    'renderNav = () => {}; renderMain = async () => {}; enterProjectTab = async () => {};'
    + ' enterBrainDumpTab = async () => {}; enterBranchesTab = async () => {}; enterHygieneTab = async () => {};',
    ctx,
  );
  // TABS is a top-level `let`, so it has to be set inside the script scope.
  vm.runInContext('TABS = [{ key: "project", label: "Project" }, { key: "workers", label: "Workers" }]', ctx);
  return ctx;
}

test('switchToTab writes the new key to sessionStorage', () => {
  const s = makeStore();
  const ctx = loadCoreUi(s);
  ctx.switchToTab('workers');
  assert.equal(ctx.activeTab, 'workers');
  assert.equal(s.store.get(KEY), 'workers');
});

test('restore applies a stored key that resolves via findTabByKey', () => {
  const s = makeStore();
  s.store.set(KEY, 'workers');
  const ctx = loadCoreUi(s);
  assert.equal(ctx.activeTab, 'project');
  vm.runInContext('restoreStoredActiveTabOnce()', ctx);
  assert.equal(ctx.activeTab, 'workers');
});

test('an unknown stored key falls back to project (no switch, activeTab stays project)', () => {
  const s = makeStore();
  s.store.set(KEY, 'plugin-that-was-disabled');
  const ctx = loadCoreUi(s);
  vm.runInContext('restoreStoredActiveTabOnce()', ctx);
  assert.equal(ctx.activeTab, 'project');
});

test('restore runs only once: a later call does not re-apply', () => {
  const s = makeStore();
  s.store.set(KEY, 'workers');
  const ctx = loadCoreUi(s);
  vm.runInContext('restoreStoredActiveTabOnce()', ctx);
  ctx.switchToTab('project');
  vm.runInContext('restoreStoredActiveTabOnce()', ctx);
  assert.equal(ctx.activeTab, 'project');
});

test('storage that throws does not break switchToTab', () => {
  const throwing = {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('quota exceeded'); },
  };
  const ctx = loadCoreUi(throwing);
  assert.doesNotThrow(() => ctx.switchToTab('workers'));
  assert.equal(ctx.activeTab, 'workers');
});

test('storage that throws on read leaves project active on restore', () => {
  const throwing = {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); },
  };
  const ctx = loadCoreUi(throwing);
  assert.doesNotThrow(() => vm.runInContext('restoreStoredActiveTabOnce()', ctx));
  assert.equal(ctx.activeTab, 'project');
});
