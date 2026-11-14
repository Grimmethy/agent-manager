'use strict';

// Tests for src/health-metrics.js (C3). Uses node:test (the repo's only test runner).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  bucketCounts,
  requeueRateByCause,
  shipRatePerSource,
  successBySourceModel,
  wilsonLower,
} = require('./health-metrics.js');
const { wilsonLower: sharedWilson } = require('./capability-ledger.js');

// ---------------------------------------------------------------------------
// wilsonLower identity
// ---------------------------------------------------------------------------
test('wilsonLower is the shared implementation from capability-ledger', () => {
  assert.strictEqual(wilsonLower, sharedWilson, 'identity (same function reference)');
  assert.strictEqual(wilsonLower(3, 10), sharedWilson(3, 10));
  assert.strictEqual(wilsonLower(0, 0), 0);
  // wilsonLower(1, 1) is conservative (~0.2065), not 1 -- the Wilson interval
  // shrinks toward 0.5 for tiny n even when p-hat = 1.
  assert.ok(wilsonLower(1, 1) > 0 && wilsonLower(1, 1) < 1);
});

// ---------------------------------------------------------------------------
// bucketCounts
// ---------------------------------------------------------------------------
test('bucketCounts returns exact counts from a synthetic queueDir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-bucket-'));
  try {
    // Create subdirs for the QUEUE_STATES names
    const states = ['pending', 'review', 'approved', 'blocked', 'done', 'needs-clarification', 'awaiting-confirm', 'coordinating'];
    for (const s of states) {
      fs.mkdirSync(path.join(tmp, s), { recursive: true });
    }
    // 2 files in blocked
    fs.writeFileSync(path.join(tmp, 'blocked', 't1.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'blocked', 't2.json'), '{}');
    // 1 file in needs-clarification
    fs.writeFileSync(path.join(tmp, 'needs-clarification', 't3.json'), '{}');
    // leave everything else empty

    const counts = bucketCounts(tmp);

    assert.equal(counts.blocked, 2, 'blocked');
    assert.equal(counts['needs-clarification'], 1, 'needs-clarification');
    assert.equal(counts.pending, 0, 'pending');
    assert.equal(counts.review, 0, 'review');
    assert.equal(counts.approved, 0, 'approved');
    assert.equal(counts.done, 0, 'done');
    assert.equal(counts['awaiting-confirm'], 0, 'awaiting-confirm');
    assert.equal(counts.coordinating, 0, 'coordinating');

    // Every QUEUE_STATES key must be present
    for (const s of states) {
      assert.ok(Object.prototype.hasOwnProperty.call(counts, s), `key ${s} present`);
    }
  } finally {
    // best-effort cleanup
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('bucketCounts returns all zeros for missing queueDir', () => {
  const counts = bucketCounts('/nonexistent/path/that/cannot/exist/xyz');
  assert.equal(counts.blocked, 0);
  assert.equal(counts.done, 0);
  // no NaN anywhere
  assert.ok(!JSON.stringify(counts).includes('NaN'), 'no NaN in output');
});

test('bucketCounts returns all zeros for empty dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-bucket-empty-'));
  try {
    const counts = bucketCounts(tmp);
    for (const k of Object.keys(counts)) {
      assert.equal(counts[k], 0, `key ${k} is 0`);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// requeueRateByCause
// ---------------------------------------------------------------------------
test('requeueRateByCause groups by signature and computes ratePerDay = count/windowDays', () => {
  const rows = [
    { actor: 'user1', signature: 'manual', at: '2026-10-20T00:00:00Z' },
    { actor: 'user2', signature: 'manual', at: '2026-10-19T00:00:00Z' },
    { actor: 'user3', signature: 'auto',    at: '2026-10-18T00:00:00Z' },
    { actor: 'user4', signature: 'auto',    at: '2026-10-17T00:00:00Z' },
    { actor: 'user5', signature: 'auto',    at: '2026-10-16T00:00:00Z' },
  ];
  const result = requeueRateByCause(rows, 7);

  // All 5 rows fall within 7 days of the newest (2026-10-20)
  const manual = result.find(r => r.cause === 'manual');
  const auto = result.find(r => r.cause === 'auto');
  assert.ok(manual, 'manual group exists');
  assert.ok(auto, 'auto group exists');
  assert.equal(manual.count, 2);
  assert.equal(auto.count, 3);
  // ratePerDay identity: count / windowDays
  assert.ok(Math.abs(manual.ratePerDay - 2 / 7) < 1e-12, `manual ratePerDay=${manual.ratePerDay} == 2/7`);
  assert.ok(Math.abs(auto.ratePerDay - 3 / 7) < 1e-12, `auto ratePerDay=${auto.ratePerDay} == 3/7`);
});

test('requeueRateByCause window filters out-of-range rows', () => {
  const rows = [
    { actor: 'u', signature: 'old', at: '2020-01-01T00:00:00Z' },
    { actor: 'u', signature: 'new', at: '2026-10-20T00:00:00Z' },
  ];
  const result = requeueRateByCause(rows, 7);
  assert.equal(result.length, 1);
  assert.equal(result[0].cause, 'new');
  assert.equal(result[0].count, 1);
});

test('requeueRateByCause empty input returns []', () => {
  const result = requeueRateByCause([], 7);
  assert.deepStrictEqual(result, []);
});

// ---------------------------------------------------------------------------
// shipRatePerSource
// ---------------------------------------------------------------------------
test('shipRatePerSource 3/10 ok: lower < 0.3 and equals shared wilsonLower(3,10)', () => {
  const rows = [
    { source: 'manual', ok: true,  at: '2026-10-20T00:00:00Z' },
    { source: 'manual', ok: true,  at: '2026-10-19T00:00:00Z' },
    { source: 'manual', ok: true,  at: '2026-10-18T00:00:00Z' },
    { source: 'manual', ok: false, at: '2026-10-17T00:00:00Z' },
    { source: 'manual', ok: false, at: '2026-10-16T00:00:00Z' },
    { source: 'manual', ok: false, at: '2026-10-15T00:00:00Z' },
    { source: 'manual', ok: false, at: '2026-10-14T00:00:00Z' },
    { source: 'manual', ok: false, at: '2026-10-13T00:00:00Z' },
    { source: 'manual', ok: false, at: '2026-10-12T00:00:00Z' },
    { source: 'manual', ok: false, at: '2026-10-11T00:00:00Z' },
  ];
  const result = shipRatePerSource(rows, 30);
  assert.equal(result.length, 1);
  const r = result[0];
  assert.equal(r.source, 'manual');
  assert.equal(r.ok, 3);
  assert.equal(r.total, 10);
  assert.ok(Math.abs(r.rate - 0.3) < 1e-12, `rate=${r.rate} == 0.3`);
  assert.ok(r.lower < 0.3, `lower=${r.lower} < 0.3`);
  // IDENTITY with the shared implementation, not just a matching value
  assert.strictEqual(r.lower, sharedWilson(3, 10), 'lower === shared wilsonLower(3,10)');
});

test('shipRatePerSource empty input returns []', () => {
  assert.deepStrictEqual(shipRatePerSource([], 30), []);
});

test('shipRatePerSource no NaN on empty input', () => {
  const r = shipRatePerSource([], 30);
  assert.ok(!JSON.stringify(r).includes('NaN'), 'no NaN');
});

// ---------------------------------------------------------------------------
// successBySourceModel
// ---------------------------------------------------------------------------
test('successBySourceModel cross-tabs source x model with Wilson lower', () => {
  const rows = [
    { source: 'manual', model: 'claude-3', ok: true  },
    { source: 'manual', model: 'claude-3', ok: false },
    { source: 'manual', model: 'claude-3', ok: true  },
    { source: 'api',    model: 'gpt-4',    ok: true  },
    { source: 'api',    model: 'gpt-4',    ok: false },
    { source: 'api',    model: 'gpt-4',    ok: false },
  ];
  const result = successBySourceModel(rows);
  assert.equal(result.length, 2);

  const manualClaude = result.find(r => r.source === 'manual' && r.model === 'claude-3');
  const apiGpt = result.find(r => r.source === 'api' && r.model === 'gpt-4');

  assert.ok(manualClaude);
  assert.equal(manualClaude.ok, 2);
  assert.equal(manualClaude.total, 3);
  assert.strictEqual(manualClaude.lower, sharedWilson(2, 3));

  assert.ok(apiGpt);
  assert.equal(apiGpt.ok, 1);
  assert.equal(apiGpt.total, 3);
  assert.strictEqual(apiGpt.lower, sharedWilson(1, 3));
});

test('successBySourceModel empty input returns []', () => {
  assert.deepStrictEqual(successBySourceModel([]), []);
});

test('successBySourceModel no NaN on empty input', () => {
  const r = successBySourceModel([]);
  assert.ok(!JSON.stringify(r).includes('NaN'), 'no NaN');
});

// ---------------------------------------------------------------------------
// Global "no NaN" sanity
// ---------------------------------------------------------------------------
test('all functions return no-NaN output on empty inputs', () => {
  const payloads = [
    JSON.stringify(bucketCounts('/no/such/dir')),
    JSON.stringify(requeueRateByCause([], 7)),
    JSON.stringify(shipRatePerSource([], 30)),
    JSON.stringify(successBySourceModel([])),
    JSON.stringify(wilsonLower(0, 0)),
  ];
  for (const p of payloads) {
    assert.ok(!p.includes('NaN'), `no NaN in: ${p}`);
  }
});
