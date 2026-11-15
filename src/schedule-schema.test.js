'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateEntry, validateCadence } = require('./schedule-schema.js');

function readFixture(name) {
  return fs.readFileSync(
    path.join(__dirname, '..', 'test', 'fixtures', 'schedule', name),
    'utf8'
  );
}

function cadenceAt(time, days = ['mon']) {
  return { time, days };
}

test('exports exactly validateEntry and validateCadence', () => {
  const mod = require('./schedule-schema.js');
  assert.deepEqual(Object.keys(mod).sort(), ['validateCadence', 'validateEntry']);
});

test('time boundaries: 00:00 and 23:59 pass', () => {
  assert.deepEqual(validateCadence(cadenceAt('00:00'), 0), { ok: true });
  assert.deepEqual(validateCadence(cadenceAt('23:59'), 0), { ok: true });
});

test('time rejects 24:00, 23:60, 9:00, 12:5', () => {
  for (const bad of ['24:00', '23:60', '9:00', '12:5']) {
    const result = validateCadence(cadenceAt(bad), 0);
    assert.equal(result.ok, false, `expected ${bad} to fail`);
    assert.ok(result.errors.some((e) => e.includes(bad)));
  }
});

test('weekdays: all seven valid values pass', () => {
  for (const day of ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) {
    assert.deepEqual(validateCadence(cadenceAt('09:00', [day]), 0), { ok: true });
  }
});

test('weekdays: xyz, Mon, and empty array fail', () => {
  assert.equal(validateCadence(cadenceAt('09:00', ['xyz']), 0).ok, false);
  assert.equal(validateCadence(cadenceAt('09:00', ['Mon']), 0).ok, false);
  assert.equal(validateCadence(cadenceAt('09:00', []), 0).ok, false);
});

test('validateCadence rejects non-object cadence', () => {
  assert.equal(validateCadence(null, 0).ok, false);
  assert.equal(validateCadence('09:00', 0).ok, false);
});

test('validateEntry accepts a well-formed entry', () => {
  const entry = { id: 'a', cadence: cadenceAt('09:00'), replaceWith: 'x' };
  assert.deepEqual(validateEntry(entry, 0), { ok: true });
});

test('validateEntry rejects non-object entry', () => {
  assert.equal(validateEntry(null, 0).ok, false);
  assert.equal(validateEntry([], 0).ok, false);
});

test('validateEntry reports missing replaceWith by name', () => {
  const entries = JSON.parse(readFixture('missing-replaceWith.json'));
  const result = validateEntry(entries[0], 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('replaceWith')));
});

test('validateEntry detects unknown top-level key', () => {
  const entries = JSON.parse(readFixture('unknown-key.json'));
  const result = validateEntry(entries[0], 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('unknown') && e.includes('extra')));
});

test('bad-hhmm fixture fails cadence time validation', () => {
  const entries = JSON.parse(readFixture('bad-hhmm.json'));
  const result = validateEntry(entries[0], 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('24:00')));
});

test('duplicate-id fixture: each entry passes individually', () => {
  // Duplicate-id detection is deferred to the schedule loader (sibling 2/2).
  const entries = JSON.parse(readFixture('duplicate-id.json'));
  entries.forEach((entry, i) => {
    assert.deepEqual(validateEntry(entry, i), { ok: true });
  });
});

test('valid fixture: both entries pass', () => {
  const entries = JSON.parse(readFixture('valid.json'));
  assert.equal(entries.length, 2);
  entries.forEach((entry, i) => {
    assert.deepEqual(validateEntry(entry, i), { ok: true });
  });
});

test('invalid-json fixture fails JSON.parse', () => {
  assert.throws(() => JSON.parse(readFixture('invalid-json.json.txt')));
});
