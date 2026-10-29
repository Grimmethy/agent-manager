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
  process.env.AGENT_MANAGER_CORE_REPO_ROOT = repoRoot;
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
  process.env.AGENT_MANAGER_CORE_REPO_ROOT = repoRoot;
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

test('resolveAccessibleRoots: a NON-core project never gets agent-manager plugin repos in its grounding', () => {
  const coreRepo = makeRepoDir();
  const otherProject = makeRepoDir();
  const pluginRepo = makeRepoDir();
  process.env.AGENT_MANAGER_CORE_REPO_ROOT = coreRepo;
  const manifestPath = tmpManifest(JSON.stringify([
    { name: 'hygiene', registerPath: path.join(pluginRepo, 'register.js'), enabled: true },
  ]));
  const { resolveAccessibleRoots } = loadWith(manifestPath);
  assert.deepEqual(resolveAccessibleRoots({ repoRoot: otherProject }), [fs.realpathSync(otherProject)]);
  assert.deepEqual(resolveAccessibleRoots({ repoRoot: coreRepo }), [fs.realpathSync(coreRepo), fs.realpathSync(pluginRepo)]);
});

// --- read-only sibling roots for the implement pass (2026-10-16) ---------------------------------------------------------------------------------
test('resolveReadOnlySiblingRoots: plugin repos only -- never the worktree, the live checkout, the core root or the apply clone', () => {
  const coreRepo = makeRepoDir();
  process.env.AGENT_MANAGER_CORE_REPO_ROOT = coreRepo;
  const sibling = makeRepoDir();
  const worktree = makeRepoDir();
  const applyClone = makeRepoDir();
  const manifestPath = tmpManifest(JSON.stringify([
    { name: 'sib', registerPath: path.join(sibling, 'register.js'), enabled: true },
    { name: 'wt', registerPath: path.join(worktree, 'register.js'), enabled: true },
    { name: 'apply', registerPath: path.join(applyClone, 'register.js'), enabled: true },
    { name: 'off', registerPath: path.join(makeRepoDir(), 'register.js'), enabled: false },
  ]));
  const { resolveReadOnlySiblingRoots } = loadWith(manifestPath);
  const roots = resolveReadOnlySiblingRoots({ repoRoot: coreRepo, worktreeDir: worktree, applyRepoRoot: applyClone });
  assert.deepEqual(roots, [fs.realpathSync(sibling)]);
});

test('resolveReadOnlySiblingRoots: a non-core active project gets no siblings, and a missing manifest is []', () => {
  const coreRepo = makeRepoDir();
  process.env.AGENT_MANAGER_CORE_REPO_ROOT = coreRepo;
  const other = makeRepoDir();
  const sibling = makeRepoDir();
  const withManifest = loadWith(tmpManifest(JSON.stringify([{ name: 's', registerPath: path.join(sibling, 'register.js'), enabled: true }])));
  assert.deepEqual(withManifest.resolveReadOnlySiblingRoots({ repoRoot: other, worktreeDir: makeRepoDir() }), []);
  const noManifest = loadWith(path.join(os.tmpdir(), 'definitely-missing-' + Date.now(), 'plugins.json'));
  assert.deepEqual(noManifest.resolveReadOnlySiblingRoots({ repoRoot: coreRepo, worktreeDir: makeRepoDir() }), []);
});

test('isSecretLookingPath: credential-looking names and .ssh/.gnupg paths, but not ordinary source', () => {
  const { isSecretLookingPath } = loadWith(path.join(os.tmpdir(), 'definitely-missing-' + Date.now(), 'plugins.json'));
  for (const p of ['.env', 'a/b/.env.local', 'pf-db.env', 'server.pem', 'k/private.key', 'id_rsa', 'id_ed25519.pub', 'config/credentials.json', 'my-secret.txt', 'api_token.json', 'home/.ssh/config', 'x/.gnupg/pubring.kbx']) {
    assert.equal(isSecretLookingPath(p), true, p);
  }
  for (const p of ['server/core/gpu.py', 'web/app.js', 'README.md', 'env.js', 'src/environment.js', 'lexer.py']) {
    assert.equal(isSecretLookingPath(p), false, p);
  }
});
