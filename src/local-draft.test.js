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

// Both new local tiers (adhoc-harness-draft.js, local-agentic-draft.js -- 2026-08-22, see
// local-draft.js's own dispatch comment) are injectable the same way draftAdhocImplementFn
// already was; every test below that isn't specifically exercising them declines
// immediately so the pre-existing Claude-fallback behavior these tests were written
// against is unchanged.
function declineLocalTiers() {
  const decline = async () => ({ applied: false, succeeded: true, reason: 'declined by test stub' });
  return { draftAdhocViaHarnessSearchFn: decline, draftAdhocViaLocalAgenticFn: decline };
}

test('an adhoc task with NO local-model override never locks at all (plan and implement both resolve to Claude)', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { calls, withLockFn } = spyLock();
    const task = { id: 'adhoc-test-1', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    await draftTask(task, {
      ornithCall: fakeOrnithCall('no real match -- nothing plausible'),
      withLockFn,
      ...declineLocalTiers(),
      draftAdhocImplementFn: async (t) => {
        t.implementResponse = 'RESOLUTION: no-changes-needed\n\nnothing to do';
        return { succeeded: true, blocked: false };
      },
    });

    assert.deepEqual(calls, ['start', 'end', 'start', 'end'], 'the two declined local tiers each lock around their own attempt; no override active -> Claude fallback needs no lock of its own');
  });
});

test('an adhoc task with a local-model override (the real bug scenario) locks around the plan call but NOT the real Claude implement call', async () => {
  await withFixtureRepo(async (draftTask) => {
    process.env.AGENT_MANAGER_FORCE_PROVIDER = 'local'; // the dashboard workerModelOverrides scenario that caused the original bug
    const { calls, withLockFn } = spyLock();
    const task = { id: 'adhoc-test-2', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    const draftAdhocImplementFn = async (t) => {
      // The real Claude call happening HERE must NOT be wrapped in a lock -- the plan
      // call's and both declined local tiers' own lock cycles must already be fully
      // closed before this runs (plan locks too here since FORCE_PROVIDER=local makes
      // resolvedCallIsLocal true for the plan pass specifically).
      assert.deepEqual(calls, ['start', 'end', 'start', 'end', 'start', 'end'], 'plan + both declined local tiers\' locks must already be released before the real Claude implement call starts');
      t.implementResponse = 'RESOLUTION: no-changes-needed\n\nnothing to do';
      return { succeeded: true, blocked: false };
    };

    const result = await draftTask(task, {
      ornithCall: fakeOrnithCall('confident match: none -- no real match'),
      withLockFn,
      ...declineLocalTiers(),
      draftAdhocImplementFn,
    });

    assert.equal(result.succeeded, true);
    assert.deepEqual(calls, ['start', 'end', 'start', 'end', 'start', 'end'], 'one lock cycle for the plan call plus one per declined local tier');
  });
});

test('an adhoc task where the harness-search tier applies a change -- never reaches local-agentic or Claude at all', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { calls, withLockFn } = spyLock();
    const task = { id: 'adhoc-test-3', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    const draftAdhocViaHarnessSearchFn = async (t) => {
      t.implementResponse = 'harness-search tier result';
      t.adhocResolution = 'implemented';
      t.rawDiff = 'fake diff';
      t.draftModel = 'test-local-model';
      return { applied: true, succeeded: true };
    };
    const draftAdhocViaLocalAgenticFn = async () => { throw new Error('must not be called when harness-search already applied'); };
    const draftAdhocImplementFn = async () => { throw new Error('must not fall through to Claude when harness-search already applied'); };

    const result = await draftTask(task, {
      ornithCall: fakeOrnithCall('confident match: none -- no real match'),
      withLockFn, draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocImplementFn,
    });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, false);
    assert.equal(task.status, 'needs-review');
    assert.deepEqual(calls, ['start', 'end'], 'exactly one lock cycle -- the applied harness-search tier');
  });
});

test('an adhoc task where harness-search declines but local-agentic applies -- never reaches Claude', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { withLockFn } = spyLock();
    const task = { id: 'adhoc-test-4', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    const draftAdhocViaHarnessSearchFn = async () => ({ applied: false, succeeded: true, reason: 'no real matches' });
    const draftAdhocViaLocalAgenticFn = async (t) => {
      t.implementResponse = 'local-agentic tier result';
      t.adhocResolution = 'implemented';
      t.rawDiff = 'fake diff';
      t.draftModel = 'test-local-model';
      return { applied: true, succeeded: true };
    };
    const draftAdhocImplementFn = async () => { throw new Error('must not fall through to Claude when local-agentic already applied'); };

    const result = await draftTask(task, {
      ornithCall: fakeOrnithCall('confident match: none -- no real match'),
      withLockFn, draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocImplementFn,
    });

    assert.equal(result.succeeded, true);
    assert.equal(task.adhocResolution, 'implemented');
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
