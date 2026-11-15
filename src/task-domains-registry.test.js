/**
 * Tests for src/task-domains-registry.js
 *
 * Verifies:
 *   1. getStandardDomains() returns all standard domains (default, adhoc, plus every registered source).
 *   2. Each domain has a valid shape (workDirKind, successCheck).
 *   3. isStandardDomain() correctly identifies standard vs. non-standard domains.
 *   4. getDomainShape() returns null for non-standard domains.
 *   5. Adding a new source automatically adds its domain to the set.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTaskSource, clearRegistry } = require('./task-source-registry.js');
const { getStandardDomains, isStandardDomain, getDomainShape, ALWAYS_PRESENT, DEFAULT_SHAPE } = require('./task-domains-registry.js');

test.beforeEach(() => {
  clearRegistry();
});

test('getStandardDomains includes default and adhoc', () => {
  const domains = getStandardDomains();
  assert.ok('default' in domains, 'default domain must be present');
  assert.ok('adhoc' in domains, 'adhoc domain must be present');
});

test('getStandardDomains includes every registered source name', () => {
  registerTaskSource('test_source_a', { priority: 10 });
  registerTaskSource('test_source_b', { priority: 20 });
  const domains = getStandardDomains();
  assert.ok('test_source_a' in domains, 'registered source a must become a domain');
  assert.ok('test_source_b' in domains, 'registered source b must become a domain');
});

test('getStandardDomains returns domains with valid shapes', () => {
  registerTaskSource('shape_test', { priority: 5 });
  const domains = getStandardDomains();
  for (const [name, shape] of Object.entries(domains)) {
    assert.ok(typeof shape.workDirKind === 'string', `${name}: workDirKind must be a string`);
    assert.ok(typeof shape.successCheck === 'string', `${name}: successCheck must be a string`);
    assert.ok(
      shape.workDirKind === 'repoRoot' || shape.workDirKind === 'secondBrainDir' || shape.workDirKind === 'taxharvestRoot',
      `${name}: workDirKind must be one of repoRoot/secondBrainDir/taxharvestRoot (got ${shape.workDirKind})`,
    );
  }
});

test('isStandardDomain returns true for default, adhoc, and registered sources', () => {
  registerTaskSource('standard_test', { priority: 1 });
  assert.ok(isStandardDomain('default'), 'default is standard');
  assert.ok(isStandardDomain('adhoc'), 'adhoc is standard');
  assert.ok(isStandardDomain('standard_test'), 'registered source is standard');
});

test('isStandardDomain returns false for arbitrary strings', () => {
  assert.ok(!isStandardDomain('not_a_real_domain'), 'arbitrary string is not standard');
  assert.ok(!isStandardDomain(''), 'empty string is not standard');
});

test('getDomainShape returns shape for standard domains', () => {
  registerTaskSource('shape_query', { priority: 1 });
  const shape = getDomainShape('shape_query');
  assert.ok(shape, 'shape must exist for registered source');
  assert.ok(typeof shape.workDirKind === 'string');
  assert.ok(typeof shape.successCheck === 'string');
});

test('getDomainShape returns null for non-standard domains', () => {
  assert.equal(getDomainShape('not_a_real_domain'), null);
  assert.equal(getDomainShape(''), null);
});

test('new source is automatically added to the domain set', () => {
  // Initial set (no sources registered).
  const initial = getStandardDomains();
  assert.ok('default' in initial);
  assert.ok('adhoc' in initial);

  // Register a new source.
  registerTaskSource('brand_new_source', { priority: 100 });
  const updated = getStandardDomains();
  assert.ok('brand_new_source' in updated, 'new source must appear in domain set');
  assert.equal(Object.keys(updated).length, Object.keys(initial).length + 1, 'exactly one new domain');
});

test('DEFAULT_SHAPE is the fallback for sources without workDirKind', () => {
  registerTaskSource('no_workdir', { priority: 1 });
  const domains = getStandardDomains();
  assert.deepEqual(domains.no_workdir, DEFAULT_SHAPE, 'source without workDirKind uses DEFAULT_SHAPE');
});
