'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');

let createLogTail;

before(async () => {
  const mod = await import('../src/log-tail.js');
  createLogTail = mod.createLogTail;
});

function makeFetchFrom(responses) {
  let callIndex = 0;
  const calls = [];
  const fetchFrom = async (offset) => {
    calls.push(offset);
    const resp = responses[callIndex++] ?? { data: [], nextOffset: offset };
    return resp;
  };
  return { fetchFrom, calls };
}

test('in-order events apply once each with no duplicates', async () => {
  const chunks = [];
  const onChunk = (data) => chunks.push(...data);
  const { onEvent } = createLogTail({
    fetchFrom: async (offset) => {
      const data = [`row-${offset}`];
      return { data, nextOffset: offset + data.length };
    },
    onChunk,
  });

  onEvent({ offset: 0, data: ['a'] });
  onEvent({ offset: 1, data: ['b'] });
  onEvent({ offset: 2, data: ['c'] });

  assert.deepStrictEqual(chunks, ['a', 'b', 'c']);
});

test('a gap triggers exactly one fetch from the current cursor with no reordering', async () => {
  const chunks = [];
  const { fetchFrom, calls } = makeFetchFrom([
    { data: ['fetched-0', 'fetched-1', 'fetched-2', 'fetched-3', 'fetched-4'], nextOffset: 5 },
  ]);
  const { onEvent } = createLogTail({ fetchFrom, onChunk: (d) => chunks.push(...d) });

  onEvent({ offset: 5, data: ['late'] });

  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(calls, [0], 'triggered exactly one fetch from cursor 0');
  assert.deepStrictEqual(chunks, ['fetched-0', 'fetched-1', 'fetched-2', 'fetched-3', 'fetched-4']);
});

test('concurrent triggers collapse to one follow-up pass', async () => {
  const chunks = [];
  const fetchCalls = [];
  let resolveFirst;
  const fetchFrom = (offset) =>
    new Promise((resolve) => {
      fetchCalls.push(offset);
      if (fetchCalls.length === 1) {
        resolveFirst = resolve;
      }
    });
  const { trigger } = createLogTail({ fetchFrom, onChunk: (d) => chunks.push(...d) });

  trigger();
  trigger();
  trigger();

  resolveFirst({ data: ['first-batch'], nextOffset: 1 });

  await new Promise((r) => setImmediate(r));

  assert.strictEqual(fetchCalls.length, 2, 'expected exactly one follow-up fetch');
  assert.deepStrictEqual(chunks, ['first-batch']);
});

test('late fetch after dispose emits nothing', async () => {
  let resolveFetch;
  const fetchFrom = () =>
    new Promise((resolve) => {
      resolveFetch = resolve;
    });
  const chunks = [];
  const { trigger, dispose } = createLogTail({ fetchFrom, onChunk: (d) => chunks.push(...d) });

  trigger();
  dispose();
  resolveFetch({ data: ['should-not-apply'], nextOffset: 100 });

  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(chunks, []);
});
