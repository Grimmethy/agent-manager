'use strict';

// Unit tests for config.js's resolveGraphPath() -- the fix for a real mismatch confirmed
// live 2026-08-16: the dashboard's own "Build Graph" button writes to
// <repoRoot>/.agent-manager-cache/<grepDirsSlug>/graph.json, but arch_discovery and the
// path-prefetch feature's default graphPath pointed at <repoRoot>/graphify-out/graph.json
// instead -- a location nothing in this package ever actually wrote to. A user who built
// a graph via the dashboard, expecting either consumer to see it, got silence from both.
//
// Run: node --test src/config.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveGraphPath } = require('./config.js');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-resolve-graph-test-'));
}

test('resolveGraphPath prefers .agent-manager-cache/default/graph.json (the common no-grepDirs case)', () => {
  const repoRoot = makeRepo();
  const cachePath = path.join(repoRoot, '.agent-manager-cache', 'default', 'graph.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, '{}');
  assert.equal(resolveGraphPath(repoRoot), cachePath);
});

test('resolveGraphPath falls back to the most recently modified grepDirs-scoped cache entry when "default" is absent', () => {
  const repoRoot = makeRepo();
  const older = path.join(repoRoot, '.agent-manager-cache', 'aaa111', 'graph.json');
  const newer = path.join(repoRoot, '.agent-manager-cache', 'bbb222', 'graph.json');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.mkdirSync(path.dirname(newer), { recursive: true });
  fs.writeFileSync(older, '{}');
  // Force a real, distinguishable mtime gap -- same-millisecond writes on a fast
  // filesystem could otherwise land in either order.
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(older, past, past);
  fs.writeFileSync(newer, '{}');

  assert.equal(resolveGraphPath(repoRoot), newer);
});

test('resolveGraphPath falls back to the legacy graphify-out/graph.json location when no dashboard cache exists at all', () => {
  const repoRoot = makeRepo();
  const legacyPath = path.join(repoRoot, 'graphify-out', 'graph.json');
  assert.equal(resolveGraphPath(repoRoot), legacyPath, 'should return the legacy path even though nothing exists there yet -- callers already handle a missing graph file gracefully');
});

test('resolveGraphPath does not throw when .agent-manager-cache/ exists but is empty', () => {
  const repoRoot = makeRepo();
  fs.mkdirSync(path.join(repoRoot, '.agent-manager-cache'), { recursive: true });
  assert.equal(resolveGraphPath(repoRoot), path.join(repoRoot, 'graphify-out', 'graph.json'));
});
