'use strict';

// Unit tests for checkFindStrings (src/lib/implement-critique.js) -- the
// deterministic find-string uniqueness check for Group B edit items.
//
// Run: node --test src/lib/implement-critique-find.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkFindStrings } = require('./implement-critique.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'critique-find-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('checkFindStrings: absent find string yields find_not_found', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'sample.js'), 'hello world\n');

  const items = [{ mode: 'edit', find: 'zzz_absent_marker', file: 'src/lib/sample.js' }];
  const result = checkFindStrings(JSON.stringify(items), dir);

  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'find_not_found');
  assert.ok(result[0].detail.includes('src/lib/sample.js'));
});

test('checkFindStrings: find occurring 3 times yields find_ambiguous with detail containing 3', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  // "alpha" appears exactly 3 times as a standalone word, but split counts substring
  // matches, so use a unique substring that occurs exactly 3 times.
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'sample.js'), 'foo bar\nfoo baz\nfoo qux\n');

  const items = [{ mode: 'edit', find: 'foo', file: 'src/lib/sample.js' }];
  const result = checkFindStrings(JSON.stringify(items), dir);

  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'find_ambiguous');
  assert.ok(result[0].detail.includes('3'), `detail should contain '3', got: ${result[0].detail}`);
});

test('checkFindStrings: unique find yields no flags', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'sample.js'), 'unique_token_here\n');

  const items = [{ mode: 'edit', find: 'unique_token_here', file: 'src/lib/sample.js' }];
  const result = checkFindStrings(JSON.stringify(items), dir);

  assert.deepEqual(result, []);
});

test('checkFindStrings: nonexistent file path yields no flags and no throw', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  const items = [{ mode: 'edit', find: 'whatever', file: 'does/not/exist.js' }];
  let result;
  assert.doesNotThrow(() => {
    result = checkFindStrings(JSON.stringify(items), dir);
  });
  assert.deepEqual(result, []);
});

test('checkFindStrings: create-mode item yields no flags and no throw', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'sample.js'), 'hello\n');

  const items = [{ mode: 'create', find: 'hello', file: 'src/lib/sample.js' }];
  let result;
  assert.doesNotThrow(() => {
    result = checkFindStrings(JSON.stringify(items), dir);
  });
  assert.deepEqual(result, []);
});
