'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLayeredConfig } = require('./layered-config');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'layered-config-test-'));
}

function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function recordingLogger() {
  const calls = [];
  return { calls, warn: (msg) => calls.push(msg) };
}

test('missing required source throws an Error naming its path', () => {
  const missing = path.join(tmpDir(), 'nope.json');
  assert.throws(
    () => loadLayeredConfig([{ path: missing, required: true, layer: 'global' }]),
    (err) => err instanceof Error && err.message.includes(missing)
  );
});

test('malformed JSON required source throws naming its path', () => {
  const p = writeFile(tmpDir(), 'bad.json', '{not json');
  assert.throws(
    () => loadLayeredConfig([{ path: p, required: true, layer: 'project' }]),
    (err) => err instanceof Error && err.message.includes(p)
  );
});

test('required source failing validate throws naming its path', () => {
  const p = writeFile(tmpDir(), 'bad-schema.json', JSON.stringify({ x: 1 }));
  const validate = (obj) => {
    if (typeof obj.x !== 'string') throw new Error('x must be a string');
  };
  assert.throws(
    () => loadLayeredConfig([{ path: p, required: true, layer: 'project' }], { validate }),
    (err) => err instanceof Error && err.message.includes(p)
  );
});

test('missing optional source warns with path and returns {}', () => {
  const missing = path.join(tmpDir(), 'nope.json');
  const logger = recordingLogger();
  const out = loadLayeredConfig([{ path: missing, required: false, layer: 'global' }], { logger });
  assert.deepStrictEqual(out, {});
  assert.strictEqual(logger.calls.length, 1);
  assert.ok(logger.calls[0].includes(missing));
});

test('malformed optional source warns with path and returns {}', () => {
  const p = writeFile(tmpDir(), 'bad.json', '{not json');
  const logger = recordingLogger();
  const out = loadLayeredConfig([{ path: p, required: false, layer: 'project' }], { logger });
  assert.deepStrictEqual(out, {});
  assert.ok(logger.calls.length === 1 && logger.calls[0].includes(p));
});

test('schema-invalid optional source warns with path and returns {}', () => {
  const p = writeFile(tmpDir(), 'bad-schema.json', JSON.stringify({ x: 1 }));
  const logger = recordingLogger();
  const validate = () => false;
  const out = loadLayeredConfig([{ path: p, required: false, layer: 'override' }], { validate, logger });
  assert.deepStrictEqual(out, {});
  assert.ok(logger.calls.length === 1 && logger.calls[0].includes(p));
});

test('later source overrides an earlier key', () => {
  const dir = tmpDir();
  const a = writeFile(dir, 'a.json', JSON.stringify({ k: 'global', only_a: 1 }));
  const b = writeFile(dir, 'b.json', JSON.stringify({ k: 'project' }));
  const out = loadLayeredConfig([
    { path: a, required: true, layer: 'global' },
    { path: b, required: true, layer: 'project' },
  ]);
  assert.deepStrictEqual(out, { k: 'project', only_a: 1 });
});

test('unknown layer value is rejected', () => {
  const p = writeFile(tmpDir(), 'a.json', '{}');
  assert.throws(() => loadLayeredConfig([{ path: p, required: true, layer: 'bogus' }]), /unknown layer/);
});

test('default logger is console.warn', () => {
  const missing = path.join(tmpDir(), 'nope.json');
  const original = console.warn;
  const seen = [];
  console.warn = (msg) => seen.push(msg);
  try {
    const out = loadLayeredConfig([{ path: missing, required: false, layer: 'opencode' }]);
    assert.deepStrictEqual(out, {});
  } finally {
    console.warn = original;
  }
  assert.ok(seen.some((m) => String(m).includes(missing)));
});
