'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { resolvePrimaryDirs } = require('../src/grep-codebase-tool.js');

// Fixture root: derived from this file's location (the repo root), not hardcoded.
const root = path.resolve(__dirname, '..');
const allowedDirs = ['src', 'python'];

function assertRejected(dir) {
  const result = resolvePrimaryDirs(root, allowedDirs, dir);
  assert.equal(typeof result.error, 'string', `'${dir}' should return an error string`);
  assert.ok(result.error.length > 0, `'${dir}' error should be non-empty`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'roots'), false, `'${dir}' should have no roots key`);
}

test('resolvePrimaryDirs rejects a traversal that escapes the allowed root', () => {
  const result = resolvePrimaryDirs(root, allowedDirs, 'src/../../etc/passwd');
  assert.equal(typeof result.error, 'string');
  assert.equal(result.roots, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'roots'), false);
});

test('resolvePrimaryDirs rejects a dotdot path that stays inside an allowed dir', () => {
  assertRejected('src/../src/x');
});

test('resolvePrimaryDirs rejects a leading dotdot segment', () => {
  assertRejected('../x');
});

test('resolvePrimaryDirs rejects an absolute path', () => {
  assertRejected('/etc');
});

test('resolvePrimaryDirs accepts a subpath of an allowed dir', () => {
  const result = resolvePrimaryDirs(root, allowedDirs, 'python/dashboard');
  assert.deepStrictEqual(result, { roots: [path.join(root, 'python/dashboard')] });
});

test('resolvePrimaryDirs keeps existing behavior for an exact allowed dir', () => {
  const result = resolvePrimaryDirs(root, allowedDirs, 'src');
  assert.deepStrictEqual(result, { roots: [path.join(root, 'src')] });
});

test('resolvePrimaryDirs keeps existing behavior for "." (all allowed dirs)', () => {
  const result = resolvePrimaryDirs(root, allowedDirs, '.');
  assert.deepStrictEqual(result, {
    roots: [path.join(root, 'src'), path.join(root, 'python')],
  });
});

test('resolvePrimaryDirs keeps existing behavior for "" (all allowed dirs)', () => {
  const result = resolvePrimaryDirs(root, allowedDirs, '');
  assert.deepStrictEqual(result, {
    roots: [path.join(root, 'src'), path.join(root, 'python')],
  });
});
