'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolLoopGuard } = require('./tool-loop-guard.js');

const OK = { verdict: 'ok', layer: null, count: 0, reason: '' };

function obs(g, tool, args, atMs) {
  return g.observe({ tool, args, resultText: '', atMs });
}

function withEnv(value, fn) {
  const prev = process.env.AGENT_MANAGER_CHAT_LOOP_GUARD;
  if (value === undefined) delete process.env.AGENT_MANAGER_CHAT_LOOP_GUARD;
  else process.env.AGENT_MANAGER_CHAT_LOOP_GUARD = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_CHAT_LOOP_GUARD;
    else process.env.AGENT_MANAGER_CHAT_LOOP_GUARD = prev;
  }
}

function fourIdentical(g) {
  let r;
  for (let i = 0; i < 4; i++) r = obs(g, 'read', { p: 'a' });
  return r;
}

// --- Layer 1: consecutive identical ---

test('layer1: 4 identical calls trigger suspect on the 4th', () => {
  const g = createToolLoopGuard({ enabled: true });
  for (let i = 0; i < 3; i++) assert.deepEqual(obs(g, 'read', { p: 'a' }), OK);
  const r = obs(g, 'read', { p: 'a' });
  assert.equal(r.verdict, 'suspect');
  assert.equal(r.layer, 1);
  assert.equal(r.count, 4);
  assert.ok(r.reason.length > 0);
});

test('layer1: reset on a different tool (A, A, B returns exact ok shape)', () => {
  const g = createToolLoopGuard({ enabled: true });
  obs(g, 'read', { p: 'a' });
  obs(g, 'read', { p: 'a' });
  assert.deepEqual(obs(g, 'write', { p: 'b' }), OK);
});

// --- Layer 2: input diversity ---

test('layer2: one tool 6 times in last 12 with one distinct input triggers on the 12th call', () => {
  const g = createToolLoopGuard({ enabled: true });
  let r;
  // 12 calls: grep x6 (identical args) interleaved with other x6 (distinct args).
  for (let i = 0; i < 12; i++) {
    r = i % 2 === 0 ? obs(g, 'grep', { q: 'x' }) : obs(g, 'other', { n: i });
    if (i < 11) assert.deepEqual(r, OK);
  }
  assert.equal(r.verdict, 'suspect');
  assert.equal(r.layer, 2);
  assert.equal(r.count, 6);
});

test('layer2 non-trigger: 12 distinct tools never trigger', () => {
  const g = createToolLoopGuard({ enabled: true });
  for (let i = 0; i < 12; i++) assert.deepEqual(obs(g, 't' + i, {}), OK);
});

// --- Layer 3: rotation ---

test('layer3: A,B repeated 4 times triggers on the 8th call', () => {
  const g = createToolLoopGuard({ enabled: true });
  for (let i = 0; i < 7; i++) assert.deepEqual(obs(g, i % 2 === 0 ? 'a' : 'b', {}), OK);
  const r = obs(g, 'b', {});
  assert.equal(r.verdict, 'suspect');
  assert.equal(r.layer, 3);
  assert.equal(r.count, 4);
});

test('layer3 non-trigger: 8 distinct calls never rotate', () => {
  const g = createToolLoopGuard({ enabled: true });
  for (let i = 0; i < 8; i++) assert.deepEqual(obs(g, 't' + i, {}), OK);
});

// --- Layer 4: long read window ---

test('layer4: 117 of 128 calls on one input triggers on the 128th call', () => {
  const g = createToolLoopGuard({ enabled: true, layer1_consecutive: 1000, layer2_threshold: 0, layer3_threshold: 1000 });
  let r;
  for (let i = 0; i < 128; i++) {
    r = obs(g, 'read', i % 12 === 0 ? { n: i } : { n: 'same' });
    if (i < 127) assert.deepEqual(r, OK);
  }
  assert.equal(r.verdict, 'suspect');
  assert.equal(r.layer, 4);
  assert.equal(r.count, 117);
});

test('layer4 non-trigger: 128 distinct inputs never trigger', () => {
  const g = createToolLoopGuard({ enabled: true });
  for (let i = 0; i < 128; i++) assert.deepEqual(obs(g, 'read', { n: i }), OK);
});

// --- Polling detection ---

test('polling: regular spacing of an identical run is flagged in the layer 1 reason', () => {
  const g = createToolLoopGuard({ enabled: true });
  let r;
  for (let i = 0; i < 4; i++) r = obs(g, 'read', { p: 'a' }, i * 1000);
  assert.equal(r.verdict, 'suspect');
  assert.equal(r.layer, 1);
  assert.ok(r.reason.includes('polling'));
});

