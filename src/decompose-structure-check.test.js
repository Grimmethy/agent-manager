'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { runDecomposeStructureCheck, REQUIRED_PREFIX } = require('./decompose-structure-check.js');

const KEY = 'AGENT_MANAGER_DECOMPOSE_STRUCTURE_CHECK';
const saved = process.env[KEY];
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

const VALID = 'RESOLUTION: decompose\n[{"title":"p1","rawText":"first piece"},{"title":"p2","rawText":"second piece"}]\nsplit because big';

test('a valid non-empty array of {title, rawText} passes (null)', () => {
  assert.equal(runDecomposeStructureCheck({}, VALID), null);
});

test('a valid array inside a fenced json block passes (null)', () => {
  const text = 'RESOLUTION: decompose\n```json\n[{"title":"p1","rawText":"first"}]\n```';
  assert.equal(runDecomposeStructureCheck({}, text), null);
});

test('prose-only decompose draft blocks with the required reason', () => {
  const v = runDecomposeStructureCheck({}, 'RESOLUTION: decompose\n1. first thing\n2. second thing');
  assert.equal(v.verdict, 'blocked');
  assert.ok(v.reason.includes('Missing required sub-task JSON array'));
  assert.ok(v.reason.startsWith(REQUIRED_PREFIX));
});

test('malformed JSON blocks', () => {
  const v = runDecomposeStructureCheck({}, 'RESOLUTION: decompose\n[{"title":"a","rawText":"b"');
  assert.equal(v.verdict, 'blocked');
  assert.ok(v.reason.includes('Missing required sub-task JSON array'));
});

test('an element missing rawText blocks', () => {
  const v = runDecomposeStructureCheck({}, 'RESOLUTION: decompose\n[{"title":"a"}]');
  assert.equal(v.verdict, 'blocked');
  assert.ok(v.reason.includes('rawText'));
});

test('an empty array blocks', () => {
  const v = runDecomposeStructureCheck({}, 'RESOLUTION: decompose\n[]');
  assert.equal(v.verdict, 'blocked');
  assert.ok(v.reason.includes('empty'));
});

test('a non-decompose resolution returns null even with a prose array', () => {
  const task = { adhocResolution: 'implemented' };
  assert.equal(runDecomposeStructureCheck(task, 'RESOLUTION: implemented\n1. did a thing'), null);
});

test('the kill switch set to false returns null', () => {
  process.env[KEY] = 'false';
  assert.equal(runDecomposeStructureCheck({}, 'RESOLUTION: decompose\n1. prose only'), null);
});
