'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chooseChatCard, resolveChatCard, resolveChatCardWithPreference, chatCardPreference, brokerUrl, cardEnv } = require('./chat-card.js');

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

// ---- the owner's chat-card preference from the GPU broker
function withBroker(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      try { await fn(`http://127.0.0.1:${server.address().port}`); resolve(); } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const gl = () => lanes;

test('brokerUrl: GPU_BROKER_URL, then AGENT_MANAGER_GPU_BROKER_URL, else the broker default port', () => {
  assert.equal(brokerUrl({}), 'http://localhost:7449');
  assert.equal(brokerUrl({ AGENT_MANAGER_GPU_BROKER_URL: 'http://b:1/' }), 'http://b:1');
  assert.equal(brokerUrl({ GPU_BROKER_URL: 'http://a:2', AGENT_MANAGER_GPU_BROKER_URL: 'http://b:1' }), 'http://a:2');
});

test('the broker chatCard preference becomes the lane id, asked over HTTP', async () => {
  let path;
  await withBroker((req, res) => { path = req.url; json(res, 200, { forgeCard: null, chatCard: 'rx580' }); }, async (url) => {
    assert.equal(await chatCardPreference({ GPU_BROKER_URL: url }, { getLanes: gl }), 'worker-rx580');
  });
  assert.equal(path, '/api/gpu/preferences');
});

test('no preference, a card that is not a lane here, a bad answer, an error status or no broker all mean none', async () => {
  for (const [status, body] of [[200, { chatCard: null }], [200, { chatCard: 'gone' }], [200, { chatCard: '../x' }], [200, 'junk'], [500, { chatCard: 'rx580' }]]) {
    await withBroker((req, res) => json(res, status, body), async (url) => {
      assert.equal(await chatCardPreference({ GPU_BROKER_URL: url }, { getLanes: gl }), '', JSON.stringify([status, body]));
    });
  }
  assert.equal(await chatCardPreference({ GPU_BROKER_URL: 'http://127.0.0.1:9' }, { getLanes: gl }), '');
});

test('a hung broker is given up on after the timeout', async () => {
  await withBroker(() => { /* never answers */ }, async (url) => {
    const t0 = Date.now();
    assert.equal(await chatCardPreference({ GPU_BROKER_URL: url }, { getLanes: gl, timeoutMs: 150 }), '');
    assert.ok(Date.now() - t0 < 2000);
  });
});

test('resolveChatCardWithPreference: an asked-for card wins and the broker is not consulted; otherwise the preference is the first choice', async () => {
  let asked = 0;
  const deps = { getLanes: gl, isHeld: heldSet(), fetch: async () => { asked += 1; return { ok: true, json: async () => ({ chatCard: 'rx580' }) }; } };
  assert.equal((await resolveChatCardWithPreference('worker-p40', { OLLAMA_URL: HOST }, deps)).lane, 'worker-p40');
  assert.equal(asked, 0);
  assert.equal((await resolveChatCardWithPreference('', { OLLAMA_URL: HOST }, deps)).lane, 'worker-rx580');
  assert.equal(asked, 1);
});

test('the preferred card still moves when the Forge holds it', async () => {
  const deps = { getLanes: gl, isHeld: heldSet('http://100.96.112.78:11434'), fetch: async () => ({ ok: true, json: async () => ({ chatCard: 'rx580' }) }) };
  const r = await resolveChatCardWithPreference('', { OLLAMA_URL: HOST }, deps);
  assert.equal(r.lane, 'worker-3090');
  assert.equal(r.moved, true);
});

// ---- cloud lanes are not chat cards ----
const cloudLane = { id: 'worker-cloud', gpu: 'cloud', local: false, cloud: true, provider: 'cloud', env: { OLLAMA_URL: 'http://127.0.0.1:7450', LOCAL_MODEL: 'claude-haiku-5-5' } };
const withCloud = [...lanes, cloudLane];

test('cloud lane: when every GPU card is held, chat is blocked -- it never falls back onto the paid cloud lane', () => {
  const r = chooseChatCard({ lanes: withCloud, preferred: '', hostUrl: HOST, isHeld: heldSet(HOST, 'http://192.168.122.29:11434', 'http://100.96.112.78:11434') });
  assert.equal(r.blocked, true);
  assert.equal(r.lane, null);
});

test('cloud lane: asking for it as a card is an unknown card, and the card list does not name it', () => {
  const r = chooseChatCard({ lanes: withCloud, preferred: 'worker-cloud', hostUrl: HOST, isHeld: heldSet() });
  assert.equal(r.blocked, true);
  assert.match(r.note, /Unknown card "worker-cloud"/);
  assert.doesNotMatch(r.note, /Cards:.*worker-cloud/);
});

test('cloud lane: with a cloud lane configured, GPU card selection is unchanged', () => {
  assert.deepEqual(chooseChatCard({ lanes: withCloud, preferred: '', hostUrl: HOST, isHeld: heldSet(HOST) }), choose('', heldSet(HOST)));
  assert.deepEqual(chooseChatCard({ lanes: withCloud, preferred: 'worker-rx580', hostUrl: HOST, isHeld: heldSet() }), choose('worker-rx580', heldSet()));
});
