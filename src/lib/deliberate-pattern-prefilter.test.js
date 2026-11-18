'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldAutoDismiss } = require('./deliberate-pattern-prefilter.js');

const KEYS = ['dismiss', 'reason', 'rule'];
const join = (...lines) => lines.join('\n');

// P1: a deliberately marked earlier loop must not dismiss an unmarked flagged loop.
test('P1: marked earlier loop does not dismiss an unmarked flagged loop', () => {
  const snippet = join(
    '// deliberate: sync-io-in-loop',
    'for (const a of first) {',
    '  fs.readFileSync(a);',
    '}',
    'for (const f of files) {',
    '  fs.readFileSync(f);',
    '}',
  );
  const r = shouldAutoDismiss('sync-io-in-loop', snippet, 'for (const f of files) {');
  assert.equal(r.dismiss, false);
  assert.equal(r.rule, null);
  assert.deepEqual(Object.keys(r).sort(), KEYS);
});

// P2: sequential await over an unbounded array, with batchSize present but not applied.
test('P2: sequential await over unbounded array with batchSize is not dismissed', () => {
  const snippet = join(
    'const batchSize = 10;',
    '// rate limit between calls',
    'for (const x of items) {',
    '  await send(x);',
    '}',
  );
  const r = shouldAutoDismiss('sequential-await-in-loop', snippet, 'for (const x of items) {');
  assert.equal(r.dismiss, false);
  assert.equal(r.rule, null);
  assert.deepEqual(Object.keys(r).sort(), KEYS);
});

// P3: a marker several lines above the header must not count.
test('P3: sync-io marker several lines above the header is not dismissed', () => {
  const snippet = join(
    '// deliberate: sync-io-in-loop',
    'const cfg = load();',
    'const n = 1;',
    'for (const f of files) {',
    '  fs.readFileSync(f);',
    '}',
  );
  const r = shouldAutoDismiss('sync-io-in-loop', snippet, 'for (const f of files) {');
  assert.equal(r.dismiss, false);
  assert.equal(r.rule, null);
  assert.deepEqual(Object.keys(r).sort(), KEYS);
});

// R1: bounded .slice(0, batchSize) loop with awaited call and adjacent rate-limit comment.
test('R1: bounded slice with adjacent rate-limit comment and await is dismissed', () => {
  const snippet = join(
    '// deliberate: rate limit between calls',
    'for (const x of items.slice(0, batchSize)) {',
    '  await fetchOne(x);',
    '}',
  );
  const r = shouldAutoDismiss('sequential-await-in-loop', snippet, 'for (const x of items.slice(0, batchSize)) {');
  assert.equal(r.dismiss, true);
  assert.equal(r.rule, 'R1');
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  assert.deepEqual(Object.keys(r).sort(), KEYS);
});

// R2: deliberate sync-io marker directly above the flagged header.
test('R2: deliberate sync-io marker directly above the header is dismissed', () => {
  const snippet = join(
    '// deliberate: sync-io-in-loop',
    'for (const f of files) {',
    '  fs.readFileSync(f);',
    '}',
  );
  const r = shouldAutoDismiss('sync-io-in-loop', snippet, 'for (const f of files) {');
  assert.equal(r.dismiss, true);
  assert.equal(r.rule, 'R2');
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  assert.deepEqual(Object.keys(r).sort(), KEYS);
});
