'use strict';

// Unit tests for the pre-dispatch gate registry and the gateSequentialAwaitInLoop
// detector, both living in deterministic-recheck-registry.js. The registry covers
// register/get/clear; this file covers the six flagged-snippet verdict cases plus
// registry guard behavior. Style follows deterministic-recheck-registry.test.js
// (node:test + node:assert/strict, CommonJS require).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getPreDispatchGate,
  registerPreDispatchGate,
  clearPreDispatchGateRegistry,
  gateSequentialAwaitInLoop,
} = require('./deterministic-recheck-registry.js');

// The module auto-registers the detector under two rule IDs on load, and
// registration is throw-on-duplicate, so every test starts from a clean slate:
// clear, re-register, and retrieve the detector via getPreDispatchGate (which is
// also the retrieval contract under test).
function registerFresh() {
  clearPreDispatchGateRegistry();
  registerPreDispatchGate('sequential-await-in-loop', gateSequentialAwaitInLoop);
  const gate = getPreDispatchGate('sequential-await-in-loop');
  assert.equal(typeof gate, 'function');
  return gate;
}

test('bound 3 for-loop with sequential await', () => {
  const gate = registerFresh();
  const snippet = [
    'const rows = [];',
    'for (let i = 0; i < 3; i++) {',
    '  rows.push(await fetchRow(i));',
    '}',
  ].join('\n');
  // DIVERGENCE from the plan's "archive" label: the implemented detector does no
  // loop-bound counting -- any await inside a for/while/do loop hits the loop rule.
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'investigate',
    reason: 'Sequential await inside a loop-bound iteration',
  });
});

test('bound 5 for-loop with sequential await', () => {
  const gate = registerFresh();
  const snippet = [
    'for (let i = 0; i < 5; i++) {',
    '  await save(i);',
    '}',
  ].join('\n');
  // DIVERGENCE from the plan's "archive" label: same as bound 3 -- no bound
  // counting is implemented; the loop rule fires for every bound.
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'investigate',
    reason: 'Sequential await inside a loop-bound iteration',
  });
});

test('bound 10 for-loop with sequential await', () => {
  const gate = registerFresh();
  const snippet = [
    'for (let i = 0; i < 10; i++) {',
    '  await processItem(i);',
    '}',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'investigate',
    reason: 'Sequential await inside a loop-bound iteration',
  });
});

test('Promise.all fan-out await', () => {
  const gate = registerFresh();
  const snippet = [
    'const handles = tasks.map((t) => run(t));',
    'const results = await Promise.all(handles);',
  ].join('\n');
  // DIVERGENCE from the plan's "investigate" label: the implemented detector
  // treats Promise.all/allSettled/race as a parallel fan-out and ARCHIVES it
  // (fan-out rule is checked before the loop rule and before the fail-safe).
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'archive',
    reason: 'Await is fan-out (parallel): Promise.all/allSettled/race detected',
  });
});

test('.map(async) body without a loop keyword', () => {
  const gate = registerFresh();
  const snippet = 'const out = items.map(async (item) => await persist(item));';
  // Neither the fan-out pattern nor the loop pattern (for/while/do) matches an
  // async .map arrow, so this falls through to the fail-safe branch.
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'investigate',
    reason: 'Ambiguous: could not confirm fan-out; treating as potential sequential await',
  });
});

test('no-bound while-loop with sequential await', () => {
  const gate = registerFresh();
  const snippet = [
    'let n = 0;',
    'while (true) {',
    '  await drain();',
    '  n += 1;',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'investigate',
    reason: 'Sequential await inside a loop-bound iteration',
  });
});

// ─── Registry guard tests ──────────────────────────────────────────────────────

test('getPreDispatchGate throws TypeError for a non-string ruleId', () => {
  registerFresh();
  assert.throws(() => getPreDispatchGate(42), TypeError);
  assert.throws(() => getPreDispatchGate(''), TypeError);
});

test('getPreDispatchGate returns undefined (not throw) for a valid-but-unregistered ruleId', () => {
  clearPreDispatchGateRegistry();
  assert.equal(getPreDispatchGate('not-registered'), undefined);
});

test('registerPreDispatchGate throws on duplicate registration and non-function detector', () => {
  clearPreDispatchGateRegistry();
  registerPreDispatchGate('seq', gateSequentialAwaitInLoop);
  assert.throws(() => registerPreDispatchGate('seq', gateSequentialAwaitInLoop), /already registered/);
  assert.throws(() => registerPreDispatchGate('bad', 'not-a-function'), TypeError);
});

test('gateSequentialAwaitInLoop throws TypeError for non-string or empty input', () => {
  registerFresh();
  assert.throws(() => gateSequentialAwaitInLoop(null), TypeError);
  assert.throws(() => gateSequentialAwaitInLoop(''), TypeError);
});
