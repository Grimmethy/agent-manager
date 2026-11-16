'use strict';

// Tests for src/node-loaded-sha.js
//
// Coverage mirrors the acceptance criteria:
//   - write then read returns the sha
//   - two files with the same sha return it
//   - two files with different shas return null
//   - no files returns null
//   - a corrupt file returns null
//   - uppercase sha returns null
//   - 39-character sha returns null
//   - a failing git runner does not throw

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeLoadedSha, readLoadedSha } = require('./node-loaded-sha.js');

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loaded-sha-test-'));
}

function makeDeps(opts = {}) {
  const instancesDir = opts.instancesDir || path.join(opts.tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  const deps = {
    instancesDir,
    codeDir: opts.codeDir || process.cwd(),
    execGit: opts.execGit || null,
  };
  return deps;
}

test('writeLoadedSha writes a file with the correct sha and timestamp', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  const fakeSha = 'a'.repeat(40);
  const deps = {
    instancesDir,
    codeDir: tmpDir,
    execGit: () => fakeSha + '\n',
  };
  const result = writeLoadedSha('unit-a', deps);
  assert.equal(result, fakeSha);
  const file = path.join(instancesDir, 'loaded-sha-unit-a.json');
  assert.ok(fs.existsSync(file), 'file should exist');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.sha, fakeSha);
  assert.ok(typeof parsed.timestamp === 'string' && parsed.timestamp.endsWith('Z'));
});

test('writeLoadedSha returns null on git failure (does not throw)', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  const deps = {
    instancesDir,
    codeDir: tmpDir,
    execGit: () => { throw new Error('git not found'); },
  };
  const result = writeLoadedSha('unit-a', deps);
  assert.equal(result, null);
});

test('writeLoadedSha returns null when git returns non-40-hex output', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  const deps = {
    instancesDir,
    codeDir: tmpDir,
    execGit: () => 'not-a-sha\n',
  };
  const result = writeLoadedSha('unit-a', deps);
  assert.equal(result, null);
});

test('writeLoadedSha returns null when fs write fails', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  // Point at a read-only directory
  const readOnlyDir = '/proc/self/fd';
  const deps = {
    instancesDir: readOnlyDir,
    codeDir: tmpDir,
    execGit: () => 'b'.repeat(40) + '\n',
  };
  const result = writeLoadedSha('unit-a', deps);
  assert.equal(result, null);
});

test('readLoadedSha returns the sha when one file exists', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  const fakeSha = 'c'.repeat(40);
  fs.writeFileSync(
    path.join(instancesDir, 'loaded-sha-unit-a.json'),
    JSON.stringify({ sha: fakeSha, timestamp: '2026-01-01T00:00:00.000Z' })
  );
  const deps = { instancesDir };
  const result = readLoadedSha(deps);
  assert.equal(result, fakeSha);
});

test('readLoadedSha returns the sha when two files have the same sha', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  const fakeSha = 'd'.repeat(40);
  fs.writeFileSync(
    path.join(instancesDir, 'loaded-sha-unit-a.json'),
    JSON.stringify({ sha: fakeSha, timestamp: '2026-01-01T00:00:00.000Z' })
  );
  fs.writeFileSync(
    path.join(instancesDir, 'loaded-sha-unit-b.json'),
    JSON.stringify({ sha: fakeSha, timestamp: '2026-01-01T00:00:01.000Z' })
  );
  const deps = { instancesDir };
  const result = readLoadedSha(deps);
  assert.equal(result, fakeSha);
});

test('readLoadedSha returns null when no files exist', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  const deps = { instancesDir };
  const result = readLoadedSha(deps);
  assert.equal(result, null);
});

test('readLoadedSha returns null when two files have different shas', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(
    path.join(instancesDir, 'loaded-sha-unit-a.json'),
    JSON.stringify({ sha: 'a'.repeat(40), timestamp: '2026-01-01T00:00:00.000Z' })
  );
  fs.writeFileSync(
    path.join(instancesDir, 'loaded-sha-unit-b.json'),
    JSON.stringify({ sha: 'b'.repeat(40), timestamp: '2026-01-01T00:00:01.000Z' })
  );
  const deps = { instancesDir };
  const result = readLoadedSha(deps);
  assert.equal(result, null);
});

test('readLoadedSha returns null when a file is corrupt (bad JSON)', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(
    path.join(instancesDir, 'loaded-sha-unit-a.json'),
    '{not valid json'
  );
  const deps = { instancesDir };
  const result = readLoadedSha(deps);
  assert.equal(result, null);
});

test('readLoadedSha returns null when a sha is uppercase', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(
    path.join(instancesDir, 'loaded-sha-unit-a.json'),
    JSON.stringify({ sha: 'A'.repeat(40), timestamp: '2026-01-01T00:00:00.000Z' })
  );
  const deps = { instancesDir };
  const result = readLoadedSha(deps);
  assert.equal(result, null);
});

test('readLoadedSha returns null when a sha is 39 characters', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(
    path.join(instancesDir, 'loaded-sha-unit-a.json'),
    JSON.stringify({ sha: 'a'.repeat(39), timestamp: '2026-01-01T00:00:00.000Z' })
  );
  const deps = { instancesDir };
  const result = readLoadedSha(deps);
  assert.equal(result, null);
});

test('a failing git runner does not throw', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  const deps = {
    instancesDir,
    codeDir: tmpDir,
    execGit: () => { throw new Error('simulated git failure'); },
  };
  const result = writeLoadedSha('unit-a', deps);
  assert.equal(result, null);
});

test('readLoadedSha returns null when the instances dir does not exist', () => {
  const deps = { instancesDir: '/nonexistent/path/that/cannot/exist' };
  const result = readLoadedSha(deps);
  assert.equal(result, null);
});

test('readLoadedSha returns null when a file is missing the sha field', () => {
  const tmpDir = mktmp();
  const instancesDir = path.join(tmpDir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(
    path.join(instancesDir, 'loaded-sha-unit-a.json'),
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z' })
  );
  const deps = { instancesDir };
  const result = readLoadedSha(deps);
  assert.equal(result, null);
});
