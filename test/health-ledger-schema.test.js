'use strict';

// Health-ledger schema validator tests (C5 leaf).
// Pins the row schema on real-shape rows and asserts ITEM contents:
// itemType values, note field, and verdict.inputs shape.
//
// One mutation-style test per guard so removing it fails a test.
// Source file src/health-ledger-schema.js is NOT modified by this task.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateRow, TRIGGER_KINDS, HEALTH_LEDGER_ROW_SCHEMA } = require('../src/health-ledger-schema.js');

// ---------- Real-shape fixture ----------

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

// ---------- Positive assertions ----------

test('validateRow returns ok for a real-shape row', () => {
  const row = makeValidRow();
  const result = validateRow(row);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('items.released items must have item_id and cause (itemType)', () => {
  const row = makeValidRow();
  const result = validateRow(row);
  assert.equal(result.ok, true);
  // The schema defines itemType with required: ['item_id', 'cause']
  assert.ok(HEALTH_LEDGER_ROW_SCHEMA.fields.items.fields.released.itemType);
  assert.deepEqual(
    HEALTH_LEDGER_ROW_SCHEMA.fields.items.fields.released.itemType.required,
    ['item_id', 'cause']
  );
});

test('note field is accepted as string', () => {
  const row = makeValidRow();
  const result = validateRow(row);
  assert.equal(result.ok, true);
  // Schema declares note as optional string
  assert.equal(HEALTH_LEDGER_ROW_SCHEMA.fields.note.type, 'string');
  assert.equal(HEALTH_LEDGER_ROW_SCHEMA.fields.note.optional, true);
});

test('verdict.inputs must be an object (not array)', () => {
  const row = makeValidRow();
  const result = validateRow(row);
  assert.equal(result.ok, true);
  // Schema declares inputs as type: 'object'
  assert.equal(HEALTH_LEDGER_ROW_SCHEMA.fields.verdict.fields.inputs.type, 'object');
});

// ---------- Mutation-style tests (one per guard) ----------

test('guard: Array.isArray(obj) rejects array rows', () => {
  // Mutation: pass an array instead of an object
  const result = validateRow([{ ts: '2026-10-27T12:00:00Z' }]);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('non-null object')),
    `expected error mentioning "non-null object", got: ${JSON.stringify(result.errors)}`
  );
});

test('guard: TRIGGER_KINDS enum rejects unknown trigger.kind', () => {
  // Mutation: use an invalid trigger kind
  const row = makeValidRow({ trigger: { kind: 'unknown', detail: 'daily' } });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('trigger.kind must be one of')),
    `expected error about trigger.kind enum, got: ${JSON.stringify(result.errors)}`
  );
});

test('guard: verdict.inputs rejects array form', () => {
  // Mutation: pass inputs as an array (schema says object)
  const row = makeValidRow({ verdict: { value: 'yes', inputs: [{ id: 'a' }] } });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('verdict.inputs must be an object')),
    `expected error about inputs shape, got: ${JSON.stringify(result.errors)}`
  );
});

test('guard: itemType requires item_id in items', () => {
  // Mutation: remove item_id from an item
  const row = makeValidRow({
    items: {
      released: [{ cause: 'ok' }],
      held: [],
      filed: [],
    },
  });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('item_id')),
    `expected error about item_id, got: ${JSON.stringify(result.errors)}`
  );
});

test('guard: itemType requires cause in items', () => {
  // Mutation: remove cause from an item
  const row = makeValidRow({
    items: {
      released: [{ item_id: 'x' }],
      held: [],
      filed: [],
    },
  });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('cause')),
    `expected error about cause, got: ${JSON.stringify(result.errors)}`
  );
});

test('guard: note must be string if provided', () => {
  // Mutation: pass note as a number
  const row = makeValidRow({ note: 123 });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('note must be a string')),
    `expected error about note type, got: ${JSON.stringify(result.errors)}`
  );
});

test('guard: each items bucket must be an array (non-array bucket is rejected)', () => {
  for (const bucket of ['released', 'held', 'filed']) {
    const row = makeValidRow();
    row.items[bucket] = { item_id: 'x', cause: 'ok' };
    const result = validateRow(row);
    assert.equal(result.ok, false, bucket);
    assert.ok(result.errors.some((e) => e === `items.${bucket} must be an array`), `${bucket}: ${JSON.stringify(result.errors)}`);
  }
});

