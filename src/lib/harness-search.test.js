'use strict';

// Offline gate: for kind==='projectSearch' with queries, an isOnlineFn that reports offline must
// short-circuit BEFORE any network fetch (projectSearchFetch is never invoked) and return
// { networkUnavailable: true }. With no isOnlineFn the default behaviour is unchanged (fetch runs).

const test = require('node:test');
const assert = require('node:assert/strict');

const { runHarnessSearch } = require('./harness-search.js');

test('projectSearch: returns {networkUnavailable:true} and never calls fetch when isOnlineFn returns false', async () => {
  let fetchCalled = false;
  const result = await runHarnessSearch(
    'projectSearch',
    { planResponse: 'QUERY: x', promptContext: {} },
    {
      projectSearchFetch: () => { fetchCalled = true; throw new Error('must not be called'); },
      isOnlineFn: () => false,
    },
  );
  assert.equal(fetchCalled, false, 'projectSearchFetch must not be invoked');
  assert.deepEqual(result, { networkUnavailable: true });
});

test('projectSearch: without isOnlineFn, fetch is called (default unchanged)', async () => {
  let fetchCalled = false;
  await runHarnessSearch(
    'projectSearch',
    { planResponse: 'QUERY: y', promptContext: {} },
    {
      projectSearchFetch: () => { fetchCalled = true; return []; },
    },
  );
  assert.equal(fetchCalled, true, 'projectSearchFetch should be called by default');
});
