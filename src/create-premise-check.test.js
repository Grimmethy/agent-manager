'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCreatePremise } = require('./create-premise-check.js');

function stubBase(paths) {
  const set = new Set(paths);
  const calls = [];
  const fn = (p) => { calls.push(p); return set.has(p); };
  fn.calls = calls;
  return fn;
}

test('existing review-inert.js and review-inert.test.js give ok:false', () => {
  const baseHasFile = stubBase(['src/review-inert.js', 'src/review-inert.test.js']);
  const r = checkCreatePremise({
    pieceTargets: 'Create src/review-inert.js and create review-inert.test.js with the helpers.',
    baseHasFile,
  });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'needs-clarification');
  assert.deepEqual(r.existing.sort(), ['src/review-inert.js', 'src/review-inert.test.js']);
  assert.match(r.reason, /review-inert\.js/);
});

test('a genuinely new file gives ok:true', () => {
  const baseHasFile = stubBase(['src/review-inert.js']);
  const r = checkCreatePremise({
    pieceTargets: 'Create src/create-premise-check.js exporting checkCreatePremise.',
    baseHasFile,
  });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(baseHasFile.calls, ['src/create-premise-check.js']);
});

test('a piece with no create targets is untouched', () => {
  const baseHasFile = stubBase(['src/review-inert.js']);
  const r = checkCreatePremise({
    pieceTargets: 'Fix the wording of the review message in the existing writer.',
    baseHasFile,
  });
  assert.deepEqual(r, { ok: true });
  assert.equal(baseHasFile.calls.length, 0);
});
