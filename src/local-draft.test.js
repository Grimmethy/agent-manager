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

// The hygiene sources -- observability/performance/function-length _review + _fix
// (2026-08-27) and arch_review/arch_import/arch_discovery/unused_export (2026-08-27,
// Phase 2) -- moved to the out-of-tree agent-manager-hygiene plugin, so requiring
// ./task-sources.js no longer registers them. Several tests below assert CORE draft
// behaviour (candidate-fulfillment retry, critique pass, split-response handling,
// tool-access gating, heartbeats, the arch_import zero-query skip) using those sources as
// the concrete example -- re-register a matching-shape stub so the assertions still
// exercise the real core path. Prompt builders are the real ones prompts.js still exports.
function registerHygieneStubs() {
  const { registerTaskSource, updateTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  const p = require('./prompts.js');
  const stub = (name, cfg, plan = p.archReviewPlanPrompt, impl = p.archReviewImplementPrompt) => {
    if (getRegisteredSource(name)) return;
    registerTaskSource(name, { priority: 80, next: () => null, ...cfg });
    updateTaskSource(name, { buildPlanPrompt: plan, buildImplementPrompt: impl });
  };
  stub('observability_review', { apply: () => ({ skipped: true }), advisoryProse: true });
  stub('observability_fix', { emptyApproval: true, candidateFulfillment: true, candidatesPath: () => require('./config.js').getConfig().observabilityFixCandidatesPath, candidateDocTitle: '# Observability Fix Candidates' });
  stub('arch_review', { emptyApproval: true, candidateFulfillment: true, candidatesPath: () => require('./config.js').getConfig().archReviewCandidatesPath, candidateDocTitle: '# Architecture Review Candidates', reasoningTier: 'high' });
  stub('arch_import', { emptyApproval: true, apply: () => ({ skipped: true }), harnessSearch: 'archImport', skipImplementWhenNoHarnessHits: true }, p.archImportPlanPrompt, p.archImportImplementPrompt);
  // arch_discovery -- a GENERATOR: emptyApproval but NOT candidateFulfillment (it has no
  // specific candidate to implement -- "found nothing" is a valid outcome). Used by the
  // empty-plan tests below.
  stub('arch_discovery', { emptyApproval: true, apply: () => ({ skipped: true }) }, p.archDiscoveryPlanPrompt, p.archDiscoveryImplementPrompt);

  // ADR-0022 Stage B/C: staleness-fastpath.js's deterministic recheck consults the
  // deterministic-recheck-registry instead of a hardcoded rule map, and agent-manager-hygiene
  // owns both the wiring and the real scanners now. The two staleness_audit fast-path tests
  // below only need *a* detector that fires on their fixture content -- register a small
  // "empty catch block" matcher under silent-catch-block so they still exercise the
  // deterministic short-circuit without a dependency on the (moved-out) real scanner.
  const { registerDeterministicRecheck, getDeterministicRecheck } = require('./deterministic-recheck-registry.js');
  if (!getDeterministicRecheck('observability_review')) {
    registerDeterministicRecheck('observability_review', {
      perFileRules: {
        'silent-catch-block': (text, relPath) => text.split('\n').flatMap((ln, i) => (
          /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(ln) ? [{ file: relPath, line: i + 1, detail: 'empty catch block' }] : []
        )),
      },
    });
  }
}

function withFixtureRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-draft-lock-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  process.env.LOCAL_MODEL = 'test-local-model';
  delete process.env.AGENT_MANAGER_FORCE_PROVIDER;
  const { clearRegistry } = require('./task-source-registry.js');
  clearRegistry();
  require('./deterministic-recheck-registry.js').clearDeterministicRecheckRegistry();
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
  registerHygieneStubs();
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

// Manual "pause Claude" kill switch, 2026-08-25 (Grimmethy: "I need a way to pause the
// claude use... preserve the tokens since I know I'm very likely to hit my weekly
// limit") -- see claude-pause.js's own header. adhoc's real Claude implement call and
// research's own implement call are both unconditional (no local fallback, bypass every
// other budget gate by design), so they're the two call sites this pause has to check
// directly rather than relying on the plan-call routing alone.
test('an adhoc task declines the Claude fallback (never calls it) when Claude use is manually paused, after both local tiers decline', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-test-paused', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    const draftAdhocViaHarnessSearchFn = async () => ({ applied: false, succeeded: true, reason: 'no real matches' });
    const draftAdhocViaLocalAgenticFn = async () => ({ applied: false, succeeded: true, reason: 'declined by test stub' });
    const draftAdhocImplementFn = async () => { throw new Error('must not call Claude while manually paused'); };

    const result = await draftTask(task, {
      localCall: fakeLocalCall('confident match: none -- no real match'),
      withLockFn: async (dir2, fn) => fn(), draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocImplementFn,
      isClaudePausedFn: () => true,
    });

    assert.equal(result.succeeded, false);
    assert.match(result.reason, /manually paused/);
  });
});

