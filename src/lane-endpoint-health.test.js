'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkLaneEndpoints } = require('./lane-endpoint-health.js');

function withFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = prev; });
}

test('reports reachable for a 200 model-list probe, using GET on the tags path', async () => {
  await withFetch(async (url, init) => {
    assert.equal(String(url), 'http://a:11434/api/tags');
    assert.ok(!init || init.method === undefined || init.method === 'GET');
    return { ok: true, text: async () => '{}' };
  }, async () => {
    const out = await checkLaneEndpoints(['http://a:11434']);
    assert.deepEqual(out, [{ endpoint: 'http://a:11434', reachable: true }]);
  });
});

test('strips trailing slashes before appending the probe path', async () => {
  await withFetch(async (url) => {
    assert.equal(String(url), 'http://b:11434/api/tags');
    return { ok: true, text: async () => '' };
  }, async () => {
    await checkLaneEndpoints(['http://b:11434//']);
  });
});

test('reports unreachable on a non-2xx response', async () => {
  await withFetch(async () => ({ ok: false, status: 500, text: async () => '' }), async () => {
    const out = await checkLaneEndpoints(['http://c:11434']);
    assert.deepEqual(out, [{ endpoint: 'http://c:11434', reachable: false }]);
  });
});

test('reports unreachable when the connection throws', async () => {
  await withFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
    const out = await checkLaneEndpoints(['http://d:11434']);
    assert.deepEqual(out, [{ endpoint: 'http://d:11434', reachable: false }]);
  });
});

test('a hung endpoint is marked unreachable once the timeout fires', async () => {
  await withFetch((url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }), async () => {
    const out = await checkLaneEndpoints(['http://e:11434'], { timeoutMs: 20 });
    assert.deepEqual(out, [{ endpoint: 'http://e:11434', reachable: false }]);
  });
});

test('probes every endpoint and keeps input order', async () => {
  await withFetch(async (url) => ({ ok: !String(url).includes('down'), text: async () => '' }), async () => {
    const out = await checkLaneEndpoints(['http://up:1', 'http://down:2']);
    assert.deepEqual(out, [
      { endpoint: 'http://up:1', reachable: true },
      { endpoint: 'http://down:2', reachable: false },
    ]);
  });
});

test('an empty or non-array input returns an empty list without calling fetch', async () => {
  await withFetch(async () => { throw new Error('fetch should not run'); }, async () => {
    assert.deepEqual(await checkLaneEndpoints([]), []);
    assert.deepEqual(await checkLaneEndpoints(undefined), []);
  });
});
