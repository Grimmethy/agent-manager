'use strict';

// Focused tests for the real plan/implement lock split (2026-08-22, Grimmethy: "build it
// now" -- see single-flight-lock.js's own header for the full incident this fixes). NOT
// a full draftTask() test suite (no dedicated one exists yet for this file, a real gap
// unrelated to this change) -- this only verifies the NEW lock-usage behavior, using
// dependency injection (localCall + withLockFn are both injectable specifically so this
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
  const { clearModelProfileRegistry } = require('./model-profile-registry.js');
  clearModelProfileRegistry();
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

function fakeLocalCall(response) {
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
      localCall: fakeLocalCall('no real match -- nothing plausible'),
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

// 2026-08-24 (adhoc-agentic-draft.js's RESOLUTION: needs-human-decision, Grimmethy: "We
// already have a 'needs clarification' tab... we need a 'discuss' button here"): a real
// open product/design question skips review-task.js/apply-task.js entirely -- there's
// nothing for an automatic reviewer to verify -- and goes straight to queue/needs-
// clarification/ (local-worker.sh's own move-destination branch) via a distinct
// needsClarification flag on both the task object and draftTask()'s own return value.
test('an adhoc task whose agentic draft needs a human decision skips needs-review and sets task.needsClarification', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-test-needs-decision', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'build something with real open questions' } };

    const draftAdhocImplementFn = async (t) => {
      t.adhocResolution = 'needs-human-decision';
      t.implementResponse = 'Which charting library should this use?';
      return { succeeded: true, blocked: false, needsClarification: true };
    };

    const { withLockFn } = spyLock();
    const result = await draftTask(task, {
      localCall: fakeLocalCall('no real match -- nothing plausible'),
      withLockFn,
      ...declineLocalTiers(),
      draftAdhocImplementFn,
    });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, false);
    assert.equal(result.needsClarification, true);
    assert.equal(task.status, undefined, 'must NOT be routed into the normal needs-review flow');
    assert.deepEqual(task.needsClarification, { reason: 'design-decision', openQuestions: 'Which charting library should this use?' });
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
      localCall: fakeLocalCall('confident match: none -- no real match'),
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
      localCall: fakeLocalCall('confident match: none -- no real match'),
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
      localCall: fakeLocalCall('confident match: none -- no real match'),
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
    const localCall = async () => {
      callCount++;
      if (callCount === 1) return { response: 'confident match: none', degenerate: null, attempts: 1 }; // plan
      if (callCount === 2) return { response: JSON.stringify({ category: 'idea', secondBrainPath: 'x.md', tags: [], actionable: false, rationale: 'r' }), degenerate: null, attempts: 1 }; // implement
      return { response: 'NO ISSUES FOUND', degenerate: null, attempts: 1 }; // critique
    };

    await draftTask(task, { localCall, withLockFn });

    // brain_dump_sort is low-tier by default (no override needed) -- one lock-start/
    // lock-end pair per real call this task actually reaches (plan, implement, critique
    // -- no revision since critique found no issues).
    assert.equal(calls.filter((c) => c === 'start').length, 3);
    assert.equal(calls.filter((c) => c === 'end').length, 3);
  });
});

// Regression, 2026-08-23: caught live -- arch_import drafts routinely fabricated
// plausible-looking file paths/APIs even when archImportImplementPrompt explicitly told
// the model to output the empty string on a genuine zero-hit search. Since queries with
// no "QUERY:" lines in the plan response never even call archImportFetch (harnessHits
// stays the default []), this test triggers the deterministic skip without needing to
// mock the real grep-based fetch at all.
test('arch_import skips the implement call entirely (deterministic empty, not left to the model) when the plan proposes zero search queries', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'arch-import-test-1', domain: 'default', source: 'arch_import',
      title: 'test', promptContext: { sourceProject: 'other-repo', rating: 'Strong', itemTitle: 'x', itemRationale: 'y' },
    };

    let callCount = 0;
    const localCall = async () => {
      callCount += 1;
      if (callCount > 1) throw new Error('implement must never be called when harnessHits is empty -- the whole point of the deterministic skip');
      return { response: 'no useful search terms come to mind for this one', degenerate: null, attempts: 1 }; // plan -- deliberately zero QUERY: lines
    };

    const result = await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, false);
    assert.equal(task.implementResponse, '');
    assert.equal(callCount, 1, 'only the plan call should have happened');
    assert.equal(task.status, 'needs-review');
  });
});