test('a research task declines the Claude implement call (never calls it) when Claude use is manually paused', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'research-test-paused', domain: 'research', source: 'research_task', title: 'test',
      promptContext: { rawText: 'investigate something', tags: [] },
    };

    const localCall = async () => ({ response: 'plan text (paused, no tool access needed for this test)', degenerate: null, attempts: 1 });
    const draftResearchImplementFn = async () => { throw new Error('must not call Claude while manually paused'); };

    const result = await draftTask(task, { localCall, withLockFn: async (dir2, fn) => fn(), draftResearchImplementFn, isClaudePausedFn: () => true });

    assert.equal(result.succeeded, false);
    assert.match(result.reason, /manually paused/);
  });
});

test('an adhoc task falls through to Claude normally when Claude use is NOT paused', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-test-not-paused', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    const draftAdhocViaHarnessSearchFn = async () => ({ applied: false, succeeded: true, reason: 'no real matches' });
    const draftAdhocViaLocalAgenticFn = async () => ({ applied: false, succeeded: true, reason: 'declined by test stub' });
    let claudeCalled = false;
    const draftAdhocImplementFn = async (t) => {
      claudeCalled = true;
      t.implementResponse = 'RESOLUTION: no-changes-needed\n\nnothing to do';
      return { succeeded: true, blocked: false };
    };

    await draftTask(task, {
      localCall: fakeLocalCall('confident match: none -- no real match'),
      withLockFn: async (dir2, fn) => fn(), draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocImplementFn,
    });

    assert.equal(claudeCalled, true, 'must still reach Claude normally when not paused');
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

// ADR-0022 Stage A4: the between-plan-and-implement harness-search step is driven by the
// source's `harnessSearch` registry field, not a per-source `if` chain in draftTask. Guard
// both the dispatch (a 'projectSearch' source runs projectSearchFetch and stashes
// searchResults) and the negative case (a source with no field runs no search).
test('draftTask runs harness search iff the source declares harnessSearch, and picks the fetch by its value', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { registerTaskSource, updateTaskSource } = require('./task-source-registry.js');
    const p = require('./prompts.js');
    // Prompt builders are irrelevant here (localCall is injected) -- reuse two the registry
    // exports so buildPlanPrompt/buildImplementPrompt don't throw before the harness step.
    registerTaskSource('sa4_probe_psearch', { priority: 80, next: () => null, emptyApproval: true, harnessSearch: 'projectSearch' });
    updateTaskSource('sa4_probe_psearch', { buildPlanPrompt: p.archImportPlanPrompt, buildImplementPrompt: p.archImportImplementPrompt });

    let fetchArgs = null;
    const projectSearchFetch = async (queries) => { fetchArgs = queries; return [{ name: 'real/result', url: 'u' }]; };
    const localCall = async () => ({ response: 'QUERY: some real query\nQUERY: another', degenerate: null, attempts: 1 });

    const task = { id: 'sa4-psearch', domain: 'default', source: 'sa4_probe_psearch', title: 't', promptContext: {} };
    await draftTask(task, { localCall, projectSearchFetch, withLockFn: async (d, fn) => fn() });

    assert.deepEqual(fetchArgs, ['some real query', 'another'], 'QUERY: lines parsed and passed to the declared fetch');
    assert.equal(task.promptContext.searchResults.length, 1);
    assert.ok((task.history || []).some((e) => e.stage === 'harness-search'), 'a harness-search history event was appended');
  });
});

