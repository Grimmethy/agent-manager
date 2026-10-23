'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseChatCard, resolveChatCard, cardEnv } = require('./chat-card.js');

const HOST = 'http://localhost:11434';
const lanes = [
  { id: 'worker-3090', gpu: '3090', local: true, env: {} },
  { id: 'worker-p40', gpu: 'p40', local: false, env: { OLLAMA_URL: 'http://192.168.122.29:11434', LOCAL_MODEL: 'qwen-p40', AGENT_MANAGER_GPU_YIELD_APPS: 'comfyui' } },
  { id: 'worker-rx580', gpu: 'rx580', local: false, env: { OLLAMA_URL: 'http://100.96.112.78:11434', LOCAL_MODEL: 'qwen3-vl:8b-instruct', AGENT_MANAGER_LANE_NUM_CTX: '16384', AGENT_MANAGER_LANE_NUM_BATCH: '1024' } },
];
const heldSet = (...urls) => (url) => urls.includes(url);
const choose = (preferred, isHeld) => chooseChatCard({ lanes, preferred, hostUrl: HOST, isHeld });

test('nothing held, no preference: the host lane, no move, empty env', () => {
  const r = choose('', heldSet());
  assert.deepEqual(r, { lane: 'worker-3090', local: true, lockKey: 'ollama-localhost-11434', env: {}, moved: false, from: null, blocked: false, note: '' });
});

test('manual pick that is free is used first, with the lane env but only the chat keys', () => {
  const r = choose('worker-rx580', heldSet());
  assert.equal(r.lane, 'worker-rx580');
  assert.equal(r.moved, false);
  assert.deepEqual(r.env, { OLLAMA_URL: 'http://100.96.112.78:11434', LOCAL_MODEL: 'qwen3-vl:8b-instruct', AGENT_MANAGER_LANE_NUM_CTX: '16384', AGENT_MANAGER_LANE_NUM_BATCH: '1024' });
  assert.equal('AGENT_MANAGER_GPU_YIELD_APPS' in choose('worker-p40', heldSet()).env, false);
});

test('the Forge holds the host card: chat moves to the next lane and says so', () => {
  const r = choose('', heldSet(HOST));
  assert.equal(r.lane, 'worker-p40');
  assert.equal(r.moved, true);
  assert.equal(r.from, 'worker-3090');
  assert.match(r.note, /Forge is using 3090.*runs on p40/);
});

test('the choice carries the arbiter key of the card endpoint and whether it is the host lane', () => {
  const r = choose('worker-rx580', heldSet());
  assert.equal(r.lockKey, 'ollama-100.96.112.78-11434');
  assert.equal(r.local, false);
  const moved = choose('', heldSet(HOST));
  assert.equal(moved.lockKey, 'ollama-192.168.122.29-11434');
  assert.equal(moved.local, false);
});

test('a held manual pick falls back to the host lane first, then the rest', () => {
  assert.equal(choose('worker-rx580', heldSet('http://100.96.112.78:11434')).lane, 'worker-3090');
  const r = choose('worker-rx580', heldSet('http://100.96.112.78:11434', HOST));
  assert.equal(r.lane, 'worker-p40');
  assert.equal(r.from, 'worker-rx580');
});

test('every card held: blocked, no lane, a plain note', () => {
  const r = choose('', heldSet(HOST, 'http://192.168.122.29:11434', 'http://100.96.112.78:11434'));
  assert.equal(r.blocked, true);
  assert.equal(r.lane, null);
  assert.match(r.note, /Every GPU card is held/);
});

test('unknown card is refused, listing the real ones', () => {
  const r = choose('worker-9999', heldSet());
  assert.equal(r.blocked, true);
  assert.match(r.note, /Unknown card "worker-9999".*worker-3090, worker-p40, worker-rx580/);
});

test('no lanes at all is blocked, not a crash', () => {
  const r = chooseChatCard({ lanes: [], preferred: '', hostUrl: HOST, isHeld: heldSet() });
  assert.equal(r.blocked, true);
  assert.equal(r.lane, null);
});

test('cardEnv ignores keys outside the chat set', () => {
  assert.deepEqual(cardEnv({ env: { OLLAMA_URL: 'u', FOO: 'x', LOCAL_MODEL: '' } }), { OLLAMA_URL: 'u' });
});

test('resolveChatCard uses the injected lanes and lease check and the env host url', () => {
  const r = resolveChatCard('', { OLLAMA_URL: 'http://localhost:11434' }, { getLanes: () => lanes, isHeld: heldSet('http://localhost:11434') });
  assert.equal(r.lane, 'worker-p40');
});
