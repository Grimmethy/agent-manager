'use strict';

// tryPreDispatchGate's serial-intent check for the sequential-await-in-loop rule (brain dump #1661). Run: node --test src/local-draft-serial-intent-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { tryPreDispatchGate } = require('./local-draft.js');

const RETRY = 'for (let attempt = 0; attempt < 3; attempt++) {\n  const r = await call(opts);\n  if (r.ok) break;\n}';
const INDEPENDENT = 'for (const u of urls) {\n  const r = await fetch(u);\n  out.push(r);\n}';
const task = (snippet, rule = 'sequential-await-in-loop') => ({ id: 't', history: [], promptContext: { rule, snippet } });

function withMode(mode, fn) {
  const prev = process.env.AGENT_MANAGER_SEQ_AWAIT_INTENT_GATE;
  if (mode === undefined) delete process.env.AGENT_MANAGER_SEQ_AWAIT_INTENT_GATE; else process.env.AGENT_MANAGER_SEQ_AWAIT_INTENT_GATE = mode;
  try { return fn(); } finally { if (prev === undefined) delete process.env.AGENT_MANAGER_SEQ_AWAIT_INTENT_GATE; else process.env.AGENT_MANAGER_SEQ_AWAIT_INTENT_GATE = prev; }
}

test('by default (and in shadow mode) a serial-by-design finding keeps drafting but leaves an audit event saying what the gate WOULD have done', () => {
  for (const mode of [undefined, 'shadow', 'whatever-unknown']) {
    const t = task(RETRY);
    assert.equal(withMode(mode, () => tryPreDispatchGate(t)), null, `mode ${mode}`);
    assert.equal(t.history.length, 1, `mode ${mode}`);
    assert.equal(t.history[0].stage, 'pre-dispatch-gate-shadow');
    assert.match(t.history[0].detail, /would be archived: the await in this loop is serial by design \(retry-loop, early-exit-after-await\) -- shadow mode, drafting continues/);
  }
});

test('in "on" mode it archives, and the reason names the evidence', () => {
  const t = task(RETRY);
  const hit = withMode('on', () => tryPreDispatchGate(t));
  assert.deepEqual(hit, { ruleId: 'sequential-await-in-loop', status: 'archived', reason: 'the await in this loop is serial by design (retry-loop, early-exit-after-await)' });
  assert.deepEqual(t.history, [], 'draftTask writes the audit line for an archive; the gate adds no shadow event');
});

test('in "off" mode (also "false") it does nothing at all', () => {
  for (const mode of ['off', 'false', 'OFF']) {
    const t = task(RETRY);
    assert.equal(withMode(mode, () => tryPreDispatchGate(t)), null);
    assert.deepEqual(t.history, []);
  }
});

test('a plain independent loop is never archived or even noted, in any mode', () => {
  for (const mode of [undefined, 'shadow', 'on', 'off']) {
    const t = task(INDEPENDENT);
    assert.equal(withMode(mode, () => tryPreDispatchGate(t)), null, `mode ${mode}`);
    assert.deepEqual(t.history, [], `mode ${mode}`);
  }
});

test('the existing fan-out and no-await archives still apply regardless of the new mode, and other rules are untouched', () => {
  const fanOut = 'const rs = await Promise.all(items.map(async (i) => { for (const j of i) { await f(j); } }));';
  for (const mode of [undefined, 'on', 'off']) {
    assert.equal(withMode(mode, () => tryPreDispatchGate(task(fanOut)))?.status, 'archived', `mode ${mode}`);
  }
  // a rule with no registered gate falls straight through even if its snippet looks serial
  const other = task(RETRY, 'some-other-rule');
  assert.equal(withMode('on', () => tryPreDispatchGate(other)), null);
  assert.deepEqual(other.history, []);
  // ... and so does a rule that HAS a gate answering 'investigate': the serial-intent check belongs to the sequential-await rule only
  const { registerPreDispatchGate } = require('./deterministic-recheck-registry.js');
  registerPreDispatchGate('test-only-investigate-rule', () => ({ verdict: 'investigate', reason: 'always' }));
  for (const mode of [undefined, 'shadow', 'on']) {
    const gated = task(RETRY, 'test-only-investigate-rule');
    assert.equal(withMode(mode, () => tryPreDispatchGate(gated)), null, `mode ${mode}`);
    assert.deepEqual(gated.history, [], `mode ${mode}`);
  }
});

test('missing or malformed finding data falls through without error', () => {
  for (const t of [null, undefined, {}, { promptContext: null }, { promptContext: { rule: 'sequential-await-in-loop' } }, { promptContext: { rule: 'sequential-await-in-loop', snippet: '' } }, { promptContext: { snippet: RETRY } }]) {
    assert.equal(withMode('on', () => tryPreDispatchGate(t)), null);
  }
});