test('polling: irregular spacing still triggers layer 1 but not the polling reason', () => {
  const g = createToolLoopGuard({ enabled: true });
  const times = [0, 1000, 1500, 9000];
  let r;
  for (let i = 0; i < 4; i++) r = obs(g, 'read', { p: 'a' }, times[i]);
  assert.equal(r.verdict, 'suspect');
  assert.equal(r.layer, 1);
  assert.ok(!r.reason.includes('polling'));
});

// --- Escalation ---

test('escalation: suspect, then stop on the next detection, then ok clears and re-suspects', () => {
  const g = createToolLoopGuard({ enabled: true });
  for (let i = 0; i < 3; i++) obs(g, 'read', { p: 'a' });
  const s = obs(g, 'read', { p: 'a' });
  assert.equal(s.verdict, 'suspect');
  const st = obs(g, 'read', { p: 'a' });
  assert.equal(st.verdict, 'stop');
  assert.equal(st.layer, 1);
  assert.equal(st.count, 5);
  assert.deepEqual(obs(g, 'write', { p: 'b' }), OK);
  for (let i = 0; i < 3; i++) assert.deepEqual(obs(g, 'read', { p: 'a' }), OK);
  const again = obs(g, 'read', { p: 'a' });
  assert.equal(again.verdict, 'suspect');
  assert.equal(again.layer, 1);
});

// --- Option overrides ---

test('override: layer1_consecutive 2 fires on the second identical call', () => {
  const g = createToolLoopGuard({ enabled: true, layer1_consecutive: 2 });
  assert.deepEqual(obs(g, 'read', { p: 'a' }), OK);
  const r = obs(g, 'read', { p: 'a' });
  assert.equal(r.verdict, 'suspect');
  assert.equal(r.layer, 1);
  assert.equal(r.count, 2);
});

test('override: layer1_consecutive 3 fires on the third identical call', () => {
  const g = createToolLoopGuard({ enabled: true, layer1_consecutive: 3 });
  obs(g, 'read', { p: 'a' });
  assert.deepEqual(obs(g, 'read', { p: 'a' }), OK);
  const r = obs(g, 'read', { p: 'a' });
  assert.equal(r.layer, 1);
  assert.equal(r.count, 3);
});

test('override: layer2_window 6 fires on the 6th call', () => {
  const g = createToolLoopGuard({ enabled: true, layer2_window: 6 });
  let r;
  for (let i = 0; i < 6; i++) {
    r = obs(g, i % 2 === 0 ? 'grep' : 'other', i % 2 === 0 ? { q: 'x' } : { n: i });
    if (i < 5) assert.deepEqual(r, OK);
  }
  assert.equal(r.verdict, 'suspect');
  assert.equal(r.layer, 2);
  assert.equal(r.count, 3);
});

test('override: layer2_threshold 0 disables the input-diversity layer', () => {
  const g = createToolLoopGuard({ enabled: true, layer2_threshold: 0 });
  let r;
  for (let i = 0; i < 12; i++) {
    r = obs(g, i % 2 === 0 ? 'grep' : 'other', i % 2 === 0 ? { q: 'x' } : { n: i });
  }
  assert.deepEqual(r, OK);
});

// --- Env gate and enable/disable ---

test('env gate: chat source with env unset is enabled', () => {
  withEnv(undefined, () => {
    const g = createToolLoopGuard({ source: 'chat' });
    const r = fourIdentical(g);
    assert.equal(r.verdict, 'suspect');
    assert.equal(r.layer, 1);
  });
});

test('env gate: chat source with env on is enabled', () => {
  withEnv('on', () => {
    const g = createToolLoopGuard({ source: 'chat' });
    assert.equal(fourIdentical(g).verdict, 'suspect');
  });
});

test('env gate: chat source with env off is disabled', () => {
  withEnv('off', () => {
    const g = createToolLoopGuard({ source: 'chat' });
    assert.deepEqual(fourIdentical(g), OK);
  });
});

test('env gate: options.enabled true overrides env off', () => {
  withEnv('off', () => {
    const g = createToolLoopGuard({ source: 'chat', enabled: true });
    assert.equal(fourIdentical(g).verdict, 'suspect');
  });
});

test('env gate: non-chat source is disabled by default', () => {
  withEnv(undefined, () => {
    const g = createToolLoopGuard({ source: 'cli' });
    assert.deepEqual(fourIdentical(g), OK);
  });
});

test('disabled guard returns ok for four identical calls and records nothing', () => {
  const g = createToolLoopGuard({ enabled: false });
  assert.deepEqual(fourIdentical(g), OK);
});
