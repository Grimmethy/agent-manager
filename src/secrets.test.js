'use strict';

// Unit tests for secrets.js. Permission-bit assertions (writeSecretFile's 0600 mode) only
// run their strict form on POSIX -- Windows' chmod/open mode argument doesn't restrict
// access the way POSIX bits do, so asserting an exact mode there would test a guarantee
// this module explicitly does not claim to provide on that platform (see secrets.js's own
// header comment).
//
// Run: node --test src/secrets.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { writeSecretFile, redactSecret, isConfigured } = require('./secrets.js');

function tempPath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-')), name);
}

test('writeSecretFile creates the file with the expected content', () => {
  const file = tempPath('token.txt');
  writeSecretFile(file, 'sk-real-secret-value');
  assert.equal(fs.readFileSync(file, 'utf8'), 'sk-real-secret-value');
});

test('writeSecretFile creates parent directories as needed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'));
  const file = path.join(dir, 'nested', 'deep', 'token.txt');
  writeSecretFile(file, 'x');
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
});

test('writeSecretFile sets 0600 permissions on POSIX', { skip: process.platform === 'win32' }, () => {
  const file = tempPath('token.txt');
  writeSecretFile(file, 'x');
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('writeSecretFile tightens permissions of a pre-existing looser-mode file on POSIX', { skip: process.platform === 'win32' }, () => {
  const file = tempPath('token.txt');
  fs.writeFileSync(file, 'old', { mode: 0o644 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  writeSecretFile(file, 'new');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('writeSecretFile does not throw on Windows even though mode has no real effect there', { skip: process.platform !== 'win32' }, () => {
  const file = tempPath('token.txt');
  assert.doesNotThrow(() => writeSecretFile(file, 'x'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
});

test('redactSecret replaces every occurrence of the known secret value, keeping only the last N chars visible', () => {
  const text = 'Using token sk-abcdef123456 to call the API. (sk-abcdef123456 again)';
  const result = redactSecret(text, 'sk-abcdef123456');
  assert.equal(result, 'Using token ***********3456 to call the API. (***********3456 again)');
});

test('redactSecret respects a custom visibleChars count', () => {
  const result = redactSecret('token=abc12345', 'abc12345', { visibleChars: 2 });
  assert.equal(result, 'token=******45');
});

test('redactSecret returns the text unchanged when the secret does not appear', () => {
  assert.equal(redactSecret('nothing sensitive here', 'sk-not-present'), 'nothing sensitive here');
});

test('redactSecret handles a secret shorter than visibleChars by fully masking it', () => {
  const result = redactSecret('pin is 12', '12', { visibleChars: 4 });
  assert.equal(result, 'pin is **');
});

test('redactSecret is a no-op on empty/missing inputs rather than throwing', () => {
  assert.equal(redactSecret('', 'secret'), '');
  assert.equal(redactSecret('some text', ''), 'some text');
  assert.equal(redactSecret(null, 'secret'), null);
  assert.equal(redactSecret('some text', null), 'some text');
});

test('isConfigured is true for a real non-empty value', () => {
  assert.equal(isConfigured('sk-real-value'), true);
});

test('isConfigured is false for empty, whitespace-only, null, or non-string values', () => {
  assert.equal(isConfigured(''), false);
  assert.equal(isConfigured('   '), false);
  assert.equal(isConfigured(null), false);
  assert.equal(isConfigured(undefined), false);
  assert.equal(isConfigured(12345), false);
});
