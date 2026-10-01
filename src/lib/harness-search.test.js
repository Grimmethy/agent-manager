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


// --- a search where every query errored did not run (brain dump #1663) ---------------------------------------------------------------------------
const { searchDidNotRun } = require('./harness-search.js');

const err = (message, source = 'github') => ({ query: 'q', source, error: message });
const real = (name) => ({ query: 'q', source: 'github', name, url: `repo:${name}`, description: '', stat: '1 stars' });
const newTask = () => ({ planResponse: 'QUERY: one\nQUERY: two', promptContext: {}, history: [] });
const run = (results, task = newTask()) => runHarnessSearch('projectSearch', task, { projectSearchFetch: async () => results, isOnlineFn: () => true }).then((r) => ({ r, task }));

test('searchDidNotRun: true only when EVERY result is a transient error', () => {
  assert.match(searchDidNotRun([err('getaddrinfo ENOTFOUND api.github.com'), err('getaddrinfo ENOTFOUND huggingface.co', 'huggingface')]), /2 of 2 results errored/);
  for (const msg of ['request timed out', 'getaddrinfo EAI_AGAIN api.github.com', 'read ECONNRESET', 'connect ECONNREFUSED 1.2.3.4:443', 'connect ETIMEDOUT', 'socket hang up',
    'HTTP 403: rate limit exceeded', 'HTTP 429: too many requests', 'HTTP 502: bad gateway', 'HTTP 503: unavailable']) {
    assert.notEqual(searchDidNotRun([err(msg)]), null, msg);
  }
  assert.equal(searchDidNotRun([err('request timed out'), real('a/b')]), null, 'one real result means the search ran');
  assert.equal(searchDidNotRun([]), null, 'a clean zero is a real answer');
  assert.equal(searchDidNotRun([err('HTTP 422: Validation Failed')]), null, 'a rejected query is permanent, not transient');
  assert.equal(searchDidNotRun([err('Unparseable JSON: Unexpected token')]), null);
  assert.equal(searchDidNotRun([err('request timed out'), err('HTTP 422: Validation Failed')]), null, 'one permanent error keeps the old behaviour');
  for (const bad of [undefined, null, 'x', 7, [null], [{}], [{ error: '' }], [{ error: 5 }]]) assert.equal(searchDidNotRun(bad), null);
});

test('projectSearch: every query erroring (DNS down, timeouts) is treated as network unavailable, not as 0 results', async () => {
  const { r, task } = await run([err('getaddrinfo ENOTFOUND api.github.com'), err('getaddrinfo ENOTFOUND huggingface.co', 'huggingface'), err('request timed out'), err('request timed out', 'huggingface')]);
  assert.deepEqual(r, { networkUnavailable: true });
  assert.equal(task.networkUnavailable, true);
  assert.deepEqual(task.promptContext.searchResults, [], 'no fake results are left for implement to work from');
  const ev = task.history.find((h) => h.stage === 'harness-search');
  assert.match(ev.detail, /2 quer\(y\/ies\): the search did not run \(4 of 4 results errored, mostly "[^"]+"\) -- treated as network unavailable, requeued without using an attempt/);
});

test('projectSearch: a search that returned something real, even with some failed queries, runs as before', async () => {
  const results = [err('request timed out'), real('x/y'), err('getaddrinfo ENOTFOUND huggingface.co', 'huggingface')];
  const { r, task } = await run(results);
  assert.equal(r, undefined);
  assert.equal(task.networkUnavailable, undefined);
  assert.deepEqual(task.promptContext.searchResults, results);
  assert.equal(task.history.find((h) => h.stage === 'harness-search').detail, '2 quer(y/ies), 3 result(s)');
});

test('projectSearch: a clean zero (queries ran, nothing found) and a rejected-query error both proceed as before', async () => {
  for (const results of [[], [err('HTTP 422: Validation Failed'), err('HTTP 422: Validation Failed', 'huggingface')]]) {
    const { r, task } = await run(results);
    assert.equal(r, undefined);
    assert.equal(task.networkUnavailable, undefined);
    assert.deepEqual(task.promptContext.searchResults, results);
  }
});

test('projectSearch: with no queries nothing is fetched or judged, and a fetch that throws still proceeds with no results', async () => {
  let called = 0;
  const task = { planResponse: 'no queries here', promptContext: {}, history: [] };
  const r = await runHarnessSearch('projectSearch', task, { projectSearchFetch: () => { called += 1; return []; }, isOnlineFn: () => true });
  assert.equal(r, undefined);
  assert.equal(called, 0);
  const t2 = newTask();
  const r2 = await runHarnessSearch('projectSearch', t2, { projectSearchFetch: () => { throw new Error('boom'); }, isOnlineFn: () => true });
  assert.equal(r2, undefined);
  assert.deepEqual(t2.promptContext.searchResults, []);
});

test('the arch-import style harness is untouched by the project-search failure rule', async () => {
  const task = { planResponse: 'QUERY: alpha', promptContext: {}, history: [] };
  const r = await runHarnessSearch('archImport', task, { archImportFetch: () => ({ hits: [], files: [] }), roots: [] });
  assert.equal(r, undefined);
  assert.deepEqual(task.promptContext.harnessHits, []);
});
