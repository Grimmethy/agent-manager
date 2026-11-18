'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldAutoDismiss } = require('./deliberate-pattern-prefilter.js');

const KEYS = ['dismiss', 'reason', 'rule'];

test('P1: unbounded iterator with unrelated slice and distant rate-limit comment is not dismissed', () => {
  const snippet = [
    '// rate limit',
    'const other = [1, 2, 3];',
    'const z = other.slice(0, 5);',
    'for (const item of items) {',
    '  await send(item);',
    '}',
  ].join('\n');
  const r = shouldAutoDismiss('sequential-await-in-loop', snippet, 'for (const item of items) {');
  assert.equal(r.dismiss, false);
  assert.equal(r.rule, null);
  assert.deepEqual(Object.keys(r).sort(), KEYS);
});

test('P2: sync-io marker above a different statement is not dismissed', () => {
  const snippet = [
    '// deliberate: sync-io-in-loop',
    'const cfg = load();',
    'for (const f of files) {',
    '  fs.readFileSync(f);',
    '}',
  ].join('\n');
  const r = shouldAutoDismiss('sync-io-in-loop', snippet, 'for (const f of files) {');
  assert.equal(r.dismiss, false);
  assert.equal(r.rule, null);
  assert.deepEqual(Object.keys(r).sort(), KEYS);
});

test('R1: bounded slice with adjacent deliberate comment and awaited call is dismissed', () => {
  const snippet = [
    '// deliberate: rate limit between calls',
    'for (const x of items.slice(0, N)) {',
    '  await fetchOne(x);',
    '}',
  ].join('\n');
  const r = shouldAutoDismiss('sequential-await-in-loop', snippet, 'for (const x of items.slice(0, N)) {');
  assert.equal(r.dismiss, true);
  assert.equal(r.rule, 'R1');
  assert.deepEqual(Object.keys(r).sort(), KEYS);
});

test('R2: deliberate sync-io marker directly above the flagged loop is dismissed', () => {
  const snippet = [
    '// deliberate: sync-io-in-loop',
    'for (const f of files) {',
    '  fs.readFileSync(f);',
    '}',
  ].join('\n');
  const r = shouldAutoDismiss('sync io in loop', snippet, 'for (const f of files) {');
  assert.equal(r.dismiss, true);
  assert.equal(r.rule, 'R2');
  assert.deepEqual(Object.keys(r).sort(), KEYS);
});

test('missing flagLine fails open', () => {
  const r = shouldAutoDismiss('sync-io-in-loop', 'for (const f of files) {\n}', 'while (true) {');
  assert.equal(r.dismiss, false);
  assert.equal(r.rule, null);
  assert.deepEqual(Object.keys(r).sort(), KEYS);
});