test('draftTask runs NO harness search for a source without harnessSearch (searchResults/harnessHits stay unset)', async () => {
  await withFixtureRepo(async (draftTask) => {
    const localCall = async () => ({ response: 'QUERY: this must be ignored', degenerate: null, attempts: 1 });
    // trouble_log: an ordinary local source with no harnessSearch field.
    const task = { id: 'sa4-none', domain: 'default', source: 'trouble_log', title: 't', promptContext: {} };
    await draftTask(task, { localCall, withLockFn: async (d, fn) => fn() }).catch(() => {});
    assert.equal(task.promptContext.searchResults, undefined);
    assert.equal(task.promptContext.harnessHits, undefined);
    assert.ok(!(task.history || []).some((e) => e.stage === 'harness-search'));
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

// Regression, 2026-08-26 -- see prompts.js's candidateSplitInstructions for the full
// incident (arch-review-ac-4: a real candidate that genuinely didn't fit one atomic
// JSON edit, and had no escape hatch other than under-delivering or exhausting).
test('parseCandidateSplit recognizes a well-formed split and returns its sub-candidates', () => {
  const { parseCandidateSplit } = require('./local-draft.js');
  const response = JSON.stringify({
    mode: 'split',
    candidates: [
      { title: 'Extract git apply path', files: 'src/apply-task.js', problem: 'p1', solution: 's1', benefits: 'b1' },
      { title: 'Extract direct-write apply path', files: 'src/apply-task.js', problem: 'p2', solution: 's2', benefits: 'b2' },
    ],
  });
  const result = parseCandidateSplit(response);
  assert.equal(result.invalid, undefined);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].title, 'Extract git apply path');
});

test('parseCandidateSplit returns invalid:true when mode is "split" but fewer than 2 sub-candidates are well-formed', () => {
  const { parseCandidateSplit } = require('./local-draft.js');
  const oneReal = JSON.stringify({ mode: 'split', candidates: [{ title: 'Only one', problem: 'p', solution: 's' }] });
  const result1 = parseCandidateSplit(oneReal);
  assert.equal(result1.invalid, true);
  assert.match(result1.reason, /at least 2/);

  const missingFields = JSON.stringify({ mode: 'split', candidates: [{ title: 'a' }, { title: 'b' }] });
  const result2 = parseCandidateSplit(missingFields);
  assert.equal(result2.invalid, true);

  const noCandidatesArray = JSON.stringify({ mode: 'split' });
  assert.equal(parseCandidateSplit(noCandidatesArray).invalid, true);
});

test('parseCandidateSplit returns null for anything that is not a split attempt (normal edit/create/delete/empty responses pass through untouched)', () => {
  const { parseCandidateSplit } = require('./local-draft.js');
  assert.equal(parseCandidateSplit(''), null);
  assert.equal(parseCandidateSplit('""'), null);
  assert.equal(parseCandidateSplit('not json at all'), null);
  assert.equal(parseCandidateSplit(JSON.stringify({ mode: 'edit', file: 'x.js', find: 'a', replace: 'b' })), null);
  assert.equal(parseCandidateSplit(JSON.stringify([{ mode: 'edit', file: 'x.js', find: 'a', replace: 'b' }])), null, 'a plain array (multi-file edit) is not a split object');
});

test('draftTask recognizes a split implement response, skips critique, and goes straight to needs-review', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'arch-review-split-test-1', domain: 'default', source: 'arch_review', title: 'test',
      promptContext: {
        candidateId: 'AC-4', title: 'x', files: ['src/apply-task.js'],
        fetchedFiles: [{ path: 'src/apply-task.js', content: 'function applyTask() {}\n' }],
        body: 'Files: src/apply-task.js',
      },
    };

    let callCount = 0;
    const localCall = async () => {
      callCount += 1;
      if (callCount === 1) return { response: 'plan text', degenerate: null, attempts: 1 }; // plan
      if (callCount === 2) {
        return {
          response: JSON.stringify({
            mode: 'split',
            candidates: [
              { title: 'Extract git path', problem: 'p1', solution: 's1', benefits: 'b1' },
              { title: 'Extract direct-write path', problem: 'p2', solution: 's2', benefits: 'b2' },
            ],
          }),
          degenerate: null, attempts: 1,
        }; // implement, split
      }
      throw new Error('critique should never be called for a split response');
    };

    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });

    assert.equal(callCount, 2, 'plan + implement only -- critique must be skipped');
    assert.equal(task.candidateSplitProposals.length, 2);
    assert.equal(task.candidateSplitProposals[0].title, 'Extract git path');
    assert.equal(task.status, 'needs-review');
    assert.equal(task.history.some((h) => h.stage === 'critique-done'), false);
    assert.match(task.history.find((h) => h.stage === 'implement-done').detail, /split into 2 sub-candidate/);
  });
});

