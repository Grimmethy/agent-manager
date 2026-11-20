'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { sanitizeNames, sanitizeDeep } = require('../src/name-sanitizer.js');
const { buildTaskLogRecord } = require('../src/task-log-store.js');

test('sanitizeNames strips surnames from both listed names', () => {
  assert.strictEqual(
    sanitizeNames('Natassa Gelinas and Scott Snofke'),
    'Natassa and Scott',
  );
});

test('sanitizeNames matches names split by extra whitespace or newlines', () => {
  assert.strictEqual(sanitizeNames('Natassa  Gelinas'), 'Natassa');
  assert.strictEqual(sanitizeNames('Scott\nSnofke'), 'Scott');
});

test('sanitizeNames returns text with no listed names byte-identical', () => {
  const text = 'Plain text with Gelinas alone and Other Person.';
  assert.strictEqual(sanitizeNames(text), text);
});

test('sanitizeNames passes non-strings through unchanged', () => {
  assert.strictEqual(sanitizeNames(null), null);
  assert.strictEqual(sanitizeNames(42), 42);
});

test('sanitizeDeep rewrites nested strings and leaves other values alone', () => {
  const input = {
    a: 'Natassa Gelinas',
    b: ['Scott Snofke', 3, null, true],
    c: { d: 'x Scott Snofke y' },
  };
  assert.deepStrictEqual(sanitizeDeep(input), {
    a: 'Natassa',
    b: ['Scott', 3, null, true],
    c: { d: 'x Scott y' },
  });
});

test('buildTaskLogRecord output contains no listed surnames', () => {
  const task = {
    id: 'test-sanitize-1',
    title: 'Note from Natassa Gelinas',
    domain: 'x',
    source: 'brain_dump',
    createdAt: '2026-01-01T00:00:00Z',
    history: [],
    promptContext: { rawText: 'Call Scott Snofke about it', fetchedFiles: ['big'] },
  };
  const json = JSON.stringify(buildTaskLogRecord(task));
  assert.ok(!json.includes('Gelinas'), 'Gelinas leaked');
  assert.ok(!json.includes('Snofke'), 'Snofke leaked');
  assert.ok(json.includes('Natassa'));
  assert.ok(json.includes('Scott'));
});
