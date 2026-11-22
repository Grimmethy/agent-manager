'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ground-home-'));
process.env.HOME = tmpHome;

const mod = require('../src/deep-dive-grounding-check.js');
const checkFabricatedSymbols = mod.checkFabricatedSymbols || (mod._test && mod._test.checkFabricatedSymbols);

const task = (files) => ({ promptContext: { files } });
const draft = (cite) => `The module lives at \`${cite}\` and is used by the pipeline.`;

test('__init__.py accepted when the listing contains it', () => {
  const out = checkFabricatedSymbols(task([{ path: 'pkg/__init__.py', content: '' }, { path: 'pkg/a.py', content: 'x = 1' }]), draft('pkg/__init__.py'));
  assert.deepStrictEqual(out, []);
});

test('lib/infra/__init__.py accepted via a sibling file', () => {
  const out = checkFabricatedSymbols(task([{ path: 'lib/infra/x.py', content: 'x = 1' }]), draft('lib/infra/__init__.py'));
  assert.deepStrictEqual(out, []);
});

test('lib/infra/__init__.py accepted via an import of lib.infra', () => {
  const out = checkFabricatedSymbols(task([{ path: 'app/main.py', content: 'from lib.infra import helper' }]), draft('lib/infra/__init__.py'));
  assert.deepStrictEqual(out, []);
});

test('fabricated ghost/pkg/__init__.py rejected even when some file has def __init__', () => {
  const out = checkFabricatedSymbols(task([{ path: 'other/b.py', content: 'class B:\n  def __init__(self): pass' }]), draft('ghost/pkg/__init__.py'));
  assert.ok(out.some((c) => c.detail.includes('ghost/pkg/__init__.py')), JSON.stringify(out));
});
