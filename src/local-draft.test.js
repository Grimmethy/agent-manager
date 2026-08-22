'use strict';

// Focused tests for the real plan/implement lock split (2026-08-22, Grimmethy: "build it
// now" -- see single-flight-lock.js's own header for the full incident this fixes). NOT
// a full draftTask() test suite (no dedicated one exists yet for this file, a real gap
// unrelated to this change) -- this only verifies the NEW lock-usage behavior, using
// dependency injection (ornithCall + withLockFn are both injectable specifically so this
// never has to touch a real lockfile or make a real Ollama/Claude call). The stakes for
// getting this specific logic right are high: a wrong lock decision here risks a real
// deadlock (see local-worker.sh's own comment on why bash no longer locks around this
// call at all -- if it did, a real double-lock would deadlock the child node process).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withFixtureRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-draft-lock-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  process.env.LOCAL_MODEL = 'test-local-model';
  delete process.env.AGENT_MANAGER_FORCE_PROVIDER;
  const { clearRegistry } = require('./task-source-registry.js');
  clearRegistry();
  delete require.cache[require.resolve('./task-sources.js')];
  delete require.cache[require.resolve('./prompts.js')];
  delete require.cache[require.resolve('./local-draft.js')];
  require('./task-sources.js'); // registers 'adhoc' and friends' base config
  require('./prompts.js'); // re-attaches buildPlanPrompt/buildImplementPrompt on top --
  // both are needed after clearRegistry(): prompts.js wires its builders onto the
  // registry as a module-load side effect, so if it stayed cached from an earlier test
  // its updateTaskSource() calls never re-run, and every source ends up registered but
  // missing its prompt builder (buildPlanPrompt() then throws "no prompt template for
  // domain=...").
  const { draftTask } = require('./local-draft.js');
  try {
    return fn(draftTask, dir);
  } finally {
    delete process.env.AGENT_MANAGER_FORCE_PROVIDER;
  }
}

function fakeOrnithCall(response) {
  return async () => ({ response, degenerate: null, attempts: 1 });
}

function spyLock() {
  const calls = [];
  const withLockFn = async (dir, fn) => {
    calls.push('start');
    try { return await fn(); } finally { calls.push('end'); }
  };
  return { calls, withLockFn };
}

test('an adhoc task with NO local-model override never locks at all (plan and implement both resolve to Claude)', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { calls, withLockFn } = spyLock();
    const task = { id: 'adhoc-test-1', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    await draftTask(task, {
      ornithCall: fakeOrnithCall('no real match -- nothing plausible'),
      withLockFn,
      draftAdhocImplementFn: async (t) => {
        t.implementResponse = 'RESOLUTION: no-changes-needed\n\nnothing to do';
        return { succeeded: true, blocked: false };
      },
    });

    assert.deepEqual(calls, [], 'no override active -> adhoc resolves to Claude for both plan and implement -> never needs this lock');
  });
});

test('an adhoc task with a local-model override (the real bug scenario) locks around the plan call but NOT the real Claude implement call', async () => {
  await withFixtureRepo(async (draftTask) => {
    process.env.AGENT_MANAGER_FORCE_PROVIDER = 'local'; // the dashboard workerModelOverrides scenario that caused the original bug
    const { calls, withLockFn } = spyLock();
    const task = { id: 'adhoc-test-2', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    const draftAdhocImplementFn = async (t) => {
      // The real Claude call happening HERE must NOT be wrapped in a lock -- the plan
      // call's lock cycle must already be fully closed before this runs.
      assert.deepEqual(calls, ['start', 'end'], 'plan-stage lock must already be released before the real Claude implement call starts');
      t.implementResponse = 'RESOLUTION: no-changes-needed\n\nnothing to do';
      return { succeeded: true, blocked: false };
    };

    const result = await draftTask(task, {
      ornithCall: fakeOrnithCall('confident match: none -- no real match'),
      withLockFn,
      draftAdhocImplementFn,
    });

    assert.equal(result.succeeded, true);
    assert.deepEqual(calls, ['start', 'end'], 'exactly one lock cycle -- the plan call -- not one per call site');
  });
});

test('a non-adhoc/research task locks around EVERY real call (plan, implement, critique) since all of them share the same resolved local backend', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { calls, withLockFn } = spyLock();
    const task = { id: 'default-test-1', domain: 'default', source: 'brain_dump_sort', title: 'test', promptContext: { rawText: 'a note to classify', tags: [] } };

    let callCount = 0;
    const ornithCall = async () => {
      callCount++;
      if (callCount === 1) return { response: 'confident match: none', degenerate: null, attempts: 1 }; // plan
      if (callCount === 2) return { response: JSON.stringify({ category: 'idea', secondBrainPath: 'x.md', tags: [], actionable: false, rationale: 'r' }), degenerate: null, attempts: 1 }; // implement
      return { response: 'NO ISSUES FOUND', degenerate: null, attempts: 1 }; // critique
    };

    await draftTask(task, { ornithCall, withLockFn });

    // brain_dump_sort is low-tier by default (no override needed) -- one lock-start/
    // lock-end pair per real call this task actually reaches (plan, implement, critique
    // -- no revision since critique found no issues).
    assert.equal(calls.filter((c) => c === 'start').length, 3);
    assert.equal(calls.filter((c) => c === 'end').length, 3);
  });
});

test('labelFor(task) returning undefined (LOCAL_MODEL unset) is treated as local, not a crash', async () => {
  await withFixtureRepo(async (draftTask) => {
    delete process.env.LOCAL_MODEL; // the exact edge case local-client.js's own fallback-removal fix made newly possible
    const { calls, withLockFn } = spyLock();
    const task = { id: 'default-test-2', domain: 'default', source: 'brain_dump_sort', title: 'test', promptContext: { rawText: 'x', tags: [] } };

    await assert.doesNotReject(draftTask(task, {
      ornithCall: fakeOrnithCall(JSON.stringify({ category: 'idea', secondBrainPath: 'x.md', tags: [], actionable: false, rationale: 'r' })),
      withLockFn,
    }));

    assert.ok(calls.length > 0, 'an unresolved (undefined) label must default to "treat as local, lock" -- not silently skip locking');
  });
});