// Regression, 2026-08-23: caught live -- a Grill-skills adhoc task exhausted both
// retries because the model couldn't reliably reproduce a 4362-char fixedLiterals block
// character-for-character, even though file/find/replace were all already fully given
// in the task. This test proves the plan call (the only real model call this path
// should ever need) is bypassed for the construction itself -- the exact JSON edit
// directive is built directly from the task's own promptContext.
test('a task with file+find+one fixedLiterals block fully specified skips the model entirely and constructs the exact edit directive', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'literal-edit-test-1', domain: 'default', source: 'manual', title: 'test',
      promptContext: {
        file: 'python/dashboard/templates/index.html',
        find: 'async function loadSecondBrainFile(filePath) {\n  ...\n}',
        fixedLiterals: [{ name: 'loadSecondBrainFile + grill session functions', content: 'async function loadSecondBrainFile(filePath) {\n  ...\n}\n\nasync function grillStartSession() { /* new */ }' }],
      },
    };

    let callCount = 0;
    const localCall = async () => { callCount += 1; return { response: 'plan text', degenerate: null, attempts: 1 }; };

    const result = await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, false);
    assert.equal(callCount, 1, 'only the plan call should have happened -- implement must never be called when the edit is already fully determined');
    const parsed = JSON.parse(task.implementResponse);
    assert.equal(parsed.mode, 'edit');
    assert.equal(parsed.file, 'python/dashboard/templates/index.html');
    assert.equal(parsed.find, task.promptContext.find);
    assert.equal(parsed.replace, task.promptContext.fixedLiterals[0].content);
    assert.equal(task.status, 'needs-review');
  });
});

test('a task with fixedLiterals but NO file field falls through to the normal implement path, not the deterministic short-circuit', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'literal-edit-test-2', domain: 'default', source: 'manual', title: 'test',
      promptContext: {
        find: 'old text',
        fixedLiterals: [{ name: 'x', content: 'new text' }],
        // no `file` field -- must NOT trigger the deterministic path
      },
    };

    const localCall = async () => ({ response: 'plan text', degenerate: null, attempts: 1 });

    // Only asserting the short-circuit did NOT fire here -- not exercising the full real
    // implement path (needs a real git repo/registered source this fixture doesn't set
    // up), same scope every other test in this file keeps to per its own header comment.
    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() }).catch(() => {});

    const deterministicEvent = (task.history || []).find((h) => (h.detail || '').includes('deterministic find/replace'));
    assert.equal(deterministicEvent, undefined, 'without a `file` field, the deterministic short-circuit must never fire -- the edit is not fully unambiguous without it');
  });
});

// Regression, 2026-08-23: caught live -- a staleness_audit task auditing a scanner-
// originated finding burned all 3 infra-requeue rounds on real local-model timeouts and
// permanently blocked, needing a human to manually re-derive an answer a regex could give
// with certainty (see staleness-fastpath.js's own header). This proves the plan+implement
// calls are bypassed entirely for a staleness_audit task whose original finding names a
// rule this pipeline can re-run deterministically.
test('a staleness_audit task for a still-live scanner finding skips the model entirely and reports "worth a fresh investigation"', async () => {
  await withFixtureRepo(async (draftTask, dir) => {
    fs.writeFileSync(path.join(dir, 'worker.js'), 'try {\n  risky();\n} catch {}\n');
    const task = {
      id: 'staleness-audit-test-1', domain: 'default', source: 'staleness_audit', title: 'test',
      promptContext: {
        originalTaskId: 'observability-x-silent-catch-block-worker-js-1',
        originalSource: 'observability_review',
        originalRule: 'silent-catch-block',
        originalFile: 'worker.js',
        reasons: ['possibly-resolved'],
        evidenceText: 'test evidence',
      },
    };

    let callCount = 0;
    const localCall = async () => { callCount += 1; return { response: 'plan text', degenerate: null, attempts: 1 }; };

    const result = await draftTask(task, { localCall, withLockFn: async (d, fn) => fn() });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, false);
    assert.equal(callCount, 0, 'no model call should have happened at all -- the rescan is fully deterministic');
    assert.match(task.implementResponse, /RECOMMENDATION: worth a fresh investigation/);
    assert.equal(task.promptContext.harnessHits.length, 1);
    assert.equal(task.status, 'needs-review');
  });
});

