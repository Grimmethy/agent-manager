'use strict';

// Piece 4 of the manifest-driven dashboard tab (Docs/hub-tasks-extraction-plan.md section
// 5): the renderer registry, script loader, and dispatch in python/dashboard/static/js/
// core-ui.js. The plan calls this piece "the riskiest: it touches the paths every tab
// uses" -- these tests exercise the actual failure modes that matter: a plugin script that
// 404s, one that loads but never registers a renderer, and one that registers and renders
// successfully, all asserting the failure is contained to #main and never thrown.
//
// Same technique as manifest-tab-merge.test.js: load core-ui.js for real via `vm` (the
// real V8 parser), with a minimal fake `document` standing in for the DOM (createElement/
// head.appendChild/getElementById('main') are all loadPluginTabScript/renderPluginTab
// actually touch).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE_UI_JS = path.join(__dirname, '..', 'python', 'dashboard', 'static', 'js', 'core-ui.js');

function makeFakeDocument() {
  const mainEl = { innerHTML: '' };
  const createdScripts = [];
  const doc = {
    getElementById: (id) => (id === 'main' ? mainEl : null),
    createElement: (tag) => {
      const el = { tagName: tag, src: '', onload: null, onerror: null };
      if (tag === 'script') createdScripts.push(el);
      return el;
    },
    head: { appendChild: () => {} },
  };
  return { doc, mainEl, createdScripts };
}

function loadSandbox() {
  const source = fs.readFileSync(CORE_UI_JS, 'utf8');
  const { doc, mainEl, createdScripts } = makeFakeDocument();
  const sandbox = { CORE_TABS: [], console, document: doc };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: CORE_UI_JS }).runInContext(sandbox);
  return { sandbox, mainEl, createdScripts };
}

function pluginTab(overrides) {
  return { key: 'hub-tasks', label: 'Hub Tasks', pluginName: 'hub-tasks-plugin', pluginScript: 'ui/hub-tasks.js', ...overrides };
}

test('pluginTabAssetUrl strips the tab.script leading ui/ and encodes both segments', () => {
  const { sandbox } = loadSandbox();
  assert.equal(
    sandbox.pluginTabAssetUrl(pluginTab()),
    '/api/plugins/hub-tasks-plugin/ui/hub-tasks.js',
  );
  assert.equal(
    sandbox.pluginTabAssetUrl(pluginTab({ pluginName: 'weird name/x', pluginScript: 'ui/sub dir/file.js' })),
    '/api/plugins/weird%20name%2Fx/ui/sub%20dir/file.js',
  );
});

test('findTabByKey finds a top-level row and a row nested inside a group', () => {
  const { sandbox } = loadSandbox();
  sandbox.mergePluginTabs([{ name: 'hub-tasks-plugin', enabled: true, tab: { key: 'hub-tasks', label: 'Hub Tasks', kind: 'script', script: 'ui/hub-tasks.js', group: 'Job Status' } }], true);
  const found = sandbox.findTabByKey('hub-tasks');
  assert.ok(found);
  assert.equal(found.pluginName, 'hub-tasks-plugin');
  assert.equal(sandbox.findTabByKey('does-not-exist'), null);
});

test('registerPluginTabRenderer ignores a non-function and a missing key rather than throwing', () => {
  const { sandbox } = loadSandbox();
  assert.doesNotThrow(() => sandbox.registerPluginTabRenderer('x', 'not a function'));
  assert.doesNotThrow(() => sandbox.registerPluginTabRenderer('', () => {}));
});

test('renderPluginTab: successful load calls the registered renderer and leaves #main to it', async () => {
  const { sandbox, mainEl, createdScripts } = loadSandbox();
  const tab = pluginTab();
  let rendered = false;
  const renderPromise = sandbox.renderPluginTab(tab);
  // loadPluginTabScript injected a <script> element synchronously; simulate it loading and
  // registering its renderer, the way a real plugin script would at its own top level.
  assert.equal(createdScripts.length, 1);
  assert.equal(createdScripts[0].src, '/api/plugins/hub-tasks-plugin/ui/hub-tasks.js');
  sandbox.registerPluginTabRenderer('hub-tasks', () => {
    rendered = true;
    mainEl.innerHTML = '<div>real hub tasks content</div>';
  });
  createdScripts[0].onload();
  await renderPromise;
  assert.equal(rendered, true);
  assert.match(mainEl.innerHTML, /real hub tasks content/);
});

