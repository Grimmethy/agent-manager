'use strict';

// Core-owned lazy start for manifest-driven plugin tabs (python/dashboard/static/js/core-ui.js:
// mergePluginTabs() carrying the plugin's process block onto the tab row, and
// ensurePluginTabStarted()/renderPluginTab() POSTing /api/plugins/<name>/ensure-started before the
// plugin's own renderer runs). Found 2026-10-12 when the CharacterForge tab embedded a server nothing
// had started. Same technique as manifest-tab-dispatch.test.js: the real core-ui.js through `vm`, a
// fake document, plus an injected `fetch` stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE_UI_JS = path.join(__dirname, '..', 'python', 'dashboard', 'static', 'js', 'core-ui.js');

function load(fetchImpl) {
  const mainEl = { innerHTML: '', querySelector: () => null };
  const calls = [];
  const sandbox = {
    CORE_TABS: [], console,
    document: { getElementById: (id) => (id === 'main' ? mainEl : null), createElement: () => ({}), head: { appendChild: () => {} } },
    fetch: (url, opts) => { calls.push([url, opts && opts.method]); return fetchImpl(url, opts); },
  };
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(CORE_UI_JS, 'utf8'), { filename: CORE_UI_JS }).runInContext(sandbox);
  return { sandbox, mainEl, calls };
}

const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });
const tabRow = (extra = {}) => ({ key: 'forge', label: 'Forge', pluginName: 'forge-plugin', pluginScript: 'ui/forge.js',
  startCommand: '/venv/bin/python server/app.py', processLog: '~/.local/state/agent-manager/logs/plugin-forge-plugin.log', ...extra });

// A tab whose script is already loaded: register a renderer so renderPluginTab goes straight to it.
function withRenderer(sandbox, mainEl) {
  const order = [];
  sandbox.registerPluginTabRenderer('forge', () => { order.push('render'); mainEl.innerHTML = '<iframe></iframe>'; });
  return order;
}

test('mergePluginTabs: startCommand and processLog only for a plugin whose entry has a process block', () => {
  const { sandbox } = load(ok({}));
  const tabs = sandbox.mergePluginTabs([
    { name: 'with-proc', enabled: true, tab: { key: 'a', label: 'A', kind: 'script', script: 'ui/a.js' }, process: { command: '/venv/bin/python', args: ['server/app.py'] } },
    { name: 'no-proc', enabled: true, tab: { key: 'b', label: 'B', kind: 'script', script: 'ui/b.js' } },
  ]);
  const a = tabs.find((t) => t.key === 'a'), b = tabs.find((t) => t.key === 'b');
  assert.equal(a.startCommand, '/venv/bin/python server/app.py');
  assert.equal(a.processLog, '~/.local/state/agent-manager/logs/plugin-with-proc.log');
  assert.equal('startCommand' in b, false);
  assert.equal('processLog' in b, false);
});

test('renderPluginTab: POSTs ensure-started once, before the plugin renderer runs', async () => {
  const { sandbox, mainEl, calls } = load(ok({ healthy: true }));
  const order = withRenderer(sandbox, mainEl);
  const realFetch = sandbox.fetch;
  sandbox.fetch = (u, o) => { order.push('post'); return realFetch(u, o); };
  await sandbox.renderPluginTab(tabRow());
  assert.deepEqual(calls, [['/api/plugins/forge-plugin/ensure-started', 'POST']]);
  assert.deepEqual(order, ['post', 'render']);
});

test('renderPluginTab: a tab without a process block makes no POST', async () => {
  const { sandbox, mainEl, calls } = load(ok({ healthy: true }));
  const order = withRenderer(sandbox, mainEl);
  await sandbox.renderPluginTab(tabRow({ startCommand: undefined, processLog: undefined }));
  assert.deepEqual(calls, []);
  assert.deepEqual(order, ['render']);
});

for (const [name, impl, wanted] of [
  ['healthy:false', ok({ healthy: false }), /did not report healthy/],
  ['a non-2xx response', async () => ({ ok: false, status: 404, json: async () => ({ description: "no plugin named 'forge-plugin'" }) }), /no plugin named/],
  ['a rejected fetch', async () => { throw new Error('network down'); }, /network down/],
]) {
  test(`renderPluginTab: ${name} shows the error panel with the command and log, skips the renderer, and retries next render`, async () => {
    const { sandbox, mainEl, calls } = load(impl);
    const order = withRenderer(sandbox, mainEl);
    await sandbox.renderPluginTab(tabRow());
    assert.deepEqual(order, []);
    assert.match(mainEl.innerHTML, wanted);
    assert.match(mainEl.innerHTML, /data-plugin-start-error/);
    assert.match(mainEl.innerHTML, /\/venv\/bin\/python server\/app\.py/);
    assert.match(mainEl.innerHTML, /plugin-forge-plugin\.log/);
    await sandbox.renderPluginTab(tabRow());
    assert.equal(calls.length, 2);
  });
}

test('renderPluginTab: after a healthy start a repeat render makes no second POST', async () => {
  const { sandbox, mainEl, calls } = load(ok({ healthy: true }));
  const order = withRenderer(sandbox, mainEl);
  await sandbox.renderPluginTab(tabRow());
  await sandbox.renderPluginTab(tabRow());
  assert.equal(calls.length, 1);
  assert.deepEqual(order, ['render', 'render']);
});

test('renderPluginTab: two overlapping renders during one pending start make a single POST', async () => {
  let release;
  const { sandbox, mainEl, calls } = load(() => new Promise((res) => { release = () => res({ ok: true, status: 200, json: async () => ({ healthy: true }) }); }));
  const order = withRenderer(sandbox, mainEl);
  const first = sandbox.renderPluginTab(tabRow());
  const second = sandbox.renderPluginTab(tabRow());
  await second;                       // the overlapping call returns immediately without rendering
  assert.deepEqual(order, []);
  release();
  await first;
  assert.equal(calls.length, 1);
  assert.deepEqual(order, ['render']);
});
