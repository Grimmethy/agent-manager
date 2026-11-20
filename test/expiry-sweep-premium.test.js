'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweepExpiry } = require('../src/expiry-sweep.js');

const PREMIUM = { premiumPriority: 'high', premiumSetBy: 'human', premiumSetAt: '2026-11-01T00:00:00.000Z' };
const NAME = 'change-review-abc.json';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expiry-premium-'));
  fs.mkdirSync(path.join(dir, 'queue', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'pending', NAME), JSON.stringify({
    id: 'change-review-abc', source: 'test-src', title: 't', status: 'pending', history: [], ...PREMIUM,
  }));
  return dir;
}

function source(action) {
  return {
    name: 'test-src',
    expiry: {
      idPrefixes: ['change-review-'],
      findExpired: ({ tasks }) => tasks.map((t) => ({ id: t.id, action, reason: 'stale' })),
    },
  };
}

function assertPremium(dest) {
  for (const k of Object.keys(PREMIUM)) assert.equal(dest[k], PREMIUM[k], `${k} mismatch`);
}

test('archive move keeps premium fields', () => {
  const dir = setup();
  const summary = sweepExpiry({ pipelineDir: dir, sources: [source('archive')], force: true });
  assert.equal(summary.archived, 1);
  const dest = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', '_archived_no_action', NAME), 'utf8'));
  assertPremium(dest);
});

test('apply move keeps premium fields', () => {
  const dir = setup();
  const summary = sweepExpiry({ pipelineDir: dir, sources: [source('apply')], force: true });
  assert.equal(summary.released, 1);
  const dest = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'approved', NAME), 'utf8'));
  assert.equal(dest.status, 'approved');
  assertPremium(dest);
});
