'use strict';

// Health-ledger collector guard tests (HUB0271 · 3/4).
// Verifies that schema.appendRow requires the date parameter in
// YYYY-MM-DD format and throws the expected error when it is missing.
//
// One guard test per parameter so removing it fails a test.
// Source file src/health-ledger-schema.js is NOT modified by this task.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendRow, rowPath } = require('../src/health-ledger-schema.js');
const { collect } = require('../src/health-ledger-collector.js');

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

// ---------- collect() writes today's row under today's date (HUB0271 · 5/5) ----------
// These call the collector itself, so a collector that passes no date, a fixed date or swallows the schema error fails here.

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-ledger-collector-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('collect writes the row as one line in the file for the given UTC day', () => {
  withTmpDir((dir) => {
    const row = makeValidRow();
    const file = collect(dir, row, { now: Date.UTC(2026, 9, 27, 12) });
    assert.equal(file, rowPath(dir, '2026-10-27'));
    assert.deepEqual(readLines(file), [row]);
  });
});

test('collect on the same day appends a second line instead of rewriting', () => {
  withTmpDir((dir) => {
    const now = Date.UTC(2026, 9, 27, 3);
    collect(dir, makeValidRow({ note: 'first' }), { now });
    const file = collect(dir, makeValidRow({ note: 'second' }), { now: Date.UTC(2026, 9, 27, 23) });
    assert.deepEqual(readLines(file).map((r) => r.note), ['first', 'second']);
  });
});

test('collect on the next UTC day writes a different file', () => {
  withTmpDir((dir) => {
    const a = collect(dir, makeValidRow(), { now: Date.UTC(2026, 9, 27, 23, 59) });
    const b = collect(dir, makeValidRow(), { now: Date.UTC(2026, 9, 28, 0, 1) });
    assert.notEqual(a, b);
    assert.equal(b, rowPath(dir, '2026-10-28'));
    assert.equal(readLines(a).length, 1);
    assert.equal(readLines(b).length, 1);
  });
});

test('collect throws the schema invalid-row error for a bad row and writes no file', () => {
  withTmpDir((dir) => {
    assert.throws(() => collect(dir, makeValidRow({ verdict: 'nope' }), { now: Date.UTC(2026, 9, 27) }), { message: /appendRow: invalid row/ });
    assert.equal(fs.existsSync(rowPath(dir, '2026-10-27')), false);
  });
});