test('draftTask blocks a candidate-fulfillment source that says mode "split" but does not follow through with well-formed sub-candidates', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'arch-review-split-test-2', domain: 'default', source: 'arch_review', title: 'test',
      promptContext: {
        candidateId: 'AC-5', title: 'x', files: ['src/apply-task.js'],
        fetchedFiles: [{ path: 'src/apply-task.js', content: 'function applyTask() {}\n' }],
        body: 'Files: src/apply-task.js',
      },
    };

    let callCount = 0;
    const localCall = async () => {
      callCount += 1;
      if (callCount === 1) return { response: 'plan text', degenerate: null, attempts: 1 };
      return { response: JSON.stringify({ mode: 'split', candidates: [{ title: 'Only one' }] }), degenerate: null, attempts: 1 };
    };

    const result = await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });

    assert.equal(result.blocked, true);
    assert.match(result.blockedReason, /at least 2/);
  });
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

// 2026-08-24 (pipeline hardening): root-caused live -- EVERY brain_dump_sort draft
// failed outright with "Ollama HTTP 400: \"qwen2.5:3b\" does not support thinking" for
// as long as the brain-dump-cheap-local model profile existed, because every call site
// in draftTask() unconditionally passed think:true (or think:!hasFixedLiterals) with no
// way for a profile's model choice to override it.
test('a task whose model profile sets think:false never requests thinking, even though the call sites default to true', async () => {
  await withFixtureRepo(async (draftTask) => {
    const seenThinkValues = [];
    const localCall = async (opts) => {
      seenThinkValues.push(opts.think);
      if (seenThinkValues.length === 1) return { response: '1. about x\n2. reference\n3. Ideas\n4. Ideas/x.md\n5. none apply\n6. no', degenerate: null, attempts: 1 };
      return { response: JSON.stringify({ category: 'idea', secondBrainPath: 'Ideas/x.md', tags: [], actionable: false, rationale: 'r' }), degenerate: null, attempts: 1 };
    };
    const task = { id: 'brain-dump-think-test', domain: 'default', source: 'brain_dump_sort', title: 'test', promptContext: { rawText: 'x', tags: [] } };

    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });

    assert.ok(seenThinkValues.length >= 2, 'expected at least a plan and an implement call');
    assert.ok(seenThinkValues.every((v) => v === false), `every call for a think:false-profiled task must request think:false, got: ${JSON.stringify(seenThinkValues)}`);
  });
});

