'use strict';

// Two-strike rule for redirectFromGoneActiveTab() in python/dashboard/static/js/core-ui.js.
// A single miss must not redirect; the 2nd consecutive miss does. A present plugin tab (a hit)
// resets the counter. core-ui.js is loaded into a vm context; switchToTab is replaced with a
// recorder because its real body calls renderNav/renderMain/enter*Tab from other static files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE_UI_JS = path.join(__dirname, '..', 'python', 'dashboard', 'static', 'js', 'core-ui.js');

function pluginEntry(enabled) {
  return {
    name: 'debounce-plugin',
    enabled,
    tab: { key: 'plugin-x', label: 'Plugin X', kind: 'script', script: 'ui/x.js' },
  };
}

function loadSandbox({ activeTab }) {
  const source = fs.readFileSync(CORE_UI_JS, 'utf8');
  const sandbox = {
    console,
    CORE_TABS: [
      { key: 'project', label: 'Project' },
      { key: 'plugins', label: 'Plugins' },
    ],
    activeTab,
    counts: {},
    TAB_COUNT_SEVERITY_THRESHOLDS: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      getElementById: () => null,
      createElement: () => ({ appendChild: () => {}, style: {}, dataset: {} }),
      head: { appendChild: () => {} },
    },
    __switches: [],
  };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: CORE_UI_JS }).runInContext(sandbox);
  // Function declarations are plain globals in a classic script, so reassigning switchToTab here
  // is what redirectFromGoneActiveTab's own switchToTab(...) call resolves to.
  vm.runInContext('switchToTab = function (key) { __switches.push(key); };', sandbox);
  sandbox.mergePluginTabs([], true); // populate TABS from CORE_TABS only
  return sandbox;
}

test('first miss does not redirect; the second consecutive miss redirects to project', () => {
  const sb = loadSandbox({ activeTab: 'plugin-x' }); // plugin-x never merged -> absent
  assert.equal(sb.redirectFromGoneActiveTab(), false);
  assert.deepEqual(sb.__switches, []);
  assert.equal(sb.redirectFromGoneActiveTab(), true);
  assert.deepEqual(sb.__switches, ['project']);
});

test('a present plugin hit resets the counter, so a later single miss does not redirect', () => {
  const sb = loadSandbox({ activeTab: 'plugin-x' });
  assert.equal(sb.redirectFromGoneActiveTab(), false); // miss 1
  sb.mergePluginTabs([pluginEntry(true)], true);       // plugin present again
  assert.equal(sb.redirectFromGoneActiveTab(), false); // hit -> counter reset
  sb.mergePluginTabs([], true);                        // plugin gone again
  assert.equal(sb.redirectFromGoneActiveTab(), false); // miss 1 after reset
  assert.deepEqual(sb.__switches, []);
  assert.equal(sb.redirectFromGoneActiveTab(), true);  // miss 2 -> redirect
  assert.deepEqual(sb.__switches, ['project']);
});
