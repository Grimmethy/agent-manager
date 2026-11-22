'use strict';

// Enforces the plugin import boundary (docs/PLUGIN_API.md "Enforced public surface"):
// plugins import only public agent-manager modules, plus a frozen allowlist that only shrinks.
// Fixture tests run anywhere; the real-repo test skips (with a message) when the sibling plugin
// repos named in plugins.json are not on this machine, or plugins.json is absent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractCoreImports, scanPlugin, pluginDirs, derivePublicModules, compare, checkPluginImports,
} = require('../scripts/check-plugin-imports.js');

const BOUNDARY = require('../scripts/plugin-import-boundary.json');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-boundary-')); }

function writePlugin(root, name, files) {
  const dir = path.join(root, name);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('extractCoreImports: finds agent-manager/src requires only', () => {
  const src = [
    "const a = require('agent-manager/src/config.js');",
    'const b = require("agent-manager/src/lib/task-priority.js");',
    "const c = require('./local.js');",
    "const d = require('fs');",
  ].join('\n');
  assert.deepEqual(extractCoreImports(src), ['config.js', 'lib/task-priority.js']);
});

test('scanPlugin: reports a non-public import, ignores public and relative ones, skips node_modules', () => {
  const root = tmpDir();
  const dir = writePlugin(root, 'demo-plugin', {
    'src/a.js': "require('agent-manager/src/config.js'); require('agent-manager/src/secret-internal.js'); require('./b.js');",
    'src/b.js': "module.exports = 1;",
    'node_modules/x/index.js': "require('agent-manager/src/hidden.js');",
  });
  assert.deepEqual(scanPlugin(dir, ['config.js']), ['demo-plugin:src/a.js:secret-internal.js']);
});

test('compare: a new violation fails, an allowlisted one passes, a fixed one is stale', () => {
  const r = compare(['p:f.js:new.js', 'p:f.js:old.js'], ['p:f.js:old.js', 'p:f.js:fixed.js']);
  assert.deepEqual(r.violations, ['p:f.js:new.js']);
  assert.deepEqual(r.stale, ['p:f.js:fixed.js']);
});

test('pluginDirs: accepts a bare list and {plugins}, skips entries without registerPath', () => {
  const list = [{ name: 'a', registerPath: '/x/a/register.js' }, { name: 'b' }];
  assert.deepEqual(pluginDirs(list), ['/x/a']);
  assert.deepEqual(pluginDirs({ plugins: list }), ['/x/a']);
});

test('derivePublicModules: doc-named src modules plus everything under src/sdk', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'sdk'));
  fs.mkdirSync(path.join(root, 'lib'));
  for (const f of ['config.js', 'lib/helper.js', 'sdk/one.js', 'sdk/one.test.js', 'unmentioned.js']) fs.writeFileSync(path.join(root, f), '');
  const out = derivePublicModules('Use `src/config.js` and lib/helper.js and ghost.js.', root);
  assert.deepEqual(out, ['config.js', 'lib/helper.js', 'sdk/one.js']);
});

test('checkPluginImports: end to end on a fixture, fails on a new violation and passes once allowlisted', () => {
  const root = tmpDir();
  const dir = writePlugin(root, 'fixture-plugin', { 'src/register.js': "require('agent-manager/src/internal-thing.js');" });
  const pluginsJson = path.join(root, 'plugins.json');
  const boundaryJson = path.join(root, 'boundary.json');
  fs.writeFileSync(pluginsJson, JSON.stringify([{ name: 'fixture-plugin', registerPath: path.join(dir, 'register.js') }]));
  fs.writeFileSync(boundaryJson, JSON.stringify({ publicModules: ['config.js'], allowlist: [] }));
  const bad = checkPluginImports({ pluginsJson, boundaryJson });
  assert.deepEqual(bad.violations, ['fixture-plugin:src/register.js:internal-thing.js']);
  fs.writeFileSync(boundaryJson, JSON.stringify({ publicModules: ['config.js'], allowlist: ['fixture-plugin:src/register.js:internal-thing.js'] }));
  const ok = checkPluginImports({ pluginsJson, boundaryJson });
  assert.deepEqual(ok.violations, []);
  assert.deepEqual(ok.stale, []);
});

test('checkPluginImports: skips (not passes silently) when a plugin repo is missing', () => {
  const root = tmpDir();
  const pluginsJson = path.join(root, 'plugins.json');
  const boundaryJson = path.join(root, 'boundary.json');
  fs.writeFileSync(pluginsJson, JSON.stringify([{ name: 'gone', registerPath: path.join(root, 'gone', 'register.js') }]));
  fs.writeFileSync(boundaryJson, JSON.stringify({ publicModules: [], allowlist: [] }));
  const r = checkPluginImports({ pluginsJson, boundaryJson });
  assert.match(r.skipped, /not present/);
});

test('boundary data: every public module exists in src and is named in docs/PLUGIN_API.md or lives under src/sdk', () => {
  const srcDir = path.join(__dirname);
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PLUGIN_API.md'), 'utf8');
  for (const mod of BOUNDARY.publicModules) {
    assert.ok(fs.existsSync(path.join(srcDir, mod)), `public module ${mod} does not exist in src/`);
    assert.ok(mod.startsWith('sdk/') || doc.includes(path.basename(mod)), `public module ${mod} is not named in docs/PLUGIN_API.md`);
  }
});

test('boundary data: allowlist entries are unique, well formed, and never name a public module', () => {
  assert.equal(new Set(BOUNDARY.allowlist).size, BOUNDARY.allowlist.length);
  for (const key of BOUNDARY.allowlist) {
    const [plugin, , mod] = key.split(':');
    assert.ok(plugin && mod, `malformed allowlist key ${key}`);
    assert.ok(!BOUNDARY.publicModules.includes(mod), `${key} is public now: drop it from the allowlist`);
  }
});

test('real plugin repos: no new violations, and no stale allowlist entries (skips when repos are absent)', (t) => {
  const r = checkPluginImports();
  if (r.skipped) { t.skip(r.skipped); return; }
  assert.deepEqual(r.violations, [], `new non-public plugin imports -- promote the module into the SDK or move the code into the plugin:\n  ${r.violations.join('\n  ')}`);
  assert.deepEqual(r.stale, [], `allowlist entries that no longer occur -- run: node scripts/check-plugin-imports.js --shrink\n  ${r.stale.join('\n  ')}`);
});