test('a task with NO model profile still defaults to think:true, unaffected by the brain-dump-cheap-local fix', async () => {
  await withFixtureRepo(async (draftTask) => {
    const seenThinkValues = [];
    const localCall = async (opts) => {
      seenThinkValues.push(opts.think);
      return { response: JSON.stringify({ category: 'idea', secondBrainPath: 'Ideas/x.md', tags: [], actionable: false, rationale: 'r' }), degenerate: null, attempts: 1 };
    };
    // trouble_log has no registered modelProfile -- ordinary default-tier local source.
    const task = { id: 'no-profile-think-test', domain: 'default', source: 'trouble_log', title: 'test', promptContext: {} };

    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() }).catch(() => {});

    assert.ok(seenThinkValues.length > 0, 'expected at least one real call');
    assert.ok(seenThinkValues.every((v) => v === true), `a task with no model profile must keep the existing think:true default, got: ${JSON.stringify(seenThinkValues)}`);
  });
});

// 2026-08-25 ("look for other opportunities" to shave draft-side time): critique+revision
// is skipped entirely for an advisoryProse source -- measured against real historical
// data first (observability_review/performance_review: critique was a no-op, either "NO
// ISSUES FOUND" or the critique call itself degenerating, 90.9%/94.9% of the time,
// 12.2 combined hours of real wall-clock time for a self-review pass whose own output
// almost never mattered). staleness_audit is also advisoryProse:true and, unlike
// observability_review/performance_review, is already registered in task-sources.js's own
// base set this fixture loads -- no custom source registration needed.
test('draftTask skips the critique+revision pass entirely for an advisoryProse source', async () => {
  await withFixtureRepo(async (draftTask) => {
    let callCount = 0;
    const localCall = async () => {
      callCount += 1;
      if (callCount === 1) {
        // plan pass: staleness_audit's harness-search branch reads QUERY: lines.
        return { response: 'QUERY: nothing to find here', degenerate: null, attempts: 1 };
      }
      // implement pass: a plain advisory report, no RESOLUTION/DIFF machinery involved.
      return { response: 'The original concern still appears to hold.', degenerate: null, attempts: 1 };
    };
    const task = {
      id: 'advisory-prose-skip-test', domain: 'default', source: 'staleness_audit', title: 'test',
      promptContext: { evidenceText: 'some prior finding' },
    };

    const result = await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });

    assert.equal(result.succeeded, true);
    assert.equal(callCount, 2, 'only plan + implement -- no third (critique) call for an advisoryProse source');
    assert.equal(task.critiqueOutcome, 'skipped-advisory-prose');
    assert.equal(task.revisionApplied, undefined, 'no revision pass ran, so this must stay unset, not falsely imply one ran and found nothing');
  });
});

test('draftTask still runs the critique+revision pass for a non-advisoryProse source (observability_fix, unaffected)', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'obs-fix-critique-still-runs', domain: 'default', source: 'observability_fix', title: 'test',
      promptContext: {
        candidateId: 'AC-3', title: 'x', files: ['src/x.js'],
        fetchedFiles: [{ path: 'src/x.js', content: 'function real() {\n  return 1;\n}\n' }],
        body: 'Files: src/x.js',
      },
    };

    let callCount = 0;
    const localCall = async () => {
      callCount += 1;
      if (callCount === 1) return { response: 'plan text', degenerate: null, attempts: 1 };
      if (callCount === 2) return { response: JSON.stringify({ mode: 'edit', file: 'src/x.js', find: 'return 1;', replace: 'return 2;' }), degenerate: null, attempts: 1 };
      return { response: 'NO ISSUES FOUND', degenerate: null, attempts: 1 };
    };

    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });

    assert.equal(callCount, 3, 'plan, implement, AND critique -- a real code-diff source must be unaffected by the advisoryProse skip');
  });
});

