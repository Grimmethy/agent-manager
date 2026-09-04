'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// PLUGINS_MANIFEST_PATH (plugins-manifest.js) is resolved from AGENT_MANAGER_PLUGINS_MANIFEST
// at module load -- same pattern plugins-manifest.test.js uses: point the env var at a fresh
// temp file and re-require both modules fresh.
function loadWith(manifestPath) {
  process.env.AGENT_MANAGER_PLUGINS_MANIFEST = manifestPath;
  delete require.cache[require.resolve('./plugins-manifest.js')];
  delete require.cache[require.resolve('./accessible-roots.js')];
  return require('./accessible-roots.js');
}

function tmpManifest(contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'accessible-roots-')), 'plugins.json');
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
}

function makeRepoDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'accessible-roots-repo-'));
}

test('resolveAccessibleRoots: no manifest at all -> just [repoRoot]', () => {
  const { resolveAccessibleRoots } = loadWith(path.join(os.tmpdir(), 'definitely-missing-' + Date.now(), 'plugins.json'));
  const repoRoot = makeRepoDir();
  assert.deepEqual(resolveAccessibleRoots({ repoRoot }), [fs.realpathSync(repoRoot)]);
});

test('resolveAccessibleRoots: an enabled plugin repo is included, dirname of its registerPath', () => {
  const repoRoot = makeRepoDir();
  const pluginRepo = makeRepoDir();
  const manifestPath = tmpManifest(JSON.stringify([
    { name: 'a-plugin', registerPath: path.join(pluginRepo, 'register.js'), enabled: true },
  ]));
  const { resolveAccessibleRoots } = loadWith(manifestPath);
  assert.deepEqual(resolveAccessibleRoots({ repoRoot }), [fs.realpathSync(repoRoot), fs.realpathSync(pluginRepo)]);
});

test('resolveAccessibleRoots: a disabled plugin is excluded', () => {
  const repoRoot = makeRepoDir();
  const pluginRepo = makeRepoDir();
  const manifestPath = tmpManifest(JSON.stringify([
    { name: 'off', registerPath: path.join(pluginRepo, 'register.js'), enabled: false },
  ]));
  const { resolveAccessibleRoots } = loadWith(manifestPath);
  assert.deepEqual(resolveAccessibleRoots({ repoRoot }), [fs.realpathSync(repoRoot)]);
});

test('resolveAccessibleRoots: a plugin dir that no longer exists on disk is skipped, not thrown', () => {
  const repoRoot = makeRepoDir();
  const manifestPath = tmpManifest(JSON.stringify([
    { name: 'gone', registerPath: '/definitely/does/not/exist/register.js', enabled: true },
  ]));
  const { resolveAccessibleRoots } = loadWith(manifestPath);
  assert.deepEqual(resolveAccessibleRoots({ repoRoot }), [fs.realpathSync(repoRoot)]);
});

test('resolveAccessibleRoots: dedups when a plugin resolves to the same repo as repoRoot', () => {
  const repoRoot = makeRepoDir();
  const manifestPath = tmpManifest(JSON.stringify([
    { name: 'same', registerPath: path.join(repoRoot, 'register.js'), enabled: true },
  ]));
  const { resolveAccessibleRoots } = loadWith(manifestPath);
  assert.deepEqual(resolveAccessibleRoots({ repoRoot }), [fs.realpathSync(repoRoot)]);
});

test('resolveAccessibleRoots: multiple enabled plugins, in manifest order, root0 always primary', () => {
  const repoRoot = makeRepoDir();
  const p1 = makeRepoDir();
  const p2 = makeRepoDir();
  const manifestPath = tmpManifest(JSON.stringify([
    { name: 'p1', registerPath: path.join(p1, 'register.js'), enabled: true },
    { name: 'p2', registerPath: path.join(p2, 'register.js') }, // no `enabled` key -> kept
  ]));
  const { resolveAccessibleRoots } = loadWith(manifestPath);
  const out = resolveAccessibleRoots({ repoRoot });
  assert.deepEqual(out, [fs.realpathSync(repoRoot), fs.realpathSync(p1), fs.realpathSync(p2)]);
  assert.equal(out[0], fs.realpathSync(repoRoot), 'primary repo is always roots[0]');
});

test('resolveAccessibleRoots: malformed manifest JSON behaves like no manifest -> [repoRoot]', () => {
  const repoRoot = makeRepoDir();
  const manifestPath = tmpManifest('{ not json');
  const { resolveAccessibleRoots } = loadWith(manifestPath);
  assert.deepEqual(resolveAccessibleRoots({ repoRoot }), [fs.realpathSync(repoRoot)]);
});
