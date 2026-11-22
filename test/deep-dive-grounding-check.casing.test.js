'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ground-casing-home-'));
process.env.HOME = tmpHome;

const mod = require('../src/deep-dive-grounding-check.js');
const checkFabricatedSymbols = mod.checkFabricatedSymbols || (mod._test && mod._test.checkFabricatedSymbols);

const task = (files) => ({ promptContext: { files } });
const draft = (cite) => `The helper is \`${cite}\` and the pipeline calls it.`;

test('cited unittest.skipUnless passes when fetched content has skipunless (lowercase)', () => {
  const out = checkFabricatedSymbols(
    task([{ path: 'lib/checks.py', content: 'def skipunless(cond): return cond' }]),
    draft('unittest.skipUnless'),
  );
  assert.deepStrictEqual(out, []);
});

test('cited unittest.skipUnless passes when fetched content has SKIPUNLESS (uppercase)', () => {
  const out = checkFabricatedSymbols(
    task([{ path: 'lib/checks.py', content: 'SKIPUNLESS = True' }]),
    draft('unittest.skipUnless'),
  );
  assert.deepStrictEqual(out, []);
});

test('an identifier absent from path and final segment is still flagged and named', () => {
  const out = checkFabricatedSymbols(
    task([{ path: 'lib/checks.py', content: 'def skipunless(cond): return cond' }]),
    draft('unittest.neverPresentHere'),
  );
  assert.ok(out.some((c) => c.detail.includes('unittest.neverPresentHere')), JSON.stringify(out));
});

test('a final segment is matched on whole tokens only (skip does not match skipUnless)', () => {
  const out = checkFabricatedSymbols(
    task([{ path: 'lib/checks.py', content: 'def skipUnless(cond): return cond' }]),
    draft('unittest.skip'),
  );
  assert.ok(out.some((c) => c.detail.includes('unittest.skip')), JSON.stringify(out));
});