test('guard: each entry inside an items bucket must be an object (non-object entry is rejected)', () => {
  for (const bad of ['x', 7, null, ['x', 'ok']]) {
    const row = makeValidRow();
    row.items.held = [bad];
    const result = validateRow(row);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(result.errors.some((e) => e === 'items.held[0] must be an object'), `${JSON.stringify(bad)}: ${JSON.stringify(result.errors)}`);
  }
});

// ---------- Null acceptance / rejection tests ----------

test('null is accepted for metric.before (allowNull: true)', () => {
  const row = makeValidRow({ metric: { name: 'latency', before: null, after: 90 } });
  const result = validateRow(row);
  assert.equal(result.ok, true, `null for metric.before should be accepted, got errors: ${JSON.stringify(result.errors)}`);
});

test('null is accepted for metric.after (allowNull: true)', () => {
  const row = makeValidRow({ metric: { name: 'latency', before: 100, after: null } });
  const result = validateRow(row);
  assert.equal(result.ok, true, `null for metric.after should be accepted, got errors: ${JSON.stringify(result.errors)}`);
});

test('null is accepted for cost.gpu_minutes (allowNull: true)', () => {
  const row = makeValidRow({ cost: { gpu_minutes: null, peak_ram_mb: 2048, model_calls: 3 } });
  const result = validateRow(row);
  assert.equal(result.ok, true, `null for cost.gpu_minutes should be accepted, got errors: ${JSON.stringify(result.errors)}`);
});

test('null is accepted for cost.peak_ram_mb (allowNull: true)', () => {
  const row = makeValidRow({ cost: { gpu_minutes: 5, peak_ram_mb: null, model_calls: 3 } });
  const result = validateRow(row);
  assert.equal(result.ok, true, `null for cost.peak_ram_mb should be accepted, got errors: ${JSON.stringify(result.errors)}`);
});

test('null is rejected for cost.model_calls (no allowNull flag)', () => {
  const row = makeValidRow({ cost: { gpu_minutes: 5, peak_ram_mb: 2048, model_calls: null } });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('cost.model_calls')),
    `expected error mentioning "cost.model_calls", got: ${JSON.stringify(result.errors)}`
  );
});

test('string is rejected for metric.before (must be number or null)', () => {
  const row = makeValidRow({ metric: { name: 'latency', before: '100', after: 90 } });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('metric.before')),
    `expected error mentioning "metric.before", got: ${JSON.stringify(result.errors)}`
  );
});

test('boolean is rejected for metric.before (must be number or null)', () => {
  const row = makeValidRow({ metric: { name: 'latency', before: true, after: 90 } });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('metric.before')),
    `expected error mentioning "metric.before", got: ${JSON.stringify(result.errors)}`
  );
});

test('undefined is rejected for metric.before (must be number or null)', () => {
  const row = makeValidRow();
  delete row.metric.before;
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('metric.before')),
    `expected error mentioning "metric.before", got: ${JSON.stringify(result.errors)}`
  );
});

test('string is rejected for metric.after (must be number or null)', () => {
  const row = makeValidRow({ metric: { name: 'latency', before: 100, after: '90' } });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('metric.after')),
    `expected error mentioning "metric.after", got: ${JSON.stringify(result.errors)}`
  );
});

test('boolean is rejected for metric.after (must be number or null)', () => {
  const row = makeValidRow({ metric: { name: 'latency', before: 100, after: true } });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('metric.after')),
    `expected error mentioning "metric.after", got: ${JSON.stringify(result.errors)}`
  );
});

test('undefined is rejected for metric.after (must be number or null)', () => {
  const row = makeValidRow();
  delete row.metric.after;
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('metric.after')),
    `expected error mentioning "metric.after", got: ${JSON.stringify(result.errors)}`
  );
});

test('string is rejected for cost.gpu_minutes (must be number or null)', () => {
  const row = makeValidRow({ cost: { gpu_minutes: '5', peak_ram_mb: 2048, model_calls: 3 } });
  const result = validateRow(row);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('cost.gpu_minutes')),
    `expected error mentioning "cost.gpu_minutes", got: ${JSON.stringify(result.errors)}`
  );
});