test('a staleness_audit task for a resolved scanner finding skips the model entirely and reports "archive"', async () => {
  await withFixtureRepo(async (draftTask, dir) => {
    fs.writeFileSync(path.join(dir, 'worker.js'), 'try {\n  risky();\n} catch (e) {\n  logger.error(e);\n}\n');
    const task = {
      id: 'staleness-audit-test-2', domain: 'default', source: 'staleness_audit', title: 'test',
      promptContext: {
        originalTaskId: 'observability-x-silent-catch-block-worker-js-1',
        originalSource: 'observability_review',
        originalRule: 'silent-catch-block',
        originalFile: 'worker.js',
        reasons: ['possibly-resolved'],
        evidenceText: 'test evidence',
      },
    };

    let callCount = 0;
    const localCall = async () => { callCount += 1; return { response: 'plan text', degenerate: null, attempts: 1 }; };

    const result = await draftTask(task, { localCall, withLockFn: async (d, fn) => fn() });

    assert.equal(result.succeeded, true);
    assert.match(task.implementResponse, /RECOMMENDATION: archive/);
    assert.equal(callCount, 0);
  });
});

test('a staleness_audit task for an unsupported original source (e.g. adhoc) falls through to the normal harness-grounded path, not the deterministic short-circuit', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'staleness-audit-test-3', domain: 'default', source: 'staleness_audit', title: 'test',
      promptContext: {
        originalTaskId: 'adhoc-x-1',
        originalSource: 'adhoc',
        originalRule: null,
        originalFile: null,
        reasons: ['stale-age'],
        evidenceText: 'test evidence',
      },
    };

    const localCall = async () => ({ response: 'QUERY: something', degenerate: null, attempts: 1 });

    // Only asserting the short-circuit did NOT fire -- not exercising the full harness
    // path (needs real registered prompt builders/harness fetch this fixture doesn't set
    // up), same scope every other test in this file keeps to.
    await draftTask(task, { localCall, withLockFn: async (d, fn) => fn() }).catch(() => {});

    const deterministicEvent = (task.history || []).find((h) => (h.detail || '').includes('deterministic recheck'));
    assert.equal(deterministicEvent, undefined, 'an unsupported originalSource must never trigger the deterministic short-circuit');
  });
});

// Regression, 2026-08-23: caught live -- observability-fix-ac-27's implement pass wrote
// a plausible-but-fabricated `find` string that matched nothing in the real fetched file
// content it was given, and this only surfaced downstream at apply time after a full
// review cycle had already been spent on a draft that was never going to apply.
test('findUnverifiedEdit catches a find string that does not appear in the fetched file content', () => {
  const { findUnverifiedEdit } = require('./local-draft.js');
  const fetchedFiles = [{ path: 'src/task-sources.js', content: 'function real() {\n  return 1;\n}\n' }];

  const bad = JSON.stringify({ mode: 'edit', file: 'src/task-sources.js', find: 'this text is not in the file', replace: 'x' });
  assert.deepEqual(findUnverifiedEdit(bad, fetchedFiles), { file: 'src/task-sources.js', find: 'this text is not in the file' });

  const good = JSON.stringify({ mode: 'edit', file: 'src/task-sources.js', find: 'return 1;', replace: 'return 2;' });
  assert.equal(findUnverifiedEdit(good, fetchedFiles), null);
});