// Plan-grounding fix, 2026-08-25: research_task's plan pass now gets real WebSearch/
// WebFetch tool access (see prompts.js's researchPlanPrompt for the incident this
// fixes -- an ungrounded plan pass fabricated a fake clinical trial registry ID/site,
// and review then held every implement attempt to it as if it were verified). This test
// covers the wiring half: local-draft.js must actually pass allowedTools/maxTurns
// through to the plan call for domain==='research', and must NOT do so for any other
// domain (a plain no-tool completion is correct everywhere else).
test('draftTask grants the plan call real WebSearch/WebFetch tool access for a research-domain task', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'research-test-1', domain: 'research', source: 'research_task', title: 'test',
      promptContext: { rawText: 'investigate something', tags: [] },
    };

    let capturedOpts = null;
    const localCall = async (opts) => {
      capturedOpts = opts;
      return { response: 'grounded plan text', degenerate: null, attempts: 1 };
    };
    const draftResearchImplementFn = async (t) => {
      t.researchDoc = '# write-up';
      t.implementResponse = t.researchDoc;
      return { succeeded: true, blocked: false };
    };

    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn(), draftResearchImplementFn });

    assert.equal(capturedOpts.allowedTools, 'WebSearch,WebFetch');
    assert.equal(capturedOpts.maxTurns, 8);
  });
});

test('draftTask does NOT grant tool access to the plan call for a non-research domain', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'obs-fix-no-tools', domain: 'default', source: 'observability_fix', title: 'test',
      promptContext: {
        candidateId: 'AC-4', title: 'x', files: ['src/x.js'],
        fetchedFiles: [{ path: 'src/x.js', content: 'function real() {\n  return 1;\n}\n' }],
        body: 'Files: src/x.js',
      },
    };

    let capturedOpts = null;
    let callCount = 0;
    const localCall = async (opts) => {
      callCount += 1;
      if (callCount === 1) capturedOpts = opts;
      if (callCount === 1) return { response: 'plan text', degenerate: null, attempts: 1 };
      if (callCount === 2) return { response: JSON.stringify({ mode: 'edit', file: 'src/x.js', find: 'return 1;', replace: 'return 2;' }), degenerate: null, attempts: 1 };
      return { response: 'NO ISSUES FOUND', degenerate: null, attempts: 1 };
    };

    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });

    assert.equal(capturedOpts.allowedTools, undefined);
    assert.equal(capturedOpts.maxTurns, undefined);
  });
});

// Restores the 2026-08-19 queued/working heartbeat distinction the 2026-08-22 lock
// split had made bash unable to report (2026-08-25, Grimmethy: "Is there a way we can
// maintain the improved speed but get that extra status differentiation back?"). The
// real wait now happens inside this node process (single-flight-lock.js's withLock), so
// maybeLocked() writes "queued" right before blocking on the lock and "working" (with
// the real currentPass) the instant it's actually acquired -- see heartbeat.js's own
// tests for the write shape itself; this covers the transition actually firing at the
// right moments during a real draftTask() call.
test('draftTask writes a queued heartbeat before the lock is held and a working one (with the real pass) once acquired', async () => {
  await withFixtureRepo(async (draftTask, dir) => {
    process.env.AGENT_MANAGER_INSTANCE_ID = 'worker-test';
    const task = { id: 'hb-test-1', domain: 'default', source: 'observability_fix', title: 'test', promptContext: { candidateId: 'AC-9', title: 'x', files: [], fetchedFiles: [], body: '' } };
    const instancesDir = path.join(dir, 'instances');
    const hbPath = path.join(instancesDir, 'worker-test.json');
    const readHb = () => JSON.parse(fs.readFileSync(hbPath, 'utf8'));

    const seen = [];
    const withLockFn = async (instancesDir2, fn) => {
      seen.push(readHb()); // must already be "queued" -- fn() (which writes "working") hasn't run yet
      const result = await fn();
      seen.push(readHb()); // must now be "working"
      return result;
    };

    const localCall = async () => ({ response: 'plan text (no real change needed)', degenerate: null, attempts: 1 });
    await draftTask(task, { localCall, withLockFn });

    assert.equal(seen[0].status, 'queued');
    assert.equal(seen[0].currentPass, 'plan');
    assert.equal(seen[0].currentTaskId, 'hb-test-1');
    assert.equal(seen[1].status, 'working');
    assert.equal(seen[1].currentPass, 'plan');
    delete process.env.AGENT_MANAGER_INSTANCE_ID;
  });
});

