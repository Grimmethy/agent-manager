'use strict';

// HUB0408 · 2/2: local-model-ready event contract, exercised with a fake transport.
// Depends on HUB0408 · 1/2 (src/local-client.js emitter, onLocalModelReady, callOnce `post`).
//
// Run: node --test src/lib/local-client-ready.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the real user environment and any real Ollama endpoint. Must run before
// the module is required, since local-client.js reads these at load time.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lcr-'));
process.env.OLLAMA_URL = 'http://invalid.test:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { call, callOnce, onLocalModelReady } = require('../local-client');

function okResponse() {
  return {
    response: 'ok',
    done: true,
    done_reason: 'stop',
    eval_count: 3,
    eval_duration: 1000000,
    prompt_eval_duration: 1000000,
    load_duration: 0,
    total_duration: 2000000,
  };
}

// Fake transport: records each call and resolves with a canned generate response.
function makeFakePost() {
  const calls = [];
  const post = async (target, body, timeoutMs, headers) => {
    calls.push({ target, body, timeoutMs, headers });
    return okResponse();
  };
  return { post, calls };
}

// Fake transport that always rejects, to simulate a hard failure.
function makeFailingPost() {
  return async () => {
    throw new Error('fake transport failure');
  };
}

function counter() {
  const seen = [];
  const fn = (name) => seen.push(name);
  return { fn, seen };
}

test('callOnce emits exactly one local-model-ready event per successful call', async () => {
  const { post } = makeFakePost();
  const { fn, seen } = counter();
  const unsubscribe = onLocalModelReady(() => fn('local-model-ready'));
  try {
    await callOnce({ prompt: 'hello', post });
    assert.deepEqual(seen, ['local-model-ready']);
  } finally {
    unsubscribe();
  }
});

test('call emits exactly one local-model-ready event per successful call', async () => {
  const { post } = makeFakePost();
  const { fn, seen } = counter();
  const unsubscribe = onLocalModelReady(() => fn('local-model-ready'));
  try {
    await call({ prompt: 'hello', post });
    assert.deepEqual(seen, ['local-model-ready']);
  } finally {
    unsubscribe();
  }
});

test('a failed call emits zero local-model-ready events', async () => {
  const { fn, seen } = counter();
  const unsubscribe = onLocalModelReady(() => fn('local-model-ready'));
  try {
    await assert.rejects(callOnce({ prompt: 'hello', post: makeFailingPost() }));
    assert.deepEqual(seen, []);
  } finally {
    unsubscribe();
  }
});

test('after unsubscribe, no further local-model-ready events are delivered', async () => {
  const { post } = makeFakePost();
  const { fn, seen } = counter();
  const unsubscribe = onLocalModelReady(() => fn('local-model-ready'));
  await callOnce({ prompt: 'first', post });
  assert.equal(seen.length, 1);
  unsubscribe();
  await callOnce({ prompt: 'second', post });
  assert.equal(seen.length, 1, 'no event after unsubscribe');
});
