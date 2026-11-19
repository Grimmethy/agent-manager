'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  registerPreDispatchGates,
  getPreDispatchGate,
  clearPreDispatchGateRegistry,
  consultPreDispatchGate,
} = require('./pre-dispatch-gate-registry.js');

// Runs first in this file, before anything registers: module import must leave the registry empty.
test('import performs no registration', () => {
  assert.equal(getPreDispatchGate('sequential-await-in-loop'), undefined);
  assert.equal(getPreDispatchGate('sync-io-in-loop'), undefined);
});

test('registerPreDispatchGates is idempotent', () => {
  clearPreDispatchGateRegistry();
  registerPreDispatchGates();
  registerPreDispatchGates();
  assert.equal(typeof getPreDispatchGate('sequential-await-in-loop'), 'function');
  assert.equal(typeof getPreDispatchGate('sync-io-in-loop'), 'function');
});

describe('gates after registration', () => {
  beforeEach(() => {
    clearPreDispatchGateRegistry();
    registerPreDispatchGates();
  });

  // Case A: hot-path sync I/O in a loop, where the snippet also matches the startup scope.
  // The hot-path check must win, so the case is NOT dismissed.
  test('case A: hot-path sync-io in loop with startup-named function is not archived', () => {
    const snippet = 'function setupHandler(req, res) { for (let i = 0; i < 3; i++) { fs.readFileSync(p); } }';
    const rec = consultPreDispatchGate('sync-io-in-loop', snippet, { file: 'a.js', line: 4 });
    assert.equal(rec.verdict, 'investigate');
    assert.notEqual(rec.verdict, 'archive');
  });

  // Case B: sequential await with no loop header. Must not be dismissed.
  test('case B: sequential await without a loop header is not archived', () => {
    const snippet = 'const x = await fetchOne(item);';
    const rec = consultPreDispatchGate('sequential-await-in-loop', snippet, { file: 'b.js', line: 9 });
    assert.equal(rec.verdict, 'investigate');
    assert.notEqual(rec.verdict, 'archive');
  });

  // Case C: the same ruleId in two files yields a record for each file; neither suppresses the other.
  test('case C: same ruleId in different files each gets its own result', () => {
    const hot = 'function handler(req) { for (let i = 0; i < 3; i++) { fs.readFileSync(p); } }';
    const safe = 'function main() { for (let i = 0; i < 3; i++) { fs.readFileSync(p); } }';
    const r1 = consultPreDispatchGate('sync-io-in-loop', hot, { file: 'x.js', line: 1 });
    const r2 = consultPreDispatchGate('sync-io-in-loop', safe, { file: 'y.js', line: 2 });
    assert.equal(r1.verdict, 'investigate');
    assert.equal(r1.file, 'x.js');
    assert.equal(r2.verdict, 'archive');
    assert.equal(r2.file, 'y.js');
  });

  // Dismissal record: every result carries exactly the five fields.
  test('dismissal record has exactly {verdict, ruleId, file, line, reason}', () => {
    const snippet = 'function main() { for (let i = 0; i < 3; i++) { fs.readFileSync(p); } }';
    const rec = consultPreDispatchGate('sync-io-in-loop', snippet, { file: 'z.js', line: 7 });
    assert.deepEqual(Object.keys(rec).sort(), ['file', 'line', 'reason', 'ruleId', 'verdict']);
    assert.deepEqual(rec, {
      verdict: 'archive',
      ruleId: 'sync-io-in-loop',
      file: 'z.js',
      line: 7,
      reason: 'Bounded (<=10) loop in startup/initialization scope: one-time bounded work, not a hot-path violation',
    });
  });
});

test('consult returns null for an unregistered rule', () => {
  clearPreDispatchGateRegistry();
  assert.equal(consultPreDispatchGate('sync-io-in-loop', 'for (;;) {}', { file: 'q.js', line: 1 }), null);
});