test('draftTask writes no queued/working heartbeat at all when AGENT_MANAGER_INSTANCE_ID is unset', async () => {
  await withFixtureRepo(async (draftTask, dir) => {
    delete process.env.AGENT_MANAGER_INSTANCE_ID;
    const task = { id: 'hb-test-2', domain: 'default', source: 'observability_fix', title: 'test', promptContext: { candidateId: 'AC-9', title: 'x', files: [], fetchedFiles: [], body: '' } };
    const localCall = async () => ({ response: 'plan text', degenerate: null, attempts: 1 });

    await draftTask(task, { localCall, withLockFn: async (instancesDir2, fn) => fn() });

    assert.equal(fs.existsSync(path.join(dir, 'instances', 'undefined.json')), false, 'must not write a heartbeat keyed on a missing instance id');
  });
});

// --- arch_discovery / arch_import empty-plan handling ---------------------------
// 2026-08-29, root-caused live: arch-discovery-community-11 (src/gpu-guard.js + its test,
// a clean well-documented utility with no real architectural friction) blocked TWICE on
// "Plan pass degenerate: empty". arch_discovery is a GENERATOR registered emptyApproval:
// true -- its own plan prompt explicitly invites "found nothing" as the right answer, and
// an empty implement already auto-approves. But the plan call never passed allowEmpty, so
// a terse honest "nothing here" plan blocked instead of flowing to that path. community-10
// (same no-friction outcome) only passed because its model happened to write a 646-char
// paragraph first.

test('arch_discovery: the plan call is made with allowEmpty:true, so an empty "nothing found" plan does not block', async () => {
  await withFixtureRepo(async (draftTask, dir) => {
    fs.writeFileSync(path.join(dir, 'util.js'), '// a small clean utility\nmodule.exports.noop = () => {};\n');
    const task = {
      id: 'arch-discovery-empty-plan-1', domain: 'default', source: 'arch_discovery', title: 'test',
      promptContext: {
        communityId: 99, communityName: 'src',
        files: [{ path: 'util.js', degree: 1, content: '// a small clean utility\n' }],
        existingCandidatesTail: '(none yet)',
      },
    };
    const planOpts = [];
    const localCall = async (opts) => {
      planOpts.push(opts);
      return { response: '', degenerate: null, attempts: 1 }; // model looked, found nothing, said nothing
    };

    const result = await draftTask(task, { localCall, withLockFn: async (d, fn) => fn(), ...declineLocalTiers() });

    assert.equal(planOpts[0].allowEmpty, true, 'arch_discovery plan call must allow an empty result');
    assert.notEqual(result.blocked, true, 'an empty arch_discovery plan is "nothing found", not a failure');
    assert.equal(task.planResponse, '');
    assert.equal((task.history || []).some((h) => (h.detail || '').includes('Plan pass degenerate')), false);
  });
});

