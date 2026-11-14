'use strict';

// HUB0274-02: a 'yes' verdict must quote something that is LITERALLY in the evidence pack.
// Before, any hash-shaped / file:line-shaped / quoted string passed as long as the pack held some string of the same shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateResolutionVerdict } = require('../src/validate-resolution.js');

const PACK = {
  entryText: 'the hold subcommand is missing',
  citedPaths: [{ path: 'scripts/gpu-arbiter-cli.js', exists: true, commits: ['4e8054e add hold subcommand to gpu-arbiter-cli'] }],
  citedIdentifiers: [{ identifier: 'holdLease', hits: ['4e8054e1c2d3:scripts/gpu-arbiter-cli.js:88:function holdLease() {'] }],
  recentCommits: ['4e8054e add "hold" subcommand to gpu-arbiter-cli'],
};
const yes = (evidence) => validateResolutionVerdict({ resolved: 'yes', evidence }, evidence, PACK);

test('yes with a hash that IS in the pack stays yes', () => {
  assert.equal(yes('fixed in 4e8054e').resolved, 'yes');
});

test('yes with a different hash while the pack holds another hash becomes unclear', () => {
  const r = yes('fixed in 9a8b7c6d5e');
  assert.equal(r.resolved, 'unclear');
  assert.equal(r.error, 'evidence not grounded in pack');
  assert.equal(r.evidence, '');
});

test('a long form of a short pack hash (and the reverse) counts as the same hash', () => {
  assert.equal(yes('fixed in 4e8054e1c2d3a4b5c6d7e8f9a0b1c2d3e4f5a6b7').resolved, 'yes');
  assert.equal(yes('see 4e8054e1').resolved, 'yes');
});

test('yes with a quoted commit subject copied from the pack stays yes', () => {
  assert.equal(yes('commit "add hold subcommand to gpu-arbiter-cli" did it').resolved, 'yes');
});

test('a quoted phrase with a backslash still matches the pack (the pack is searched as plain strings, not as escaped JSON)', () => {
  const pack = { recentCommits: ['1a2b3c4 handle C:\\temp paths in the loader'] };
  const r = validateResolutionVerdict({ resolved: 'yes' }, '"handle C:\\temp paths in the loader"', pack);
  assert.equal(r.resolved, 'yes');
});

test('yes with a quoted phrase that is not in the pack becomes unclear', () => {
  assert.equal(yes('as the commit "rewrite the whole scheduler" shows').resolved, 'unclear');
});

test('yes with a file:line that is in the pack stays yes, one that is not becomes unclear', () => {
  assert.equal(yes('see scripts/gpu-arbiter-cli.js:88').resolved, 'yes');
  assert.equal(yes('see scripts/gpu-arbiter-cli.js:999').resolved, 'unclear');
});

test('yes whose evidence has no hash, file:line or quoted phrase at all becomes unclear', () => {
  assert.equal(yes('it looks fixed to me').resolved, 'unclear');
});

test('invalid verdict object, missing evidence, and no / unclear pass-through rules are unchanged', () => {
  assert.deepEqual(validateResolutionVerdict(null, 'x', PACK), { resolved: 'unclear', evidence: '', error: 'invalid verdict format' });
  assert.deepEqual(validateResolutionVerdict({ resolved: 'maybe' }, 'x', PACK), { resolved: 'unclear', evidence: '', error: 'invalid verdict format' });
  assert.deepEqual(validateResolutionVerdict({ resolved: 'yes' }, '   ', PACK), { resolved: 'unclear', evidence: '', error: 'missing evidence' });
  assert.deepEqual(validateResolutionVerdict({ resolved: 'no' }, '  nothing cited  ', PACK), { resolved: 'no', evidence: 'nothing cited' });
  assert.deepEqual(validateResolutionVerdict({ resolved: 'unclear' }, 'cannot tell', PACK), { resolved: 'unclear', evidence: 'cannot tell' });
});

test('a missing or non-object pack never throws and grounds nothing', () => {
  assert.equal(validateResolutionVerdict({ resolved: 'yes' }, 'fixed in 4e8054e', undefined).resolved, 'unclear');
  assert.equal(validateResolutionVerdict({ resolved: 'yes' }, 'fixed in 4e8054e', 'a string pack 4e8054e').resolved, 'yes');
});
