'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// plugins-manifest.js freezes PLUGINS_MANIFEST_PATH into a module-level const at require
// time (reads AGENT_MANAGER_PLUGINS_MANIFEST once), so a test that changes the env var
// must clear BOTH modules' require-cache entries and re-require resolve-plugin-root.js
// fresh, or it silently sees the path from whichever env was set when this file's very
// first require ran.
function freshResolvePluginRoot() {
  delete require.cache[require.resolve('./plugins-manifest.js')];
  delete require.cache[require.resolve('./resolve-plugin-root.js')];
  return require('./resolve-plugin-root.js').resolvePluginRoot;
}

function withManifestFile(manifest, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-plugin-root-'));
  const manifestPath = path.join(dir, 'plugins.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const prev = process.env.AGENT_MANAGER_PLUGINS_MANIFEST;
  process.env.AGENT_MANAGER_PLUGINS_MANIFEST = manifestPath;
  try {
    return fn(freshResolvePluginRoot());
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PLUGINS_MANIFEST; else process.env.AGENT_MANAGER_PLUGINS_MANIFEST = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('./plugins-manifest.js')];
    delete require.cache[require.resolve('./resolve-plugin-root.js')];
  }
}

test('finds a plugin by name regardless of position in the manifest', () => {
  withManifestFile([
    { name: 'agent-manager-hygiene', registerPath: '/plugins/agent-manager-hygiene/register.js', enabled: true },
    { name: 'agent-manager-hub-tasks', registerPath: '/plugins/agent-manager-hub-tasks/register.js', enabled: true },
  ], (resolvePluginRoot) => {
    assert.equal(resolvePluginRoot('agent-manager-hygiene'), '/plugins/agent-manager-hygiene');
    // The whole point of S5a: a SECOND, non-first plugin resolves too -- the old
    // dirname("${AGENT_MANAGER_REGISTER_PATH%%,*}") hack could only ever find entry 0.
    assert.equal(resolvePluginRoot('agent-manager-hub-tasks'), '/plugins/agent-manager-hub-tasks');
  });
});

test('returns null for a plugin not in the manifest', () => {
  withManifestFile([{ name: 'agent-manager-hygiene', registerPath: '/plugins/agent-manager-hygiene/register.js', enabled: true }], (resolvePluginRoot) => {
    assert.equal(resolvePluginRoot('agent-manager-doesnt-exist'), null);
  });
});

test('returns null for a disabled plugin, even if named correctly', () => {
  withManifestFile([{ name: 'agent-manager-hygiene', registerPath: '/plugins/agent-manager-hygiene/register.js', enabled: false }], (resolvePluginRoot) => {
    assert.equal(resolvePluginRoot('agent-manager-hygiene'), null);
  });
});

test('returns null for an entry missing registerPath (e.g. a server-slotted plugin)', () => {
  withManifestFile([{ name: 'agent-manager-hardware-plugin', slot: 'hardware-tab', enabled: true }], (resolvePluginRoot) => {
    assert.equal(resolvePluginRoot('agent-manager-hardware-plugin'), null);
  });
});

test('falls back to AGENT_MANAGER_REGISTER_PATH by substring match when no manifest file exists', () => {
  const prevManifest = process.env.AGENT_MANAGER_PLUGINS_MANIFEST;
  const prevRegisterPath = process.env.AGENT_MANAGER_REGISTER_PATH;
  process.env.AGENT_MANAGER_PLUGINS_MANIFEST = '/tmp/definitely-does-not-exist-plugins.json';
  process.env.AGENT_MANAGER_REGISTER_PATH = '/plugins/agent-manager-hygiene/register.js,/plugins/agent-manager-hub-tasks/register.js';
  delete require.cache[require.resolve('./plugins-manifest.js')];
  delete require.cache[require.resolve('./resolve-plugin-root.js')];
  const { resolvePluginRoot } = require('./resolve-plugin-root.js');
  try {
    assert.equal(resolvePluginRoot('agent-manager-hygiene'), '/plugins/agent-manager-hygiene');
    // The second, non-first entry -- the exact case the old hack got wrong.
    assert.equal(resolvePluginRoot('agent-manager-hub-tasks'), '/plugins/agent-manager-hub-tasks');
    assert.equal(resolvePluginRoot('agent-manager-doesnt-exist'), null);
  } finally {
    if (prevManifest === undefined) delete process.env.AGENT_MANAGER_PLUGINS_MANIFEST; else process.env.AGENT_MANAGER_PLUGINS_MANIFEST = prevManifest;
    if (prevRegisterPath === undefined) delete process.env.AGENT_MANAGER_REGISTER_PATH; else process.env.AGENT_MANAGER_REGISTER_PATH = prevRegisterPath;
    delete require.cache[require.resolve('./plugins-manifest.js')];
    delete require.cache[require.resolve('./resolve-plugin-root.js')];
  }
});

test('returns null for a falsy plugin name', () => {
  const { resolvePluginRoot } = require('./resolve-plugin-root.js');
  assert.equal(resolvePluginRoot(''), null);
  assert.equal(resolvePluginRoot(undefined), null);
});
