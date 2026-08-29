'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// PLUGINS_MANIFEST_PATH is resolved from AGENT_MANAGER_PLUGINS_MANIFEST at module load, so
// each case points it at a fresh temp file and re-requires the module.
function loadWith(manifestPath) {
  process.env.AGENT_MANAGER_PLUGINS_MANIFEST = manifestPath;
  delete require.cache[require.resolve('./plugins-manifest.js')];
  return require('./plugins-manifest.js');
}

function tmpFile(contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-manifest-')), 'plugins.json');
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
}

test('readPluginsManifest returns null when the file does not exist (env-var fallback signal)', () => {
  const { readPluginsManifest } = loadWith(path.join(os.tmpdir(), 'definitely-missing-' + Date.now(), 'plugins.json'));
  assert.equal(readPluginsManifest(), null);
});

test('readPluginsManifest returns null for malformed JSON', () => {
  const { readPluginsManifest } = loadWith(tmpFile('{ not json'));
  assert.equal(readPluginsManifest(), null);
});

test('readPluginsManifest returns null when the JSON is not an array', () => {
  const { readPluginsManifest } = loadWith(tmpFile('{"plugins": []}'));
  assert.equal(readPluginsManifest(), null);
});

test('readPluginsManifest returns [] for an explicitly empty manifest (means "no plugins", not fallback)', () => {
  const { readPluginsManifest } = loadWith(tmpFile('[]'));
  assert.deepEqual(readPluginsManifest(), []);
});

test('readPluginsManifest round-trips a real manifest array', () => {
  const manifest = [
    { name: 'a', registerPath: '/x/a/register.js', enabled: true },
    { name: 'b', registerPath: '/x/b/register.js', enabled: false },
  ];
  const { readPluginsManifest } = loadWith(tmpFile(JSON.stringify(manifest)));
  assert.deepEqual(readPluginsManifest(), manifest);
});

test('enabledRegisterPaths: keeps entries unless enabled:false, in order, dropping blank paths', () => {
  const { enabledRegisterPaths } = loadWith(tmpFile('[]'));
  const out = enabledRegisterPaths([
    { name: 'keep-default', registerPath: '/p/1/register.js' },            // no enabled -> kept
    { name: 'keep-true', registerPath: '/p/2/register.js', enabled: true },
    { name: 'skip-false', registerPath: '/p/3/register.js', enabled: false },
    { name: 'skip-blank', registerPath: '   ', enabled: true },
    { name: 'skip-nopath', enabled: true },
    null,
  ]);
  assert.deepEqual(out, ['/p/1/register.js', '/p/2/register.js']);
});

test('enabledRegisterPaths([]) and non-array both yield []', () => {
  const { enabledRegisterPaths } = loadWith(tmpFile('[]'));
  assert.deepEqual(enabledRegisterPaths([]), []);
  assert.deepEqual(enabledRegisterPaths(null), []);
  assert.deepEqual(enabledRegisterPaths(undefined), []);
});
