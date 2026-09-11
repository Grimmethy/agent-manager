'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { missingFileCheck } = require('./draft-file-guard.js');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-file-guard-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'real.js'), '// real\n');
  return dir;
}

test('blocked:false when every named path exists', () => {
  const repo = tmpRepo();
  const r = missingFileCheck('This edits `src/real.js` to add a guard.', repo, ['src']);
  assert.equal(r.blocked, false);
});

test('blocked:true + missing list when a named path does not exist and is not a create target', () => {
  const repo = tmpRepo();
  const r = missingFileCheck('This edits `src/phantom.js` and `src/real.js`.', repo, ['src']);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.missing, ['src/phantom.js']);
  assert.match(r.reason, /^missing-file: src\/phantom\.js$/);
});

test('a Group-B mode:create target is NOT flagged (isCreateTarget carve-out)', () => {
  const repo = tmpRepo();
  const r = missingFileCheck(JSON.stringify({ mode: 'create', file: 'src/brand-new.js', content: 'x' }), repo, ['src']);
  assert.equal(r.blocked, false);
});

test('third arg defaults to [] (arity 2) and an empty draft is not blocked', () => {
  assert.equal(missingFileCheck.length, 2);
  assert.equal(missingFileCheck('', tmpRepo()).blocked, false);
});

test('does not import from the draft pipeline -- only ./fact-checker.js', () => {
  const src = fs.readFileSync(path.join(__dirname, 'draft-file-guard.js'), 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['./fact-checker.js']);
});
