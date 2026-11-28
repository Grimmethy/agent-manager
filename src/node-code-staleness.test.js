'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compareCodeFreshness } = require('./node-code-staleness');

const T0 = '2026-11-01T00:00:00Z';
const UNKNOWN = { stale: false, reason: 'unknown', lagMs: null };

test('same sha -> same-sha, not stale', () => {
  const r = compareCodeFreshness({ headSha: 'a', headCommitDate: T0 }, { headSha: 'a', headCommitDate: T0 });
  assert.deepStrictEqual(r, { stale: false, reason: 'same-sha', lagMs: 0 });
});

test('same sha without dates -> same-sha with null lag', () => {
  const r = compareCodeFreshness({ headSha: 'a' }, { headSha: 'a' });
  assert.deepStrictEqual(r, { stale: false, reason: 'same-sha', lagMs: null });
});

test('missing sha on either or both sides -> unknown', () => {
  assert.deepStrictEqual(compareCodeFreshness({ headSha: null }, { headSha: null }), UNKNOWN);
  assert.deepStrictEqual(compareCodeFreshness({ headSha: null, headCommitDate: T0 }, { headSha: 'b', headCommitDate: T0 }), UNKNOWN);
  assert.deepStrictEqual(compareCodeFreshness({ headSha: 'a', headCommitDate: T0 }, { headSha: '', headCommitDate: T0 }), UNKNOWN);
});

test('null node or primary objects -> unknown', () => {
  assert.deepStrictEqual(compareCodeFreshness(null, { headSha: 'b', headCommitDate: T0 }), UNKNOWN);
  assert.deepStrictEqual(compareCodeFreshness({ headSha: 'a', headCommitDate: T0 }, undefined), UNKNOWN);
});

test('missing or unparseable date on either side -> unknown', () => {
  assert.deepStrictEqual(compareCodeFreshness({ headSha: 'a' }, { headSha: 'b', headCommitDate: T0 }), UNKNOWN);
  assert.deepStrictEqual(compareCodeFreshness({ headSha: 'a', headCommitDate: T0 }, { headSha: 'b', headCommitDate: null }), UNKNOWN);
  assert.deepStrictEqual(compareCodeFreshness({ headSha: 'a', headCommitDate: 'garbage' }, { headSha: 'b', headCommitDate: T0 }), UNKNOWN);
  assert.deepStrictEqual(compareCodeFreshness({ headSha: 'a', headCommitDate: T0 }, { headSha: 'b', headCommitDate: 'garbage' }), UNKNOWN);
});

test('25h behind -> behind, stale', () => {
  const r = compareCodeFreshness({ headSha: 'a', headCommitDate: T0 }, { headSha: 'b', headCommitDate: '2026-11-02T01:00:00Z' });
  assert.deepStrictEqual(r, { stale: true, reason: 'behind', lagMs: 90000000 });
});

test('exactly 24h behind -> within-window (boundary)', () => {
  const r = compareCodeFreshness({ headSha: 'a', headCommitDate: T0 }, { headSha: 'b', headCommitDate: '2026-11-02T00:00:00Z' });
  assert.deepStrictEqual(r, { stale: false, reason: 'within-window', lagMs: 86400000 });
});

test('node newer than primary -> within-window with negative lag', () => {
  const r = compareCodeFreshness({ headSha: 'a', headCommitDate: '2026-11-03T00:00:00Z' }, { headSha: 'b', headCommitDate: T0 });
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.reason, 'within-window');
  assert.ok(r.lagMs < 0);
});

test('custom maxLagMs honoured', () => {
  const r = compareCodeFreshness(
    { headSha: 'a', headCommitDate: '2026-11-01T00:00:00Z' },
    { headSha: 'b', headCommitDate: '2026-11-01T00:00:02Z' },
    { maxLagMs: 1000 });
  assert.deepStrictEqual(r, { stale: true, reason: 'behind', lagMs: 2000 });
});

test('non-finite maxLagMs falls back to 24h default', () => {
  const r = compareCodeFreshness(
    { headSha: 'a', headCommitDate: '2026-11-01T00:00:00Z' },
    { headSha: 'b', headCommitDate: '2026-11-01T00:00:02Z' },
    { maxLagMs: NaN });
  assert.strictEqual(r.reason, 'within-window');
});
