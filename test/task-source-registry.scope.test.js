'use strict';

// scope:'core' next() must return null on a non-core project, on every retrieval path
// (registration, getRegisteredSource, getRegisteredSources, and updateTaskSource).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const registryMod = require(path.join(__dirname, '..', 'src', 'task-source-registry.js'));
const scopeMod = require(path.join(__dirname, '..', 'src', 'lib', 'source-scope.js'));

// sourceEligibleHere is destructured at call time inside the gate, so stubbing the module property works.
function withEligible(value, fn) {
  const saved = scopeMod.sourceEligibleHere;
  scopeMod.sourceEligibleHere = () => value;
  try {
    return fn();
  } finally {
    scopeMod.sourceEligibleHere = saved;
  }
}

test('core source next() is null when not eligible, via getRegisteredSource', () => {
  registryMod.clearRegistry();
  registryMod.registerTaskSource('core_a', { scope: 'core', priority: 1, next: () => 'inner' });
  const entry = registryMod.getRegisteredSource('core_a');
  withEligible(false, () => assert.equal(entry.next(), null));
});

test('core source next() returns inner result when eligible, via getRegisteredSource', () => {
  registryMod.clearRegistry();
  registryMod.registerTaskSource('core_b', { scope: 'core', priority: 1, next: () => 'inner' });
  const entry = registryMod.getRegisteredSource('core_b');
  withEligible(true, () => assert.equal(entry.next(), 'inner'));
});

test('core source next() is gated via getRegisteredSources too', () => {
  registryMod.clearRegistry();
  registryMod.registerTaskSource('core_c', { scope: 'core', priority: 1, next: () => 'inner' });
  const entry = registryMod.getRegisteredSources().find((e) => e.name === 'core_c');
  withEligible(false, () => assert.equal(entry.next(), null));
  withEligible(true, () => assert.equal(entry.next(), 'inner'));
});

test('core next attached after registration via updateTaskSource is gated', () => {
  registryMod.clearRegistry();
  registryMod.registerTaskSource('core_d', { scope: 'core', priority: 1 });
  registryMod.updateTaskSource('core_d', { next: () => 'inner' });
  const entry = registryMod.getRegisteredSource('core_d');
  withEligible(false, () => assert.equal(entry.next(), null));
  withEligible(true, () => assert.equal(entry.next(), 'inner'));
});

test('non-core source next() is unaffected by eligibility', () => {
  registryMod.clearRegistry();
  registryMod.registerTaskSource('plain_e', { priority: 1, next: () => 'inner' });
  const entry = registryMod.getRegisteredSource('plain_e');
  withEligible(false, () => assert.equal(entry.next(), 'inner'));
});

test('gate predicate is read per call, not cached at registration', () => {
  registryMod.clearRegistry();
  registryMod.registerTaskSource('core_f', { scope: 'core', priority: 1, next: () => 'inner' });
  const entry = registryMod.getRegisteredSource('core_f');
  withEligible(true, () => assert.equal(entry.next(), 'inner'));
  withEligible(false, () => assert.equal(entry.next(), null));
  withEligible(true, () => assert.equal(entry.next(), 'inner'));
});