test('renderPluginTab: a 404/script error is shown as a #main error panel, not thrown', async () => {
  const { sandbox, mainEl, createdScripts } = loadSandbox();
  const tab = pluginTab();
  const renderPromise = sandbox.renderPluginTab(tab);
  createdScripts[0].onerror();
  await assert.doesNotReject(renderPromise);
  assert.match(mainEl.innerHTML, /Could not load the "Hub Tasks" tab/);
  assert.match(mainEl.innerHTML, /hub-tasks-plugin/);
});

test('renderPluginTab: a script that loads but never registers a renderer is a contained error, not a hang', async () => {
  const { sandbox, mainEl, createdScripts } = loadSandbox();
  const tab = pluginTab();
  const renderPromise = sandbox.renderPluginTab(tab);
  createdScripts[0].onload(); // "loads" but calls registerPluginTabRenderer for nothing
  await assert.doesNotReject(renderPromise);
  assert.match(mainEl.innerHTML, /never called registerPluginTabRenderer/);
});

test('renderPluginTab: a renderer that throws mid-render is caught and shown, not propagated', async () => {
  const { sandbox, mainEl, createdScripts } = loadSandbox();
  const tab = pluginTab();
  const renderPromise = sandbox.renderPluginTab(tab);
  sandbox.registerPluginTabRenderer('hub-tasks', () => { throw new Error('boom'); });
  createdScripts[0].onload();
  await assert.doesNotReject(renderPromise);
  assert.match(mainEl.innerHTML, /boom/);
});

test('renderPluginTab: a second visit after a successful load reuses the cached script (no second <script> tag) and re-renders', async () => {
  const { sandbox, mainEl, createdScripts } = loadSandbox();
  const tab = pluginTab();
  const first = sandbox.renderPluginTab(tab);
  sandbox.registerPluginTabRenderer('hub-tasks', () => { mainEl.innerHTML = 'v1'; });
  createdScripts[0].onload();
  await first;
  assert.equal(createdScripts.length, 1);

  sandbox.registerPluginTabRenderer('hub-tasks', () => { mainEl.innerHTML = 'v2'; });
  await sandbox.renderPluginTab(tab);
  assert.equal(createdScripts.length, 1, 'no new <script> element on the second visit');
  assert.equal(mainEl.innerHTML, 'v2');
});

test('renderPluginTab: a failed load is not cached, so the next visit retries with a fresh <script> tag', async () => {
  const { sandbox, mainEl, createdScripts } = loadSandbox();
  const tab = pluginTab();
  const first = sandbox.renderPluginTab(tab);
  createdScripts[0].onerror();
  await first;
  assert.match(mainEl.innerHTML, /Could not load/);

  const second = sandbox.renderPluginTab(tab);
  assert.equal(createdScripts.length, 2, 'expected a fresh <script> element on retry');
  sandbox.registerPluginTabRenderer('hub-tasks', () => { mainEl.innerHTML = 'recovered'; });
  createdScripts[1].onload();
  await second;
  assert.equal(mainEl.innerHTML, 'recovered');
});

test('renderMain dispatches a plugin-tab activeTab through renderPluginTab instead of renderQueueTab', async () => {
  // branches-joblist-hardware-tabs.js (renderMain's home) depends on globals core-ui.js
  // defines (TABS, findTabByKey, renderPluginTab, etc.) plus a few more of its own file's
  // neighbours; loading it standalone would need the whole app. Instead this pins the
  // actual dispatch line's shape so a future edit can't silently drop the plugin-tab check
  // back to always falling through to renderQueueTab.
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, '..', 'python', 'dashboard', 'static', 'js', 'branches-joblist-hardware-tabs.js'),
    'utf8',
  );
  const fnMatch = dispatchSource.match(/async function renderMain\(\)[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'renderMain() not found');
  const body = fnMatch[0];
  assert.match(body, /findTabByKey\(activeTab\)/);
  assert.match(body, /pluginTab\.pluginScript/);
  assert.match(body, /renderPluginTab\(pluginTab\)/);
  assert.match(body, /renderQueueTab\(activeTab\)/);
});
