'use strict';

// Tests for src/remote-url.js readRemoteUrl(repoRoot): the trimmed origin URL of a git checkout, or '' on any failure.
// Written with require so it runs the same whether remote-url.js is an ES module or CommonJS.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRemoteUrl } = require('./remote-url.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remote-url-'));
}

function git(dir, args) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

test('a git repo with an origin returns its URL, trimmed', () => {
  const dir = tmp();
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'origin', 'https://example.test/owner/repo.git']);
  assert.equal(readRemoteUrl(dir), 'https://example.test/owner/repo.git');
});

test('a directory that is not a repo returns an empty string', () => {
  assert.equal(readRemoteUrl(tmp()), '');
});

test('a repo with no origin remote returns an empty string', () => {
  const dir = tmp();
  git(dir, ['init', '-q']);
  assert.equal(readRemoteUrl(dir), '');
});

test('a path that does not exist returns an empty string', () => {
  assert.equal(readRemoteUrl(path.join(tmp(), 'no-such-dir')), '');
});

test('only origin is read: another remote name does not count', () => {
  const dir = tmp();
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'upstream', 'https://example.test/other.git']);
  assert.equal(readRemoteUrl(dir), '');
});
