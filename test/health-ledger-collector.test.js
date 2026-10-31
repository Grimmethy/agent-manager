'use strict';

// Health-ledger collector guard tests (HUB0271 · 3/4).
// Verifies that schema.appendRow requires the date parameter in
// YYYY-MM-DD format and throws the expected error when it is missing.
//
// One guard test per parameter so removing it fails a test.
// Source file src/health-ledger-schema.js is NOT modified by this task.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { appendRow } = require('../src/health-ledger-schema.js');

// ---------- Fixture ----------

const pipelineDir = require('node:os').tmpdir() + '/test-pipeline';

function makeValidRow(overrides = {}) {
  return {
    ts: '2026-10-27T12:00:00Z',
    loop_id: 'loop-001',
    trigger: { kind: 'schedule', detail: 'daily' },
    verdict: { value: 'yes', inputs: { id: 'a', score: 1 } },
    items: {
      released: [{ item_id: 'x', cause: 'ok' }],
      held: [],
      filed: [],
    },
    metric: { name: 'latency', before: 100, after: 90 },
    cost: { gpu_minutes: 5, peak_ram_mb: 2048, model_calls: 3 },
    note: 'optional note',
    ...overrides,
  };
}

// ---------- Tests ----------

test('appendRow throws when date is missing', () => {
  assert.throws(
    () => appendRow(pipelineDir, undefined, makeValidRow()),
    { message: /appendRow: date \(YYYY-MM-DD\) is required/ }
  );
});

test('appendRow throws when date is empty string', () => {
  assert.throws(
    () => appendRow(pipelineDir, '', makeValidRow()),
    { message: /appendRow: date \(YYYY-MM-DD\) is required/ }
  );
});

test('appendRow throws when date is wrong type', () => {
  assert.throws(
    () => appendRow(pipelineDir, 20261027, makeValidRow()),
    { message: /appendRow: date \(YYYY-MM-DD\) is required/ }
  );
});

test('appendRow throws when date is malformed', () => {
  assert.throws(
    () => appendRow(pipelineDir, '2026/10/27', makeValidRow()),
    { message: /appendRow: date must be YYYY-MM-DD/ }
  );
});

test('appendRow succeeds with valid YYYY-MM-DD date', () => {
  const row = makeValidRow();
  const result = appendRow(pipelineDir, '2026-10-27', row);
  assert.ok(result);
});
