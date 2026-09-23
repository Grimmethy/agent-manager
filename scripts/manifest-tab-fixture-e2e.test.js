'use strict';

// End-to-end proof for the manifest-driven dashboard tab (piece 6 of 6; Docs/
// hub-tasks-extraction-plan.md section 5; documented in docs/PLUGIN_API.md's "Dashboard
// tab" section), using the real fixture plugin at test-fixtures/manifest-tab-example-plugin/
// -- not a hand-written stand-in like manifest-tab-dispatch.test.js's earlier unit tests.
//
// This is the consuming half: it takes the fixture's real ui/example-tab.js source, off
// disk, unmodified, and runs it for real (via vm, the same oracle technique every
// manifest-tab-*.test.js file uses) through core-ui.js's actual renderer dispatch --
// proving the served script, exactly as a browser would execute it, registers and renders
// correctly. python/dashboard/test_manifest_tab_fixture_e2e.py is the serving half: it
// proves core hands back those exact same bytes through the real route, gated correctly on
// enabled/disabled and the kill switch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const CORE_UI_JS = path.join(REPO_ROOT, 'python', 'dashboard', 'static', 'js', 'core-ui.js');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test-fixtures', 'manifest-tab-example-plugin');
const FIXTURE_REGISTER_JS = path.join(FIXTURE_DIR, 'register.js');
const FIXTURE_UI_JS = path.join(FIXTURE_DIR, 'ui', 'example-tab.js');

const FIXTURE_TAB = {
  key: 'example-tab', label: 'Example Tab', pluginName: 'manifest-tab-example-plugin', pluginScript: 'ui/example-tab.js',
};

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
  const coreUiSource = fs.readFileSync(CORE_UI_JS, 'utf8');
  const { doc, mainEl, createdScripts } = makeFakeDocument();
  const sandbox = { CORE_TABS: [], console, document: doc };
  vm.createContext(sandbox);
  new vm.Script(coreUiSource, { filename: CORE_UI_JS }).runInContext(sandbox);
  return { sandbox, mainEl, createdScripts };
}

test('the fixture plugin exists on disk with both halves present', () => {
  assert.ok(fs.existsSync(FIXTURE_REGISTER_JS), `missing ${FIXTURE_REGISTER_JS}`);
  assert.ok(fs.existsSync(FIXTURE_UI_JS), `missing ${FIXTURE_UI_JS}`);
});

test('renderPluginTab loads the URL the real route (piece 2) would serve this fixture at', async () => {
  const { sandbox, createdScripts } = loadSandbox();
  sandbox.renderPluginTab(FIXTURE_TAB); // don't await -- only need the <script> src it requests
  assert.equal(createdScripts.length, 1);
  assert.equal(createdScripts[0].src, '/api/plugins/manifest-tab-example-plugin/ui/example-tab.js');
});

test('end to end: the fixture\'s real, unmodified source -- executed exactly as a browser would run the served <script> -- registers and renders through core-ui.js\'s actual dispatch', async () => {
  const { sandbox, mainEl, createdScripts } = loadSandbox();
  const fixtureSource = fs.readFileSync(FIXTURE_UI_JS, 'utf8');

  const renderPromise = sandbox.renderPluginTab(FIXTURE_TAB);
  const scriptEl = createdScripts[0];
  assert.ok(scriptEl, 'expected renderPluginTab to have requested the fixture script');

  // This is the step a real browser performs implicitly when a <script src="..."> element
  // finishes loading: execute the fetched source in the page's global scope. Running it in
  // the SAME sandbox core-ui.js is loaded into reproduces that -- registerPluginTabRenderer
  // (defined by core-ui.js) is what the fixture's own top-level code calls.
  new vm.Script(fixtureSource, { filename: FIXTURE_UI_JS }).runInContext(sandbox);
  scriptEl.onload();

  await renderPromise;

  assert.match(mainEl.innerHTML, /id="example-plugin-content"/);
  assert.match(mainEl.innerHTML, /Hello from the example plugin/);
});

test('a second visit reuses the already-registered renderer without re-requesting the script', async () => {
  const { sandbox, mainEl, createdScripts } = loadSandbox();
  const fixtureSource = fs.readFileSync(FIXTURE_UI_JS, 'utf8');

  const first = sandbox.renderPluginTab(FIXTURE_TAB);
  new vm.Script(fixtureSource, { filename: FIXTURE_UI_JS }).runInContext(sandbox);
  createdScripts[0].onload();
  await first;
  assert.equal(createdScripts.length, 1);

  mainEl.innerHTML = '';
  await sandbox.renderPluginTab(FIXTURE_TAB);
  assert.equal(createdScripts.length, 1, 'no second <script> element on revisit');
  assert.match(mainEl.innerHTML, /example-plugin-content/);
});
