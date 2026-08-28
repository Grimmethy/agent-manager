'use strict';

// Unit tests for deterministic-recheck-registry.js (ADR-0022 Stage B). The consumption
// side is covered by staleness-fastpath.test.js; this covers the registry itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  registerDeterministicRecheck,
  getDeterministicRecheck,
  getRecheckSources,
  clearDeterministicRecheckRegistry,
} = require('./deterministic-recheck-registry.js');

test('register + get round-trips perFileRules / repoWideRules', () => {
  clearDeterministicRecheckRegistry();
  const perFile = { r1: () => [] };
  const repoWide = { r2: () => [] };
  registerDeterministicRecheck('observability_review', { perFileRules: perFile, repoWideRules: repoWide });
  const cfg = getDeterministicRecheck('observability_review');
  assert.equal(cfg.perFileRules, perFile);
  assert.equal(cfg.repoWideRules, repoWide);
});

test('missing rule categories default to empty objects (never undefined)', () => {
  clearDeterministicRecheckRegistry();
  registerDeterministicRecheck('performance_review', { perFileRules: { r: () => [] } });
  const cfg = getDeterministicRecheck('performance_review');
  assert.deepEqual(cfg.repoWideRules, {});
});

test('getDeterministicRecheck returns null for an unregistered source', () => {
  clearDeterministicRecheckRegistry();
  assert.equal(getDeterministicRecheck('nope'), null);
});

test('registering the same source twice throws (matches registerTaskSource)', () => {
  clearDeterministicRecheckRegistry();
  registerDeterministicRecheck('observability_review', {});
  assert.throws(() => registerDeterministicRecheck('observability_review', {}), /already registered/);
});

test('a non-string sourceName throws', () => {
  clearDeterministicRecheckRegistry();
  assert.throws(() => registerDeterministicRecheck(null, {}), /non-empty string/);
});

test('getRecheckSources + clearDeterministicRecheckRegistry', () => {
  clearDeterministicRecheckRegistry();
  registerDeterministicRecheck('observability_review', {});
  registerDeterministicRecheck('performance_review', {});
  assert.deepEqual(getRecheckSources().sort(), ['observability_review', 'performance_review']);
  clearDeterministicRecheckRegistry();
  assert.deepEqual(getRecheckSources(), []);
});