test('arch_review (candidate-fulfillment): the plan call is NOT allowed to be empty -- an empty plan still blocks', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'arch-review-empty-plan-1', domain: 'default', source: 'arch_review', title: 'test',
      promptContext: { candidateId: 'AC-1', title: 'a real queued change', body: 'Problem/Solution/Benefits', files: ['src/x.js'], fetchedFiles: [] },
    };
    const planOpts = [];
    const localCall = async (opts) => {
      planOpts.push(opts);
      return { response: '', degenerate: 'empty', attempts: 3 };
    };

    const result = await draftTask(task, { localCall, withLockFn: async (d, fn) => fn(), ...declineLocalTiers() });

    assert.notEqual(planOpts[0].allowEmpty, true, 'arch_review has a specific candidate to implement -- an empty plan there is a real model failure');
    assert.equal(result.blocked, true);
    assert.match(result.blockedReason, /Plan pass degenerate: empty/);
  });
});

// --- product_spec brownfield: local decompose -> fulfill (2026-08-30 redesign) --------
// Brownfield product_spec no longer has any special routing or subscription-agent path.
// The brownfield request goes to product_spec_outline, which is an ordinary local
// harnessSearch source -- normal runPlanPass (proposes QUERY: lines) -> harness grep ->
// runImplementPass. Greenfield product_spec is byte-for-byte unchanged.

test('brownfield lane: a product_spec_outline task runs the normal local plan+implement path (harness search, no Claude), lands needs-review', async () => {
  await withFixtureRepo(async (draftTask) => {
    let callCount = 0;
    const seenPrompts = [];
    const localCall = async (opts) => {
      seenPrompts.push(opts.prompt || '');
      callCount += 1;
      if (callCount === 1) return { response: 'QUERY: generate endpoint\n\n1. Data model section', degenerate: null, attempts: 1 };
      if (callCount === 2) {
        return {
          response: [
            '### AC-001 · Data Model',
            'Strength: Strong',
            'Files: server/app.py',
            '',
            'Problem:', 'The entities the request concerns.',
            'Solution:', 'Document the fields from server/app.py.',
            'Benefits:', 'Downstream tasks can rely on the shape.',
          ].join('\n'),
          degenerate: null, attempts: 1,
        };
      }
      return { response: 'NO ISSUES FOUND', degenerate: null, attempts: 1 }; // critique
    };
    const task = {
      id: 'product-spec-outline-bootstrap-1', domain: 'default', source: 'product_spec_outline', title: 'seed',
      promptContext: { requestText: 'document the generate endpoint', currentSpec: '', specExists: false, specRelPath: 'Docs/PRODUCT_SPEC.md', specMode: 'brownfield' },
    };

    const result = await draftTask(task, { localCall, withLockFn: async (d, fn) => fn() });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, false);
    assert.equal(task.status, 'needs-review');
    assert.match(seenPrompts[0], /scoping the SECTIONS/, 'the outline plan prompt was used');
    assert.ok((task.history || []).some((e) => e.stage === 'harness-search'), 'the harness-search step ran for this harnessSearch source');
    assert.match(task.implementResponse, /### AC-001 · Data Model/);
  });
});

test('greenfield product_spec: unchanged -- runs the normal local plan+implement path', async () => {
  await withFixtureRepo(async (draftTask) => {
    let sawPlanPrompt = false;
    const localCall = async (opts) => {
      if ((opts.prompt || '').includes('product specification document')) sawPlanPrompt = true;
      return { response: '{"mode":"create","file":"Docs/PRODUCT_SPEC.md","content":"# Spec"}', degenerate: null, attempts: 1 };
    };
    const task = {
      id: 'product-spec-bootstrap-1', domain: 'default', source: 'product_spec', title: 'seed',
      promptContext: { requestText: 'seed the spec', currentSpec: '', specExists: false, specRelPath: 'Docs/PRODUCT_SPEC.md', specMode: 'greenfield' },
    };
    const result = await draftTask(task, { localCall, withLockFn: async (d, fn) => fn() });
    assert.equal(result.succeeded, true);
    assert.equal(sawPlanPrompt, true, 'greenfield must still run the local plan pass');
  });
});
