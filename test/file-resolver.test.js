'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const FileResolver = require('../src/lib/file-resolver.js');

test('FileResolver resolves a single match to exact path', () => {
  const tmpDir = fs.mkdtempSync('/tmp/file-resolver-test-');
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'config.ts'), 'export const config = {};');

  try {
    const result = FileResolver.resolve('config.ts', tmpDir);
    assert.ok(result.exact, 'Should have exact match');
    assert.equal(result.exact, path.join(srcDir, 'config.ts'));
    assert.equal(result.candidates, undefined, 'Should not have candidates for single match');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FileResolver returns candidates when multiple matches exist', () => {
  const tmpDir = fs.mkdtempSync('/tmp/file-resolver-test-');
  const srcDir = path.join(tmpDir, 'src');
  const libDir = path.join(tmpDir, 'lib');
  fs.mkdirSync(srcDir);
  fs.mkdirSync(libDir);
  fs.writeFileSync(path.join(srcDir, 'utils.ts'), 'export const utils = {};');
  fs.writeFileSync(path.join(libDir, 'utils.ts'), 'export const utils = {};');

  try {
    const result = FileResolver.resolve('utils.ts', tmpDir);
    assert.equal(result.exact, undefined, 'Should not have exact match for multiple candidates');
    assert.ok(result.candidates, 'Should have candidates array');
    assert.equal(result.candidates.length, 2, 'Should have 2 candidates');
    // Candidates should be sorted by path
    assert.ok(result.candidates[0].includes('lib'));
    assert.ok(result.candidates[1].includes('src'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FileResolver returns empty object when no match found', () => {
  const tmpDir = fs.mkdtempSync('/tmp/file-resolver-test-');

  try {
    const result = FileResolver.resolve('nonexistent.ts', tmpDir);
    assert.deepEqual(result, {}, 'Should return empty object for nonexistent file');
    assert.equal(result.exact, undefined);
    assert.equal(result.candidates, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FileResolver is case-insensitive', () => {
  const tmpDir = fs.mkdtempSync('/tmp/file-resolver-test-');
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'Config.ts'), 'export const config = {};');

  try {
    const result = FileResolver.resolve('config.ts', tmpDir);
    assert.ok(result.exact, 'Should find case-insensitive match');
    assert.equal(result.exact, path.join(srcDir, 'Config.ts'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FileResolver handles invalid inputs gracefully', () => {
  const tmpDir = fs.mkdtempSync('/tmp/file-resolver-test-');

  try {
    const result1 = FileResolver.resolve('', tmpDir);
    assert.deepEqual(result1, {}, 'Empty filename should return empty object');

    const result2 = FileResolver.resolve('test.ts', '');
    assert.deepEqual(result2, {}, 'Empty repoRoot should return empty object');

    const result3 = FileResolver.resolve(null, tmpDir);
    assert.deepEqual(result3, {}, 'Null filename should return empty object');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FileResolver skips hidden directories and node_modules', () => {
  const tmpDir = fs.mkdtempSync('/tmp/file-resolver-test-');
  const hiddenDir = path.join(tmpDir, '.hidden');
  const nodeModulesDir = path.join(tmpDir, 'node_modules');
  fs.mkdirSync(hiddenDir);
  fs.mkdirSync(nodeModulesDir);
  fs.writeFileSync(path.join(hiddenDir, 'utils.ts'), '// hidden');
  fs.writeFileSync(path.join(nodeModulesDir, 'utils.ts'), '// node_modules');

  try {
    const result = FileResolver.resolve('utils.ts', tmpDir);
    assert.equal(result.exact, undefined, 'Should not find files in hidden dirs or node_modules');
    assert.equal(result.candidates, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