test('findUnverifiedEdit does not flag effectively-empty, malformed JSON, create-mode, or files with no fetched content', () => {
  const { findUnverifiedEdit } = require('./local-draft.js');
  const fetchedFiles = [{ path: 'x.js', content: 'real content' }];
  assert.equal(findUnverifiedEdit('', fetchedFiles), null);
  assert.equal(findUnverifiedEdit('""', fetchedFiles), null);
  assert.equal(findUnverifiedEdit('not json at all', fetchedFiles), null, 'malformed JSON is a separate, pre-existing failure mode');
  assert.equal(findUnverifiedEdit(JSON.stringify({ mode: 'create', file: 'new.js', content: 'x' }), fetchedFiles), null);
  assert.equal(findUnverifiedEdit(JSON.stringify({ mode: 'edit', file: 'unfetched.js', find: 'anything', replace: 'x' }), fetchedFiles), null, 'no fetched content for this file -- not this checks job');
});

test('draftTask retries the implement call once when a candidate-fulfillment source writes an unverifiable find, and accepts the corrected retry', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'obs-fix-test-1', domain: 'default', source: 'observability_fix', title: 'test',
      promptContext: {
        candidateId: 'AC-1', title: 'x', files: ['src/x.js'],
        fetchedFiles: [{ path: 'src/x.js', content: 'function real() {\n  return 1;\n}\n' }],
        body: 'Files: src/x.js',
      },
    };

    let callCount = 0;
    const localCall = async () => {
      callCount += 1;
      if (callCount === 1) return { response: 'plan text', degenerate: null, attempts: 1 }; // plan
      if (callCount === 2) return { response: JSON.stringify({ mode: 'edit', file: 'src/x.js', find: 'fabricated text not in file', replace: 'x' }), degenerate: null, attempts: 1 }; // implement, bad find
      if (callCount === 3) return { response: JSON.stringify({ mode: 'edit', file: 'src/x.js', find: 'return 1;', replace: 'return 2;' }), degenerate: null, attempts: 1 }; // retry, good find
      return { response: 'NO ISSUES FOUND', degenerate: null, attempts: 1 }; // critique
    };

    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });

    assert.equal(callCount, 4, 'plan, bad implement, retried implement, critique -- no infinite loop');
    const parsed = JSON.parse(task.implementResponse);
    assert.equal(parsed.find, 'return 1;', 'the corrected retry response must win, not the original fabricated one');
    assert.match(task.history.find((h) => h.stage === 'implement-done').detail, /retried once/);
  });
});

test('draftTask does not retry a candidate-fulfillment source whose find string verifies correctly the first time', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'obs-fix-test-2', domain: 'default', source: 'observability_fix', title: 'test',
      promptContext: {
        candidateId: 'AC-2', title: 'x', files: ['src/x.js'],
        fetchedFiles: [{ path: 'src/x.js', content: 'function real() {\n  return 1;\n}\n' }],
        body: 'Files: src/x.js',
      },
    };

    let callCount = 0;
    const localCall = async () => {
      callCount += 1;
      if (callCount === 1) return { response: 'plan text', degenerate: null, attempts: 1 };
      if (callCount === 2) return { response: JSON.stringify({ mode: 'edit', file: 'src/x.js', find: 'return 1;', replace: 'return 2;' }), degenerate: null, attempts: 1 };
      return { response: 'NO ISSUES FOUND', degenerate: null, attempts: 1 }; // critique
    };

    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });

    assert.equal(callCount, 3, 'plan, implement, critique -- correct on the first try, no retry burned');
  });
});

test('labelFor(task) returning undefined (LOCAL_MODEL unset) is treated as local, not a crash', async () => {
  await withFixtureRepo(async (draftTask) => {
    delete process.env.LOCAL_MODEL; // the exact edge case local-client.js's own fallback-removal fix made newly possible
    const { calls, withLockFn } = spyLock();
    const task = { id: 'default-test-2', domain: 'default', source: 'brain_dump_sort', title: 'test', promptContext: { rawText: 'x', tags: [] } };

    await assert.doesNotReject(draftTask(task, {
      localCall: fakeLocalCall(JSON.stringify({ category: 'idea', secondBrainPath: 'x.md', tags: [], actionable: false, rationale: 'r' })),
      withLockFn,
    }));

    assert.ok(calls.length > 0, 'an unresolved (undefined) label must default to "treat as local, lock" -- not silently skip locking');
  });
});
