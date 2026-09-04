'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveAcceptanceCriteria, parseAcceptanceBlock, parseCriteriaBlock } = require('./acceptance-criteria.js');
const { runAcceptanceCommand } = require('./acceptance-command-gate.js');

test('resolveAcceptanceCriteria: promptContext array', () => {
  const r = resolveAcceptanceCriteria({ promptContext: { acceptanceCriteria: ['x passes', 'y is 200'] } });
  assert.deepEqual(r, { criteria: ['x passes', 'y is 200'], source: 'promptContext' });
});

test('resolveAcceptanceCriteria: promptContext newline string, bullet-stripped', () => {
  const r = resolveAcceptanceCriteria({ promptContext: { acceptanceCriteria: '- a\n- b\n1. c' } });
  assert.deepEqual(r.criteria, ['a', 'b', 'c']);
  assert.equal(r.source, 'promptContext');
});

test('resolveAcceptanceCriteria: falls back to a trailing CRITERIA: block in the plan', () => {
  const plan = '1. do a thing\n2. do another\n\nCRITERIA:\n- pytest test_x passes\n- GET /api/y returns 200';
  const r = resolveAcceptanceCriteria({ planResponse: plan });
  assert.deepEqual(r.criteria, ['pytest test_x passes', 'GET /api/y returns 200']);
  assert.equal(r.source, 'plan-derived');
});

test('resolveAcceptanceCriteria: none -> empty + null source', () => {
  assert.deepEqual(resolveAcceptanceCriteria({ planResponse: '1. just a plan' }), { criteria: [], source: null });
});

test('parseCriteriaBlock: stops at a blank line after the bullets', () => {
  const r = parseCriteriaBlock('CRITERIA:\n- one\n- two\n\nunrelated trailing prose');
  assert.deepEqual(r, ['one', 'two']);
});

test('parseAcceptanceBlock: three-part lines, PASS/FAIL detection', () => {
  const s = 'summary\n\nAcceptance:\n1. x passes -- ran pytest -- PASS (3 passed)\n2. y is 200 -- curl localhost -- FAIL got 500\n- z exists -- ls -- could not check -- no shell';
  const r = parseAcceptanceBlock(s);
  assert.equal(r.length, 3);
  assert.equal(r[0].pass, true);
  assert.equal(r[1].pass, false);
  assert.equal(r[2].pass, false);
  assert.equal(r[0].check, 'ran pytest');
});

test('parseAcceptanceBlock: absent block -> []', () => {
  assert.deepEqual(parseAcceptanceBlock('RESOLUTION: implemented\ndid the thing'), []);
});

test('runAcceptanceCommand: empty command -> ok, no checks', () => {
  assert.deepEqual(runAcceptanceCommand({ repoRoot: '/x', command: '  ' }), { ok: true, checks: [] });
});

test('runAcceptanceCommand: success via injected exec', () => {
  const exec = () => 'all good\n';
  const r = runAcceptanceCommand({ repoRoot: '/x', command: 'true', exec });
  assert.equal(r.ok, true);
  assert.equal(r.checks[0].status, 'pass');
});

test('runAcceptanceCommand: failure via injected exec that throws', () => {
  const exec = () => { const e = new Error('exit 1'); e.stderr = 'AssertionError: 500 != 200'; throw e; };
  const r = runAcceptanceCommand({ repoRoot: '/x', command: 'pytest', exec });
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].status, 'fail');
  assert.match(r.checks[0].detail, /AssertionError/);
});
