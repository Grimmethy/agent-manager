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

// A plan string with enough substance (>=200 chars, >=2 numbered steps) to clear
// runPlanPass's adhoc thin-plan gate, so a test exercising downstream tier/lock/history
// behaviour doesn't also trip the one-time plan re-roll.
const PLAN_STUB = [
  '1. Read the files the task names and confirm the current behaviour before changing anything.',
  '2. Make the smallest change that satisfies the request, staying inside the files the task names.',
  '3. Run a targeted check on what changed and hand back the resulting diff for review.',
].join('\n');

function spyLock() {
  const calls = [];
  const withLockFn = async (dir, fn) => {
    calls.push('start');
    try { return await fn(); } finally { calls.push('end'); }
  };
  return { calls, withLockFn };
}

// The three LOCAL adhoc tiers (harness-search, read-only agentic, write agentic -- see
// local-draft.js's dispatch comment) are all injectable. `declineLocalTiers()` makes the
// first two decline and the write tier block-for-human, matching the real "no local tier
// could do this" outcome for tests not specifically exercising a tier. (2026-09-01: there
// is no Claude tier any more.)
function declineLocalTiers() {
  const decline = async () => ({ applied: false, succeeded: true, reason: 'declined by test stub' });
  return {
    draftAdhocViaHarnessSearchFn: decline,
    draftAdhocViaLocalAgenticFn: decline,
    draftAdhocViaLocalAgenticWriteFn: async () => ({ succeeded: true, blocked: true, blockedReason: 'all local adhoc tiers declined (test stub)' }),
  };
}

test('adhoc: plan + all three local tiers are lock-wrapped; nothing ever calls claude-client', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { calls, withLockFn } = spyLock();
    const task = { id: 'adhoc-test-1', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    await draftTask(task, {
      localCall: fakeLocalCall(PLAN_STUB),
      withLockFn,
      draftAdhocViaHarnessSearchFn: async () => ({ applied: false, succeeded: true, reason: 'no match' }),
      draftAdhocViaLocalAgenticFn: async () => ({ applied: false, succeeded: true, reason: 'declined' }),
      draftAdhocViaLocalAgenticWriteFn: async (t) => {
        t.adhocResolution = 'no-changes-needed';
        t.implementResponse = 'RESOLUTION: no-changes-needed\n\nnothing to do';
        return { succeeded: true, blocked: false };
      },
    });

    // plan + preliminary decompose-check + harness + read-only agentic + write agentic
    // = 5 lock cycles, all local. (The decompose-check returns non-JSON here so the task
    // falls through to the tiers.)
    assert.deepEqual(calls, ['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end', 'start', 'end']);
  });
});

// 2026-09-02: the preliminary decompose check. A fresh adhoc task, after its blind plan
// and BEFORE any agentic tier, gets one cheap model call that can split it. A split routes
// straight to needs-review with adhocResolution: 'decompose' -- no tier ever runs.
const DECOMPOSE_JSON = JSON.stringify({
  one_pass: false,
  subtasks: [
    { title: 'Add catalog schema module', rawText: 'Create a new self-contained catalog schema module.' },
    { title: 'Add GET /api/plugins', rawText: 'Add a GET /api/plugins endpoint reading the catalog.', after: 0 },
    { title: 'Add plugins UI tab', rawText: 'Add a dashboard Plugins tab listing entries.', after: 1 },
  ],
});
// localCall that answers the decompose-check prompt with a split and everything else with a plan.
function splittingLocalCall() {
  return async ({ prompt }) => ({
    response: /ONLY a JSON object/.test(prompt || '') ? DECOMPOSE_JSON : PLAN_STUB,
    degenerate: null, attempts: 1,
  });
}

test('adhoc: the preliminary check splits a fresh task straight to decompose, no tier runs', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-predecomp', domain: 'adhoc', source: 'manual', title: 'big thing', promptContext: { rawText: 'build the plugin catalog, endpoints and UI' } };
    let tierRan = false;
    const markTier = async () => { tierRan = true; return { applied: false, succeeded: true, reason: 'should not be reached' }; };

    const result = await draftTask(task, {
      localCall: splittingLocalCall(),
      withLockFn: async (d, fn) => fn(),
      draftAdhocViaHarnessSearchFn: markTier,
      draftAdhocViaLocalAgenticFn: markTier,
      draftAdhocViaLocalAgenticWriteFn: markTier,
    });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, false);
    assert.equal(tierRan, false, 'no agentic tier is invoked once the task is split up front');
    assert.equal(task.adhocResolution, 'decompose');
    assert.equal(task.subTaskProposals.length, 3);
    assert.equal(task.status, 'needs-review');
    assert.ok((task.history || []).some((e) => /preliminary size check -> decompose/.test(e.detail || '')));
  });
});

test('adhoc: the preliminary check is skipped on a retry (localRejectCount set)', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-predecomp-retry', domain: 'adhoc', source: 'manual', title: 'big thing', localRejectCount: 1, promptContext: { rawText: 'build the plugin catalog, endpoints and UI' } };
    let decomposeAsked = false;

    await draftTask(task, {
      localCall: async ({ prompt }) => {
        if (/ONLY a JSON object/.test(prompt || '')) decomposeAsked = true;
        return { response: PLAN_STUB, degenerate: null, attempts: 1 };
      },
      withLockFn: async (d, fn) => fn(),
      ...declineLocalTiers(),
    });

    assert.equal(decomposeAsked, false, 'a retry goes straight back down the tier ladder');
    assert.notEqual(task.adhocResolution, 'decompose');
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

    const draftAdhocViaLocalAgenticWriteFn = async (t) => {
      t.adhocResolution = 'needs-human-decision';
      t.implementResponse = 'Which charting library should this use?';
      return { succeeded: true, blocked: false, needsClarification: true };
    };

    const { withLockFn } = spyLock();
    const result = await draftTask(task, {
      localCall: fakeLocalCall('no real match -- nothing plausible'),
      withLockFn,
      draftAdhocViaHarnessSearchFn: async () => ({ applied: false, succeeded: true, reason: 'no match' }),
      draftAdhocViaLocalAgenticFn: async () => ({ applied: false, succeeded: true, reason: 'declined' }),
      draftAdhocViaLocalAgenticWriteFn,
    });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, false);
    assert.equal(result.needsClarification, true);
    assert.equal(task.status, undefined, 'must NOT be routed into the normal needs-review flow');
    assert.deepEqual(task.needsClarification, { reason: 'design-decision', openQuestions: 'Which charting library should this use?' });
  });
});

// 2026-09-01: a declined read-only tier 2 does real exploration; forward its map into
// tier 3 so tier 3 doesn't re-orient from cold and run out of turns before it edits.
test('adhoc: a declined tier-2 investigationSummary reaches tier 3 as task._priorInvestigation and is never persisted', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { withLockFn } = spyLock();
    const task = { id: 'adhoc-fwd', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };
    let seenAtTier3;

    const result = await draftTask(task, {
      localCall: fakeLocalCall('no confident match'),
      withLockFn,
      draftAdhocViaHarnessSearchFn: async () => ({ applied: false, succeeded: true, reason: 'no match' }),
      draftAdhocViaLocalAgenticFn: async () => ({
        applied: false, succeeded: true, reason: 'local agentic investigation did not end with a RESOLUTION: line',
        investigationSummary: 'Files already read: python/dashboard/app.py\nSearches that returned NOTHING: "/api/chat/inject" in python',
      }),
      draftAdhocViaLocalAgenticWriteFn: async (t) => {
        seenAtTier3 = t._priorInvestigation;
        t.adhocResolution = 'implemented';
        t.implementResponse = 'RESOLUTION: implemented\ndone';
        return { succeeded: true, blocked: false };
      },
    });

    assert.equal(result.succeeded, true);
    assert.match(seenAtTier3, /Files already read: python\/dashboard\/app\.py/);
    assert.equal(task._priorInvestigation, undefined, 'transient -- deleted after tier 3, never persisted');
  });
});

function seedWidget(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'widget.js'), 'function updateWidgetCache() { return WIDGET_CACHE; }\n');
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
}

test('adhoc: the orient pass runs, stamps orientNotes + oriented + orient-done history, and feeds tier 3', async () => {
  await withFixtureRepo(async (draftTask, dir) => {
    seedWidget(dir);
    const { withLockFn } = spyLock();
    const task = { id: 'adhoc-orient', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'change updateWidgetCache in src/widget.js' } };
    let seenAtTier3;
    await draftTask(task, {
      localCall: fakeLocalCall(PLAN_STUB),
      withLockFn,
      runOrientPassFn: async () => ({ notes: 'CURRENT STATE: widget.js has a cache\nEDIT LOCATION: src/widget.js:40', turnsUsed: 4, skipped: false }),
      draftAdhocViaHarnessSearchFn: async () => ({ applied: false, succeeded: true, reason: 'no match' }),
      draftAdhocViaLocalAgenticFn: async () => ({ applied: false, succeeded: true, reason: 'declined' }),
      draftAdhocViaLocalAgenticWriteFn: async (t) => { seenAtTier3 = t._priorInvestigation; t.adhocResolution = 'implemented'; t.implementResponse = 'RESOLUTION: implemented\ndone'; return { succeeded: true, blocked: false }; },
    });
    assert.equal(task.oriented, true);
    assert.match(task.orientNotes, /CURRENT STATE: widget\.js has a cache/);
    assert.ok((task.history || []).some((h) => h.stage === 'orient-done'));
    assert.match(seenAtTier3, /Pre-plan orientation report/);
    assert.match(seenAtTier3, /EDIT LOCATION: src\/widget\.js:40/);
  });
});

test('adhoc: a skipped orient pass records orient-done "skipped" and does NOT set oriented/orientNotes', async () => {
  await withFixtureRepo(async (draftTask, dir) => {
    seedWidget(dir);
    const { withLockFn } = spyLock();
    const task = { id: 'adhoc-orient-skip', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'tweak updateWidgetCache in src/widget.js' } };
    await draftTask(task, {
      localCall: fakeLocalCall(PLAN_STUB), withLockFn,
      runOrientPassFn: async () => ({ notes: 'grep text', turnsUsed: 0, skipped: true }),
      ...declineLocalTiers(),
    });
    assert.notEqual(task.oriented, true);
    assert.equal(task.orientNotes, undefined);
    assert.ok((task.history || []).some((h) => h.stage === 'orient-done' && /skipped/.test(h.detail || '')));
  });
});

test('adhoc: AGENT_MANAGER_ADHOC_ORIENT=false disables the orient pass entirely', async () => {
  await withFixtureRepo(async (draftTask, dir) => {
    seedWidget(dir);
    process.env.AGENT_MANAGER_ADHOC_ORIENT = 'false';
    try {
      const { withLockFn } = spyLock();
      const task = { id: 'adhoc-orient-off', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'edit updateWidgetCache in src/widget.js' } };
      let ran = false;
      await draftTask(task, {
        localCall: fakeLocalCall(PLAN_STUB), withLockFn,
        runOrientPassFn: async () => { ran = true; return { notes: '', turnsUsed: 0, skipped: true }; },
        ...declineLocalTiers(),
      });
      assert.equal(ran, false);
      assert.ok(!(task.history || []).some((h) => h.stage === 'orient-done'));
    } finally { delete process.env.AGENT_MANAGER_ADHOC_ORIENT; }
  });
});

test('adhoc: plan-critique (flag on) runs once, a "gaps" verdict triggers exactly one bounded re-plan', async () => {
  await withFixtureRepo(async (draftTask, dir) => {
    seedWidget(dir);
    process.env.AGENT_MANAGER_ADHOC_PLAN_CRITIQUE = 'true';
    try {
      let planCalls = 0; let critiqueCalls = 0;
      const task = { id: 'adhoc-critique', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'change updateWidgetCache in src/widget.js' } };
      await draftTask(task, {
        localCall: async ({ prompt }) => { if (/numbered, actionable PLAN/.test(prompt)) planCalls += 1; return { response: PLAN_STUB, degenerate: null, attempts: 1 }; },
        ...spyLock(),
        runOrientPassFn: async () => ({ notes: '', turnsUsed: 0, skipped: true }),
        runPlanCritiqueFn: async () => { critiqueCalls += 1; return { verdict: 'gaps', gaps: ['MISSING_REQUIREMENT no widget', 'SCOPE_TOO_BIG spans many files'], viaModel: true }; },
        ...declineLocalTiers(),
      });
      assert.equal(critiqueCalls, 1, 'critique runs once');
      assert.equal(planCalls, 2, 'one initial plan + one re-plan');
      assert.ok((task.history || []).some((h) => h.stage === 'plan-critique-done'));
      assert.equal(task._planCritiqueFeedback, undefined, 'transient feedback cleared');
    } finally { delete process.env.AGENT_MANAGER_ADHOC_PLAN_CRITIQUE; }
  });
});

test('adhoc: plan-critique is OFF by default (no flag) -- runPlanCritiqueFn never called', async () => {
  await withFixtureRepo(async (draftTask, dir) => {
    seedWidget(dir);
    let called = false;
    const task = { id: 'adhoc-nocritique', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'change updateWidgetCache in src/widget.js' } };
    await draftTask(task, {
      localCall: fakeLocalCall(PLAN_STUB), ...spyLock(),
      runOrientPassFn: async () => ({ notes: '', turnsUsed: 0, skipped: true }),
      runPlanCritiqueFn: async () => { called = true; return { verdict: 'ok', gaps: [] }; },
      ...declineLocalTiers(),
    });
    assert.equal(called, false);
  });
});

test('adhoc: tier 3 gets no _priorInvestigation when tier 2 produced no investigation summary', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { withLockFn } = spyLock();
    const task = { id: 'adhoc-fwd-none', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };
    let seenAtTier3 = 'SENTINEL';

    await draftTask(task, {
      localCall: fakeLocalCall('no confident match'),
      withLockFn,
      draftAdhocViaHarnessSearchFn: async () => ({ applied: false, succeeded: true, reason: 'no match' }),
      draftAdhocViaLocalAgenticFn: async () => ({ applied: false, succeeded: true, reason: 'declined' }),
      draftAdhocViaLocalAgenticWriteFn: async (t) => {
        seenAtTier3 = t._priorInvestigation;
        t.adhocResolution = 'no-changes-needed';
        t.implementResponse = 'nothing';
        return { succeeded: true, blocked: false };
      },
    });

    assert.equal(seenAtTier3, undefined);
  });
});

test('adhoc: every tier lock-cycle is fully closed before the next tier runs (no nesting)', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { calls, withLockFn } = spyLock();
    const task = { id: 'adhoc-test-2', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };
    let callsAtWriteTier = null;

    const draftAdhocViaLocalAgenticWriteFn = async (t) => {
      callsAtWriteTier = calls.slice();
      t.adhocResolution = 'no-changes-needed';
      t.implementResponse = 'RESOLUTION: no-changes-needed\n\nnothing to do';
      return { succeeded: true, blocked: false };
    };

    const result = await draftTask(task, {
      localCall: fakeLocalCall('confident match: none -- no real match'),
      withLockFn,
      draftAdhocViaHarnessSearchFn: async () => ({ applied: false, succeeded: true, reason: 'no match' }),
      draftAdhocViaLocalAgenticFn: async () => ({ applied: false, succeeded: true, reason: 'declined' }),
      draftAdhocViaLocalAgenticWriteFn,
    });

    assert.equal(result.succeeded, true);
    assert.equal(calls.length % 2, 0, 'all lock cycles closed by the end');
    assert.ok(calls.length >= 8, 'plan + harness + read-only + write agentic each locked');
    // The write tier runs inside its OWN (single) lock -- every earlier tier's lock is
    // already released, so exactly one `start` is unmatched at that point.
    const starts = callsAtWriteTier.filter((c) => c === 'start').length;
    const ends = callsAtWriteTier.filter((c) => c === 'end').length;
    assert.equal(starts - ends, 1);
    assert.equal(callsAtWriteTier[callsAtWriteTier.length - 1], 'start');
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
    const draftAdhocViaLocalAgenticWriteFn = async () => { throw new Error('must not reach the write tier when harness-search already applied'); };

    const result = await draftTask(task, {
      localCall: fakeLocalCall(PLAN_STUB),
      withLockFn, draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocViaLocalAgenticWriteFn,
    });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, false);
    assert.equal(task.status, 'needs-review');
    // plan pass + preliminary decompose-check + the applied harness-search tier = 3 lock
    // cycles; the read-only and write tiers are never reached.
    assert.deepEqual(calls, ['start', 'end', 'start', 'end', 'start', 'end']);
  });
});

// draft-done (2026-08-31, brain dump #6): the draft phase now bookends itself with an
// explicit 'draft-done' history checkpoint before the terminal 'needs-review', so the
// dashboard's Pipeline History shows drafting finishing -- not just the next state opening.
test('a successful draft appends draft-done immediately before needs-review, after implement-done', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-dd-1', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };
    const draftAdhocViaHarnessSearchFn = async (t) => {
      t.implementResponse = 'x';
      t.adhocResolution = 'implemented';
      t.draftModel = 'test-local-model';
      return { applied: true, succeeded: true };
    };
    await draftTask(task, {
      localCall: fakeLocalCall('confident match: none'),
      withLockFn: async (d, fn) => fn(),
      draftAdhocViaHarnessSearchFn,
      draftAdhocViaLocalAgenticFn: async () => { throw new Error('unused'); },
      draftAdhocViaLocalAgenticWriteFn: async () => { throw new Error('unused'); },
    });
    const stages = (task.history || []).map((e) => e.stage);
    const dd = stages.indexOf('draft-done');
    const nr = stages.indexOf('needs-review');
    assert.ok(dd !== -1, 'a draft-done event was appended');
    assert.equal(nr, dd + 1, 'draft-done sits immediately before needs-review');
    assert.ok(stages.indexOf('implement-done') !== -1 && stages.indexOf('implement-done') < dd, 'implement-done still precedes draft-done');
    const ev = task.history[dd];
    assert.ok(!Number.isNaN(Date.parse(ev.at)), 'draft-done.at is an ISO timestamp');
    assert.match(ev.detail, /resolution=implemented/);
    assert.match(ev.detail, /test-local-model/);
  });
});

test('a persist hook registered around a draft is flushed on every checkpoint, seeing history grow (not just once at the end)', async () => {
  const { setHistoryPersistHook } = require('./task-history.js');
  await withFixtureRepo(async (draftTask) => {
    const snapshots = [];
    // main() registers exactly this shape of hook (there it rewrites the task JSON).
    setHistoryPersistHook((t) => snapshots.push((t.history || []).map((e) => e.stage)));
    try {
      const task = { id: 'adhoc-flush-1', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };
      await draftTask(task, {
        localCall: fakeLocalCall('confident match: none'),
        withLockFn: async (d, fn) => fn(),
        draftAdhocViaHarnessSearchFn: async (t) => {
          t.implementResponse = 'x'; t.adhocResolution = 'implemented'; t.draftModel = 'test-local-model';
          return { applied: true, succeeded: true };
        },
        draftAdhocViaLocalAgenticFn: async () => { throw new Error('unused'); },
        draftAdhocViaLocalAgenticWriteFn: async () => { throw new Error('unused'); },
      });
      assert.ok(snapshots.length >= 3, `hook fired for each checkpoint mid-draft, not once at the end (got ${snapshots.length})`);
      assert.deepEqual(snapshots[0], ['draft-started'], 'first flush happens as soon as the draft starts, before any model work');
      for (let i = 1; i < snapshots.length; i += 1) {
        assert.ok(snapshots[i].length >= snapshots[i - 1].length, 'each flush sees history at least as long as the previous');
      }
      const last = snapshots[snapshots.length - 1];
      assert.ok(last.includes('draft-done') && last.includes('needs-review'), 'the final flush carries the terminal checkpoints');
    } finally {
      setHistoryPersistHook(null);
    }
  });
});

test('draftDoneDetail summarises whatever the branch stamped, and is undefined when there is nothing', () => {
  const { draftDoneDetail } = require('./local-draft.js');
  assert.equal(draftDoneDetail({}), undefined);
  assert.equal(draftDoneDetail({ adhocResolution: 'no-changes-needed' }), 'resolution=no-changes-needed');
  assert.equal(
    draftDoneDetail({ adhocResolution: 'implemented', localRejectCount: 2, draftModelDisplay: 'claude:sonnet' }),
    'resolution=implemented, retry 2, claude:sonnet',
  );
  assert.equal(draftDoneDetail({ draftModel: 'qwen' }), 'qwen');
});

// 2026-08-31: implNumCtx used to vary per-prompt (usually landing on an 8192 floor), so a
// draft's implement pass flipped num_ctx away from the plan pass's PINNED_NUM_CTX and
// Ollama fully reloaded the model (~55-100s) while holding the single-flight GPU lock ->
// `flock -w 600` lock-acquisition timeouts under lane contention. The floor is now
// PINNED_NUM_CTX so the normal case is one stable value shared with every other call.
test('computeImplementBudget floors implNumCtx at PINNED_NUM_CTX for a normal-sized prompt (no per-draft model reload)', () => {
  const { computeImplementBudget } = require('./local-draft.js');
  const { PINNED_NUM_CTX } = require('./gpu-capacity.js');
  const task = { source: 'manual', planResponse: 'x'.repeat(1500) };
  const b = computeImplementBudget(task, 'a normal implement prompt '.repeat(120)); // ~3KB
  assert.equal(b.implNumCtx, PINNED_NUM_CTX, 'a normal prompt gets exactly the pinned value, not the old 8192 floor');
});

test('computeImplementBudget still grows implNumCtx past the floor for a whole-document source, capped at 32768', () => {
  const { computeImplementBudget } = require('./local-draft.js');
  const { PINNED_NUM_CTX } = require('./gpu-capacity.js');
  // product_spec: implNumPredict ceiling 16000, and a large prompt -> genuine need above the floor
  const task = { source: 'product_spec', planResponse: 'y'.repeat(9000) };
  const big = computeImplementBudget(task, 'z'.repeat(80000));
  assert.ok(big.implNumCtx > PINNED_NUM_CTX, 'a genuinely large document prompt is still allowed to exceed the floor');
  assert.ok(big.implNumCtx <= 32768, 'still capped at 32768');
});

test('computeImplementBudget gives pipeline_forensics a large implement budget despite a tiny plan', () => {
  const { computeImplementBudget } = require('./local-draft.js');
  const tinyPlan = { source: 'pipeline_forensics', planResponse: 'QUERY: a\nQUERY: b', promptContext: { evidenceText: 'x'.repeat(24000) } };
  const b = computeImplementBudget(tinyPlan, 'z'.repeat(20000));
  assert.ok(b.implNumPredict >= 6000, `floor should clear the report length, got ${b.implNumPredict}`);
  assert.ok(b.implNumPredict <= 16000, 'capped at the whole-document ceiling');
  assert.equal(b.allowEmptyImplement, false, 'an empty forensic report is a failure, not a valid answer');

  // think is disabled for the forensic report -- the prompt's METHOD section already
  // structures the reasoning into the output, and think:true otherwise spends the whole
  // num_predict budget on a redundant reasoning trace and emits nothing (live 2026-09-01).
  assert.equal(b.implNoThink, true);

  // contrast: a normal source with the same tiny plan stays at the 2800 floor, think on
  const normal = computeImplementBudget({ source: 'manual', planResponse: 'QUERY: a\nQUERY: b' }, 'z'.repeat(20000));
  assert.equal(normal.implNumPredict, 2800);
  assert.equal(normal.implNoThink, false);
});

test('computeImplementBudget never returns implNumCtx below PINNED_NUM_CTX, even for a tiny fixed-literals task', () => {
  const { computeImplementBudget } = require('./local-draft.js');
  const { PINNED_NUM_CTX } = require('./gpu-capacity.js');
  const task = { source: 'manual', planResponse: 'p', promptContext: { fixedLiterals: [{ content: 'tiny block' }] } };
  const b = computeImplementBudget(task, 'short');
  assert.equal(b.hasFixedLiterals, true);
  assert.ok(b.implNumCtx >= PINNED_NUM_CTX);
});

test('an adhoc task where harness-search declines but local-agentic (read-only) applies -- never reaches the write tier', async () => {
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
    const draftAdhocViaLocalAgenticWriteFn = async () => { throw new Error('must not reach the write tier when the read-only tier already applied'); };

    const result = await draftTask(task, {
      localCall: fakeLocalCall('confident match: none -- no real match'),
      withLockFn, draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocViaLocalAgenticWriteFn,
    });

    assert.equal(result.succeeded, true);
    assert.equal(task.adhocResolution, 'implemented');
  });
});

// 2026-09-01: adhoc has no Claude tier. When every local tier (harness-search, read-only
// agentic, write agentic) declines/can't do it, the task BLOCKS for a human -- it never
// reaches out to claude-client, and Claude's paused state is irrelevant.
test('an adhoc task blocks for a human (no Claude) when all three local tiers decline', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-test-all-decline', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    const result = await draftTask(task, {
      localCall: fakeLocalCall('confident match: none -- no real match'),
      withLockFn: async (dir2, fn) => fn(),
      ...declineLocalTiers(),
    });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, true);
    assert.match(result.blockedReason, /local adhoc tiers declined/);
    assert.equal(task.status, undefined, 'not routed into needs-review');
  });
});

// 2026-08-31 ("the task log gets cut short"): the adhoc tier ladder used to emit no
// history between 'plan-done' and its terminal event, so a draft killed mid-ladder (or
// looping in the multi-minute tier 3) showed only '...-> plan-done'. Each tier now emits
// an 'implement-started' breadcrumb as it's entered.
test('the adhoc tier ladder emits an implement-started checkpoint for each tier it enters', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-tier-crumbs', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    await draftTask(task, {
      localCall: fakeLocalCall('confident match: none -- no real match'),
      withLockFn: async (d, fn) => fn(),
      ...declineLocalTiers(), // harness + read-only decline; write tier blocks for a human
    });

    const started = (task.history || []).filter((e) => e.stage === 'implement-started').map((e) => e.detail);
    assert.equal(started.length, 3, 'one implement-started per tier (harness, read-only agentic, write agentic)');
    assert.match(started[0], /tier 1\/3: harness-search/);
    assert.match(started[1], /tier 2\/3: local-agentic/);
    assert.match(started[2], /tier 3\/3: local-agentic-write/);

    const stages = (task.history || []).map((e) => e.stage);
    // the tier-3 breadcrumb lands BEFORE the terminal 'blocked' -- so a draft killed
    // inside tier 3 still shows it got that far.
    assert.ok(stages.lastIndexOf('implement-started') < stages.indexOf('blocked'));
  });
});

test('a successful cheap-tier adhoc draft names which tier applied in implement-done', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-tier-named', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };
    await draftTask(task, {
      localCall: fakeLocalCall('confident match: none'),
      withLockFn: async (d, fn) => fn(),
      draftAdhocViaHarnessSearchFn: async (t) => { t.implementResponse = 'x'; t.adhocResolution = 'implemented'; t.draftModel = 'test-local-model'; return { applied: true, succeeded: true }; },
      draftAdhocViaLocalAgenticFn: async () => { throw new Error('unused'); },
      draftAdhocViaLocalAgenticWriteFn: async () => { throw new Error('unused'); },
    });
    const done = (task.history || []).find((e) => e.stage === 'implement-done');
    assert.match(done.detail, /harness-search tier applied/);
    // tier 2 was never entered, so only tier 1's implement-started exists
    assert.equal((task.history || []).filter((e) => e.stage === 'implement-started').length, 1);
  });
});

// 2026-09-01: research_task has no local implementation (WebSearch/WebFetch are Claude-
// only). With no AGENT_MANAGER_CLAUDE_SOURCES it blocks CLEANLY, before the plan pass,
// with a legible reason -- it does NOT wedge or call Claude.
test('a research task blocks cleanly with a "needs Claude" reason when not opted into AGENT_MANAGER_CLAUDE_SOURCES', async () => {
  await withFixtureRepo(async (draftTask) => {
    delete process.env.AGENT_MANAGER_CLAUDE_SOURCES;
    const task = {
      id: 'research-test-noclaude', domain: 'research', source: 'research_task', title: 'test',
      promptContext: { rawText: 'investigate something', tags: [] },
    };

    let planCalled = false;
    const localCall = async () => { planCalled = true; return { response: 'plan', degenerate: null, attempts: 1 }; };
    const draftResearchImplementFn = async () => { throw new Error('must not call Claude'); };

    const result = await draftTask(task, { localCall, withLockFn: async (dir2, fn) => fn(), draftResearchImplementFn });

    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, true);
    assert.match(result.blockedReason, /Claude Code CLI \(WebSearch\/WebFetch\)/);
    assert.equal(planCalled, false, 'blocked before the plan pass even ran');
  });
});

// research still works when explicitly opted in + a token is set + not paused.
test('a research task runs its Claude implement pass when research_task IS in AGENT_MANAGER_CLAUDE_SOURCES (token set, not paused)', async () => {
  await withFixtureRepo(async (draftTask) => {
    process.env.AGENT_MANAGER_CLAUDE_SOURCES = 'research_task';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    const task = {
      id: 'research-test-optedin', domain: 'research', source: 'research_task', title: 'test',
      promptContext: { rawText: 'investigate something', tags: [] },
    };
    let claudeCalled = false;
    const draftResearchImplementFn = async (t) => {
      claudeCalled = true;
      t.implementResponse = 'research write-up';
      return { succeeded: true, blocked: false };
    };
    try {
      await draftTask(task, {
        localCall: async () => ({ response: 'plan', degenerate: null, attempts: 1 }),
        withLockFn: async (dir2, fn) => fn(), draftResearchImplementFn, isClaudePausedFn: () => false,
      });
      assert.equal(claudeCalled, true);
    } finally {
      delete process.env.AGENT_MANAGER_CLAUDE_SOURCES;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });
});

test('an adhoc task reaches the local write-agentic tier when harness + read-only both decline', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-test-write-tier', domain: 'adhoc', source: 'manual', title: 'test', promptContext: { rawText: 'do the thing' } };

    let writeTierCalled = false;
    const draftAdhocViaLocalAgenticWriteFn = async (t) => {
      writeTierCalled = true;
      t.adhocResolution = 'implemented';
      t.rawDiff = 'diff --git a/x b/x';
      t.implementResponse = 'RESOLUTION: implemented\n\ndid the thing';
      return { succeeded: true, blocked: false };
    };

    const result = await draftTask(task, {
      localCall: fakeLocalCall('confident match: none -- no real match'),
      withLockFn: async (dir2, fn) => fn(),
      draftAdhocViaHarnessSearchFn: async () => ({ applied: false, succeeded: true, reason: 'no match' }),
      draftAdhocViaLocalAgenticFn: async () => ({ applied: false, succeeded: true, reason: 'declined' }),
      draftAdhocViaLocalAgenticWriteFn,
    });

    assert.equal(writeTierCalled, true);
    assert.equal(result.succeeded, true);
    assert.equal(result.blocked, false);
    assert.equal(task.status, 'needs-review');
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

// Cross-repo (2026-09-04): an 'archImport'-kind source's harness search must ALSO reach a
// loaded plugin repo -- root-caused via a stuck adhoc task whose real fix site lived
// entirely in agent-manager-hygiene. Real fetch (not faked, unlike projectSearchFetch
// above) so this actually exercises resolveAccessibleRoots() -> archImportFetch wiring.
test('draftTask (archImport-kind source) also finds a real match in a loaded plugin repo', async () => {
  // The plugins.json manifest must be in place BEFORE local-draft.js (and the
  // accessible-roots.js it requires) load fresh inside withFixtureRepo -- plugins-
  // manifest.js resolves its path from AGENT_MANAGER_PLUGINS_MANIFEST at module load, so
  // setting the env var / clearing caches AFTER local-draft.js is already loaded would
  // leave it holding a stale resolveAccessibleRoots reference.
  const pluginRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-draft-plugin-'));
  fs.mkdirSync(path.join(pluginRepo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pluginRepo, 'src', 'function-length-review.js'), 'function registerFunctionLengthFix() {}\n');
  const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-draft-manifest-'));
  const manifestPath = path.join(manifestDir, 'plugins.json');
  fs.writeFileSync(manifestPath, JSON.stringify([{ name: 'plugin', registerPath: path.join(pluginRepo, 'register.js'), enabled: true }]));
  process.env.AGENT_MANAGER_PLUGINS_MANIFEST = manifestPath;
  delete require.cache[require.resolve('./plugins-manifest.js')];
  delete require.cache[require.resolve('./accessible-roots.js')];

  try {
    await withFixtureRepo(async (draftTask, dir) => {
      const { registerTaskSource, updateTaskSource } = require('./task-source-registry.js');
      const p = require('./prompts.js');
      registerTaskSource('sa4_probe_archimport', { priority: 80, next: () => null, emptyApproval: true, harnessSearch: 'archImport' });
      updateTaskSource('sa4_probe_archimport', { buildPlanPrompt: p.archImportPlanPrompt, buildImplementPrompt: p.archImportImplementPrompt });

      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'unrelated.js'), 'const nothing = 1;\n');
      process.env.AGENT_MANAGER_GREP_DIRS = 'src';

      const localCall = async () => ({ response: 'QUERY: registerFunctionLengthFix', degenerate: null, attempts: 1 });
      const task = { id: 'sa4-archimport', domain: 'default', source: 'sa4_probe_archimport', title: 't', promptContext: {} };
      await draftTask(task, { localCall, withLockFn: async (d, fn) => fn() }).catch(() => {});

      assert.ok(task.promptContext.harnessHits.some((h) => h.file === 'src/function-length-review.js' && h.root === fs.realpathSync(pluginRepo)));
      assert.ok(task.promptContext.harnessFiles.some((f) => f.path === 'src/function-length-review.js' && f.root === fs.realpathSync(pluginRepo)));
    });
  } finally {
    delete process.env.AGENT_MANAGER_PLUGINS_MANIFEST;
    delete require.cache[require.resolve('./plugins-manifest.js')];
    delete require.cache[require.resolve('./accessible-roots.js')];
    delete require.cache[require.resolve('./local-draft.js')]; // undo the plugin-aware local-draft.js this test forced -- later tests must get a fresh, non-plugin-aware one
  }
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
    const localCall = async () => { callCount += 1; return { response: PLAN_STUB, degenerate: null, attempts: 1 }; };

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
  assert.deepEqual(findUnverifiedEdit(bad, fetchedFiles), { file: 'src/task-sources.js', find: 'this text is not in the file', problem: 'find-missing' });

  const good = JSON.stringify({ mode: 'edit', file: 'src/task-sources.js', find: 'return 1;', replace: 'return 2;' });
  assert.equal(findUnverifiedEdit(good, fetchedFiles), null);
});

test('findUnverifiedEdit: wrong-block -- find is real but far from the flagged snippet', () => {
  const { findUnverifiedEdit } = require('./local-draft.js');
  const content = [
    'def a():', '    try:', '        x()', '    except OSError:', '        pass   # block A',
    ...Array(30).fill('    filler_line_that_is_long_enough_to_push_offset()'),
    'def b():', '    try:', '        y()', '    except Exception:', '        return None   # block B (the flagged one)',
  ].join('\n');
  const files = [{ path: 'm.py', content }];
  const snippet = '    except Exception:\n        return None   # block B (the flagged one)';
  const wrong = JSON.stringify({ mode: 'edit', file: 'm.py', find: '    except OSError:\n        pass   # block A', replace: 'x' });
  const r = findUnverifiedEdit(wrong, files, { anchorSnippet: snippet });
  assert.equal(r.problem, 'wrong-block');
  assert.equal(r.anchorSnippet, snippet.trim());

  const right = JSON.stringify({ mode: 'edit', file: 'm.py', find: '        return None   # block B (the flagged one)', replace: 'x' });
  assert.equal(findUnverifiedEdit(right, files, { anchorSnippet: snippet }), null);
});

test('findUnverifiedEdit: wrong-block check is skipped when the snippet cannot be located (no false positive)', () => {
  const { findUnverifiedEdit } = require('./local-draft.js');
  const files = [{ path: 'm.py', content: 'def a():\n    try:\n        x()\n    except OSError:\n        pass\n' }];
  const wrong = JSON.stringify({ mode: 'edit', file: 'm.py', find: '    except OSError:\n        pass', replace: 'x' });
  assert.equal(findUnverifiedEdit(wrong, files, { anchorSnippet: 'some paraphrased snippet not literally in the file at all' }), null);
});

test('findUnverifiedEdit: duplicate-import -- edit re-adds an import the file already has', () => {
  const { findUnverifiedEdit } = require('./local-draft.js');
  const files = [{ path: 'm.py', content: 'import os\nimport logging\n\ndef f():\n    try:\n        g()\n    except Exception:\n        pass\n' }];
  const dup = JSON.stringify({ mode: 'edit', file: 'm.py', find: '        pass', replace: 'import logging\n        logging.getLogger(__name__).warning("x")' });
  assert.equal(findUnverifiedEdit(dup, files).problem, 'duplicate-import');

  // rewriting the existing import line is fine (not a second copy)
  const rewrite = JSON.stringify({ mode: 'edit', file: 'm.py', find: 'import logging', replace: 'import logging  # noqa' });
  assert.equal(findUnverifiedEdit(rewrite, files), null);
});

test('findUnverifiedEdit: helper-not-wired -- diff defines a function nothing calls', () => {
  const { findUnverifiedEdit } = require('./local-draft.js');
  const files = [{ path: 'src/w.js', content: 'function draftAdhocViaLocalAgenticWrite() {\n  const r = run();\n  return r;\n}\n' }];
  // adds finalizeResolution but never calls it (pipeline-forensics-fix-ac-6 shape)
  const bad = JSON.stringify({ mode: 'edit', file: 'src/w.js', find: 'return r;\n}', replace: 'return r;\n}\n\nfunction finalizeResolution(s) {\n  return s.includes("RESOLUTION:") ? s : s + "\\nRESOLUTION: implemented";\n}' });
  assert.deepEqual(findUnverifiedEdit(bad, files), { problem: 'helper-not-wired', helper: 'finalizeResolution', file: 'src/w.js' });

  // wired in a second edit -> fine
  const wired = JSON.stringify([
    { mode: 'edit', file: 'src/w.js', find: 'return r;\n}', replace: 'return finalizeResolution(r);\n}\n\nfunction finalizeResolution(s) {\n  return s;\n}' },
  ]);
  assert.equal(findUnverifiedEdit(wired, files), null);
});

test('findUnverifiedEdit: files-incomplete -- a 2-file candidate whose diff only touches one', () => {
  const { findUnverifiedEdit } = require('./local-draft.js');
  const files = [
    { path: 'src/a.js', content: 'const a = 1;\n' },
    { path: 'src/b.js', content: 'const b = 2;\n' },
  ];
  const onlyA = JSON.stringify({ mode: 'edit', file: 'src/a.js', find: 'const a = 1;', replace: 'const a = 10;' });
  const r = findUnverifiedEdit(onlyA, files, { declaredFiles: ['src/a.js', 'src/b.js'] });
  assert.equal(r.problem, 'files-incomplete');
  assert.deepEqual(r.missing, ['src/b.js']);

  const both = JSON.stringify([
    { mode: 'edit', file: 'src/a.js', find: 'const a = 1;', replace: 'const a = 10;' },
    { mode: 'edit', file: 'src/b.js', find: 'const b = 2;', replace: 'const b = 20;' },
  ]);
  assert.equal(findUnverifiedEdit(both, files, { declaredFiles: ['src/a.js', 'src/b.js'] }), null);
});

test('extractCandidateSnippet pulls the Snippet: fenced block from a candidate body', () => {
  const { extractCandidateSnippet } = require('./local-draft.js');
  const body = '### AC-9 · Title\nStrength: Strong\nFiles: m.py\nSnippet:\n```python\n    except Exception:\n        pass\n```\n\nProblem:\n...';
  assert.equal(extractCandidateSnippet(body), '    except Exception:\n        pass');
  assert.equal(extractCandidateSnippet('no snippet here'), '');
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

test('draftTask accepts a split from a noCandidateSplit source when the pre-split gate marked it mustPreSplit, and stamps children Split-Depth 1', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'pipeline-forensics-fix-presplit-1', domain: 'default', source: 'pipeline_forensics_fix', title: 'test',
      promptContext: {
        candidateId: 'AC-9', title: 'x', files: ['src/a.js', 'src/b.js'],
        fetchedFiles: [{ path: 'src/a.js', content: 'const a=1;\n' }, { path: 'src/b.js', content: 'const b=2;\n' }],
        body: 'Files: src/a.js, src/b.js', splitDepth: 0, mustPreSplit: true,
      },
    };
    let n = 0;
    const localCall = async () => {
      n += 1;
      if (n === 1) return { response: 'plan text', degenerate: null, attempts: 1 };
      return { response: JSON.stringify({ mode: 'split', candidates: [
        { title: 'edit a', problem: 'p1', solution: 's1', benefits: 'b1', files: 'src/a.js' },
        { title: 'edit b', problem: 'p2', solution: 's2', benefits: 'b2', files: 'src/b.js' },
      ] }), degenerate: null, attempts: 1 };
    };
    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });
    assert.equal(task.candidateSplitProposals.length, 2);
    assert.equal(task.candidateSplitProposals[0].splitDepth, 1);
    assert.equal(task.status, 'needs-review');
  });
});

test('draftTask blocks (recursion stop) when a Split-Depth 1 candidate itself emits a split', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'pipeline-forensics-fix-depthcap-1', domain: 'default', source: 'pipeline_forensics_fix', title: 'test',
      promptContext: {
        candidateId: 'AC-10', title: 'x', files: ['src/a.js', 'src/b.js'],
        fetchedFiles: [{ path: 'src/a.js', content: 'const a=1;\n' }],
        body: 'Split-Depth: 1\nFiles: src/a.js, src/b.js', splitDepth: 1, mustPreSplit: false,
      },
    };
    let n = 0;
    const localCall = async () => {
      n += 1;
      if (n === 1) return { response: 'plan', degenerate: null, attempts: 1 };
      return { response: JSON.stringify({ mode: 'split', candidates: [
        { title: 'a', problem: 'p', solution: 's', benefits: 'b' }, { title: 'b', problem: 'p', solution: 's', benefits: 'b' },
      ] }), degenerate: null, attempts: 1 };
    };
    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });
    assert.equal(task.candidateSplitProposals, undefined);
    assert.match(task.history.find((h) => h.stage === 'blocked').detail, /already a one-level decomposition/);
  });
});

// --- generic premiseCheck hook (arch-import-premise-check.js's call site) --------------

test('draftTask blocks a split when the source\'s premiseCheck returns invalid-premise, and never sets candidateSplitProposals', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { registerTaskSource, updateTaskSource, getRegisteredSource } = require('./task-source-registry.js');
    const p = require('./prompts.js');
    if (!getRegisteredSource('premise_check_test_source')) {
      registerTaskSource('premise_check_test_source', {
        priority: 80, next: () => null, candidateFulfillment: true,
        candidatesPath: () => require('./config.js').getConfig().archReviewCandidatesPath,
        candidateDocTitle: '# Test Candidates',
        premiseCheck: async () => ({ verdict: 'invalid-premise', reason: 'the named function returns one uniform shape everywhere' }),
      });
      updateTaskSource('premise_check_test_source', { buildPlanPrompt: p.archReviewPlanPrompt, buildImplementPrompt: p.archReviewImplementPrompt });
    }
    const task = {
      id: 'premise-check-split-1', domain: 'default', source: 'premise_check_test_source', title: 'test',
      promptContext: {
        candidateId: 'AC-8', title: 'x', files: ['src/review-task.js'],
        fetchedFiles: [{ path: 'src/review-task.js', content: 'function f(){ return {a:1}; }\n' }],
        body: 'Files: src/review-task.js',
      },
    };
    let n = 0;
    const localCall = async () => {
      n += 1;
      if (n === 1) return { response: 'plan text', degenerate: null, attempts: 1 };
      return { response: JSON.stringify({ mode: 'split', candidates: [
        { title: 'child a', problem: 'p1', solution: 's1', benefits: 'b1' },
        { title: 'child b', problem: 'p2', solution: 's2', benefits: 'b2' },
      ] }), degenerate: null, attempts: 1 };
    };
    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });
    assert.equal(task.candidateSplitProposals, undefined, 'no children created');
    assert.match(task.history.find((h) => h.stage === 'blocked').detail, /Invalid premise: the named function returns one uniform shape/);
  });
});

test('draftTask honors a split unchanged when the source has no premiseCheck registered (regression guard)', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'arch-review-split-nopremise-1', domain: 'default', source: 'arch_review', title: 'test',
      promptContext: {
        candidateId: 'AC-6', title: 'x', files: ['src/apply-task.js'],
        fetchedFiles: [{ path: 'src/apply-task.js', content: 'function applyTask() {}\n' }],
        body: 'Files: src/apply-task.js',
      },
    };
    let n = 0;
    const localCall = async () => {
      n += 1;
      if (n === 1) return { response: 'plan text', degenerate: null, attempts: 1 };
      return { response: JSON.stringify({ mode: 'split', candidates: [
        { title: 'a', problem: 'p1', solution: 's1', benefits: 'b1' },
        { title: 'b', problem: 'p2', solution: 's2', benefits: 'b2' },
      ] }), degenerate: null, attempts: 1 };
    };
    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });
    assert.equal(task.candidateSplitProposals.length, 2);
    assert.equal(task.status, 'needs-review');
  });
});

test('draftTask honors a split when the source\'s premiseCheck returns ok', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { registerTaskSource, updateTaskSource, getRegisteredSource } = require('./task-source-registry.js');
    const p = require('./prompts.js');
    if (!getRegisteredSource('premise_check_ok_source')) {
      registerTaskSource('premise_check_ok_source', {
        priority: 80, next: () => null, candidateFulfillment: true,
        candidatesPath: () => require('./config.js').getConfig().archReviewCandidatesPath,
        candidateDocTitle: '# Test Candidates',
        premiseCheck: async () => ({ verdict: 'ok' }),
      });
      updateTaskSource('premise_check_ok_source', { buildPlanPrompt: p.archReviewPlanPrompt, buildImplementPrompt: p.archReviewImplementPrompt });
    }
    const task = {
      id: 'premise-check-ok-split-1', domain: 'default', source: 'premise_check_ok_source', title: 'test',
      promptContext: {
        candidateId: 'AC-7', title: 'x', files: ['src/apply-task.js'],
        fetchedFiles: [{ path: 'src/apply-task.js', content: 'function applyTask() {}\n' }],
        body: 'Files: src/apply-task.js',
      },
    };
    let n = 0;
    const localCall = async () => {
      n += 1;
      if (n === 1) return { response: 'plan text', degenerate: null, attempts: 1 };
      return { response: JSON.stringify({ mode: 'split', candidates: [
        { title: 'a', problem: 'p1', solution: 's1', benefits: 'b1' },
        { title: 'b', problem: 'p2', solution: 's2', benefits: 'b2' },
      ] }), degenerate: null, attempts: 1 };
    };
    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });
    assert.equal(task.candidateSplitProposals.length, 2);
    assert.equal(task.status, 'needs-review');
  });
});

test('draftTask never calls premiseCheck when the split is already blocked by the recursion cap (cheapest check first)', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { registerTaskSource, updateTaskSource, getRegisteredSource } = require('./task-source-registry.js');
    const p = require('./prompts.js');
    let premiseCheckCalls = 0;
    if (!getRegisteredSource('premise_check_depthcap_source')) {
      registerTaskSource('premise_check_depthcap_source', {
        priority: 80, next: () => null, candidateFulfillment: true,
        candidatesPath: () => require('./config.js').getConfig().archReviewCandidatesPath,
        candidateDocTitle: '# Test Candidates',
        premiseCheck: async () => { premiseCheckCalls += 1; return { verdict: 'invalid-premise', reason: 'should never run' }; },
      });
      updateTaskSource('premise_check_depthcap_source', { buildPlanPrompt: p.archReviewPlanPrompt, buildImplementPrompt: p.archReviewImplementPrompt });
    }
    const task = {
      id: 'premise-check-depthcap-1', domain: 'default', source: 'premise_check_depthcap_source', title: 'test',
      promptContext: {
        candidateId: 'AC-8', title: 'x', files: ['src/a.js'],
        fetchedFiles: [{ path: 'src/a.js', content: 'const a=1;\n' }],
        body: 'Split-Depth: 1\nFiles: src/a.js', splitDepth: 1,
      },
    };
    let n = 0;
    const localCall = async () => {
      n += 1;
      if (n === 1) return { response: 'plan', degenerate: null, attempts: 1 };
      return { response: JSON.stringify({ mode: 'split', candidates: [
        { title: 'a', problem: 'p', solution: 's', benefits: 'b' }, { title: 'b', problem: 'p', solution: 's', benefits: 'b' },
      ] }), degenerate: null, attempts: 1 };
    };
    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });
    assert.equal(premiseCheckCalls, 0, 'the recursion cap already blocks -- premiseCheck must not run');
    assert.match(task.history.find((h) => h.stage === 'blocked').detail, /already a one-level decomposition/);
  });
});

test('draftTask honors a split when the source\'s premiseCheck throws (advisory -- never blocks a real split on its own failure)', async () => {
  await withFixtureRepo(async (draftTask) => {
    const { registerTaskSource, updateTaskSource, getRegisteredSource } = require('./task-source-registry.js');
    const p = require('./prompts.js');
    if (!getRegisteredSource('premise_check_throws_source')) {
      registerTaskSource('premise_check_throws_source', {
        priority: 80, next: () => null, candidateFulfillment: true,
        candidatesPath: () => require('./config.js').getConfig().archReviewCandidatesPath,
        candidateDocTitle: '# Test Candidates',
        premiseCheck: async () => { throw new Error('model call timed out'); },
      });
      updateTaskSource('premise_check_throws_source', { buildPlanPrompt: p.archReviewPlanPrompt, buildImplementPrompt: p.archReviewImplementPrompt });
    }
    const task = {
      id: 'premise-check-throws-1', domain: 'default', source: 'premise_check_throws_source', title: 'test',
      promptContext: {
        candidateId: 'AC-9', title: 'x', files: ['src/apply-task.js'],
        fetchedFiles: [{ path: 'src/apply-task.js', content: 'function applyTask() {}\n' }],
        body: 'Files: src/apply-task.js',
      },
    };
    let n = 0;
    const localCall = async () => {
      n += 1;
      if (n === 1) return { response: 'plan text', degenerate: null, attempts: 1 };
      return { response: JSON.stringify({ mode: 'split', candidates: [
        { title: 'a', problem: 'p1', solution: 's1', benefits: 'b1' },
        { title: 'b', problem: 'p2', solution: 's2', benefits: 'b2' },
      ] }), degenerate: null, attempts: 1 };
    };
    await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn() });
    assert.equal(task.candidateSplitProposals.length, 2);
    assert.equal(task.status, 'needs-review');
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
test('draftTask grants the plan call real WebSearch/WebFetch tool access for a research-domain task (opted into Claude)', async () => {
  await withFixtureRepo(async (draftTask) => {
    process.env.AGENT_MANAGER_CLAUDE_SOURCES = 'research_task';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
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

    try {
      await draftTask(task, { localCall, withLockFn: async (dir, fn) => fn(), draftResearchImplementFn, isClaudePausedFn: () => false });
      assert.equal(capturedOpts.allowedTools, 'WebSearch,WebFetch');
      assert.equal(capturedOpts.maxTurns, 8);
    } finally {
      delete process.env.AGENT_MANAGER_CLAUDE_SOURCES;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
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

// ---------------------------------------------------------------------------
// Draft attempt records (src/draft-attempt-record.js): every draftTask() run
// appends one entry to task.draftAttempts capturing that run's plan + each
// implement tier's outcome/response, so a task that failed N times is no longer
// a black box (the bra-1788142124203 incident -- 19 attempts, only the last
// plan survived). See src/draft-attempt-record.test.js for the unit-level cap /
// collapse / tool-summary coverage; these are the local-draft.js integration.
// ---------------------------------------------------------------------------

test('draft attempt record: a blocked adhoc run captures the plan text + every declining tier', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'da-adhoc-blocked', domain: 'adhoc', source: 'manual', title: 't', promptContext: { rawText: 'do the thing' } };

    const draftAdhocViaHarnessSearchFn = async () => ({ applied: false, succeeded: true, reason: 'harness-search found no real matches in this repo' });
    const draftAdhocViaLocalAgenticFn = async () => ({
      applied: false, succeeded: true, reason: 'local agentic investigation did not end with a RESOLUTION: line',
      response: 'I looked at three files but could not decide', turnsUsed: 6,
      toolCallLog: [{ tool: 'read_file', args: { path: 'x.js' }, result: { content: 'abc' } }],
    });
    const draftAdhocViaLocalAgenticWriteFn = async () => ({
      succeeded: true, blocked: true, blockedReason: 'Agentic implement pass did not end with a RESOLUTION: line -- cannot determine outcome',
      response: 'ran out of turns', turnsUsed: 20, resolution: null,
      capturedDiff: 'diff --git a/x.js b/x.js\n+partial edit',
      toolCallLog: [{ tool: 'edit_file', args: { path: 'x.js', find: 'a', replace: 'b' }, result: { edited: true } }],
    });

    const result = await draftTask(task, {
      localCall: fakeLocalCall('QUERY: something\n\nThe plan is to investigate the widget subsystem carefully.'),
      withLockFn: async (d, fn) => fn(),
      draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocViaLocalAgenticWriteFn,
    });

    assert.equal(result.blocked, true);
    assert.equal(task.draftAttempts.length, 1);
    const a = task.draftAttempts[0];
    assert.equal(a.attemptNo, 1);
    assert.equal(a.outcome, 'blocked');
    assert.match(a.plan.text, /investigate the widget subsystem/);
    assert.equal(a.tiers.length, 3);
    assert.deepEqual(a.tiers.map((t) => t.tier), ['harness-search', 'local-agentic', 'local-agentic-write']);
    assert.match(a.tiers[0].reason, /no real matches/);
    assert.equal(a.tiers[1].response, 'I looked at three files but could not decide');
    assert.equal(a.tiers[1].turnsUsed, 6);
    assert.equal(a.tiers[1].toolCalls.total, 1);
    assert.equal(a.tiers[2].turnsUsed, 20);
    assert.match(a.tiers[2].rawDiff, /partial edit/);
    // a 'draft-attempt' history event is emitted so the persist hook flushes it
    assert.ok((task.history || []).some((e) => e.stage === 'draft-attempt'));
  });
});

test('draft attempt record: requeued attempts accumulate -- every plan survives char-for-char', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'da-accumulate', domain: 'adhoc', source: 'manual', title: 't', promptContext: { rawText: 'do it' } };
    const plans = [
      'First plan: short.',
      'Second plan: this one is considerably more detailed and goes on about the subsystem at length.',
      'Third plan: back to short.',
    ];
    for (let i = 0; i < plans.length; i++) {
      task.localRejectCount = i;
      await draftTask(task, {
        localCall: fakeLocalCall(plans[i]),
        withLockFn: async (d, fn) => fn(),
        ...declineLocalTiers(),
      });
    }
    assert.equal(task.draftAttempts.length, 3);
    assert.deepEqual(task.draftAttempts.map((a) => a.attemptNo), [1, 2, 3]);
    assert.deepEqual(task.draftAttempts.map((a) => a.plan.text), plans);
    assert.deepEqual(task.draftAttempts.map((a) => a.localRejectCount), [0, 1, 2]);
  });
});

test('draft attempt record: a plain successful non-adhoc draft records plan + implement + critique', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'da-standard-ok', domain: 'default', source: 'product_spec', title: 'seed',
      promptContext: { requestText: 'seed the spec', currentSpec: '', specExists: false, specRelPath: 'Docs/PRODUCT_SPEC.md', specMode: 'greenfield' },
    };
    const result = await draftTask(task, {
      localCall: async () => ({ response: '{"mode":"create","file":"Docs/PRODUCT_SPEC.md","content":"# Spec"}', degenerate: null, attempts: 1 }),
      withLockFn: async (d, fn) => fn(),
    });
    assert.equal(result.succeeded, true);
    assert.equal(task.draftAttempts.length, 1);
    const a = task.draftAttempts[0];
    assert.equal(a.outcome, 'succeeded');
    assert.ok(a.plan.text.length > 0);
    assert.ok(a.implement.text.length > 0);
    assert.ok(a.critique);
  });
});

test('draft attempt record: a degenerate plan pass records the reason instead of stale text, and still blocks', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = {
      id: 'da-degen-plan', domain: 'default', source: 'product_spec', title: 'seed',
      promptContext: { requestText: 'seed', currentSpec: '', specExists: false, specRelPath: 'Docs/PRODUCT_SPEC.md', specMode: 'greenfield' },
    };
    const result = await draftTask(task, {
      localCall: async () => ({ response: '', degenerate: 'empty', attempts: 3 }),
      withLockFn: async (d, fn) => fn(),
    });
    assert.equal(result.blocked, true);
    const a = task.draftAttempts[0];
    assert.equal(a.outcome, 'blocked');
    assert.equal(a.plan.degenerate, 'empty');
    assert.equal(a.plan.text, undefined);
    assert.equal(a.plan.attempts, 3);
  });
});

// --- Fix (2026-08-31, bra-1788142124203): plan-pass substance gate + prior-plan reuse ---

test('runPlanPass (adhoc): a thin first plan is re-rolled once, and a substantive re-roll is kept', async () => {
  await withFixtureRepo(async (draftTask) => {
    const task = { id: 'adhoc-reroll', domain: 'adhoc', source: 'manual', title: 't', promptContext: { rawText: 'do the thing' } };
    let n = 0;
    const localCall = async () => {
      n += 1;
      return { response: n === 1 ? '1. lone stub' : PLAN_STUB, degenerate: null, attempts: 1 };
    };
    await draftTask(task, { localCall, withLockFn: async (d, fn) => fn(), ...declineLocalTiers() });
    // call 1 = thin first plan, call 2 = the one re-roll, call 3 = the preliminary
    // decompose check (returns PLAN_STUB, not JSON, so it parses to null and the task
    // falls through to the -- stubbed/declining -- tier ladder).
    assert.equal(n, 3, 'thin first plan + exactly one re-roll + the preliminary decompose check');
    assert.equal(task.planResponse, PLAN_STUB);
    assert.equal(task.lastGoodPlan, PLAN_STUB);
    const planDone = (task.history || []).find((e) => e.stage === 'plan-done');
    assert.match(planDone.detail, /re-rolled once/);
  });
});

test('runPlanPass (adhoc): two thin rolls fall back to a prior attempt\'s plan verbatim', async () => {
  await withFixtureRepo(async (draftTask) => {
    const priorPlan = [
      '1. Open python/dashboard/templates/index.html and locate renderTaskDetailModal / the actionHeader row.',
      '2. Add a "Send to chat" button there and wire it to a new POST endpoint in python/dashboard/app.py.',
      '3. Rename the Brain Dump "Discuss" button to "Send to Chat" and remove the provider toggle.',
      '4. Run a targeted check on the changed files and hand back the diff.',
    ].join('\n');
    const task = {
      id: 'adhoc-seed', domain: 'adhoc', source: 'manual', title: 't',
      promptContext: { rawText: 'do the thing' },
      draftAttempts: [{ attemptNo: 1, plan: { chars: priorPlan.length, text: priorPlan }, outcome: 'needs-clarification' }],
    };
    await draftTask(task, { localCall: fakeLocalCall('1. stub'), withLockFn: async (d, fn) => fn(), ...declineLocalTiers() });
    assert.equal(task.planResponse, priorPlan);
    assert.equal(task.lastGoodPlan, priorPlan);
    const planDone = (task.history || []).find((e) => e.stage === 'plan-done');
    assert.match(planDone.detail, /reused a prior attempt's plan/);
    assert.equal(task.draftAttempts[1].plan.seededFromPrior, true);
    assert.equal(task._seedPlan, undefined, 'the transient seed is not left on the task');
  });
});

test('bestPriorPlan: newest usable plan wins; degenerate and thin records are skipped; lastGoodPlan is the fallback', () => {
  const { bestPriorPlan } = require('./local-draft.js');
  const good = Array.from({ length: 6 }, (_, i) => `${i + 1}. a reasonably detailed step that describes some real work to carry out`).join('\n');
  assert.equal(bestPriorPlan({ draftAttempts: [
    { plan: { text: good, chars: good.length } },
    { plan: { degenerate: 'empty', chars: 0 } },
    { plan: { text: '1. too short', chars: 12 } },
  ] }), good, 'skips the newer degenerate + thin records');
  assert.equal(bestPriorPlan({ draftAttempts: [{ plan: { text: '1. too short' } }], lastGoodPlan: good }), good);
  assert.equal(bestPriorPlan({ draftAttempts: [] }), null);
  assert.equal(bestPriorPlan({ draftAttempts: [{ collapsed: true, planChars: 999 }] }), null, 'a collapsed record carries no plan.text');
});

test('planIsThin: fewer than 2 numbered steps or under the char floor is thin; a real multi-step plan is not', () => {
  const { planIsThin } = require('./local-draft.js');
  assert.equal(planIsThin('1. **Inspect the current code before changing anything**'), true);
  assert.equal(planIsThin('1. a\n2. b'), true, 'two steps but far too short');
  assert.equal(planIsThin(''), true);
  assert.equal(planIsThin(undefined), true);
  assert.equal(planIsThin(PLAN_STUB), false);
});

test('planIsThin: a real plan whose steps are markdown headings ("## 1.") is not thin', () => {
  const { planIsThin } = require('./local-draft.js');
  const headingPlan = [
    '## 1. Locate the detail modal',
    'The modal is rendered in src/ui.js; find the component that owns tailModal and actionHeader.',
    '',
    '## 2. Adjust the header layout',
    'Update the flex container so the action buttons align right without wrapping on narrow widths.',
    '',
    '### 3. Verify',
    'Run the dashboard and confirm the header renders correctly at 320px and 1280px.',
  ].join('\n');
  assert.ok(headingPlan.length >= 200);
  assert.equal(planIsThin(headingPlan), false);
});

// 2026-09-02: promptContext.fetchedFiles is frozen at candidate-creation; a sibling AC on
// the same file merging in the meantime left blocked observability_fix tasks re-drafting a
// stale view (duplicate `import logging`). refreshCandidateFetchedFiles re-reads from disk.
test('refreshCandidateFetchedFiles re-reads each fetched path from the current repoRoot, re-windowed', () => {
  const { refreshCandidateFetchedFiles } = require('./local-draft.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-refresh-'));
  fs.writeFileSync(path.join(dir, 'a.py'), 'import logging\nlog = logging.getLogger(__name__)\n\ndef f():\n    return 1\n');
  const prev = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  delete require.cache[require.resolve('./config.js')];
  try {
    const task = {
      source: 'observability_fix',
      promptContext: {
        body: '### AC-1\nSnippet:\n```\ndef f():\n    return 1\n```\n',
        fetchedFiles: [
          { path: 'a.py', content: 'def f():\n    return 1\n' }, // STALE: no import
          { path: 'gone.py', content: 'frozen fallback' },        // deleted -> keep frozen
        ],
      },
    };
    refreshCandidateFetchedFiles(task);
    const a = task.promptContext.fetchedFiles.find((f) => f.path === 'a.py');
    assert.match(a.content, /import logging/, 'refreshed from disk -- now shows the real import');
    const gone = task.promptContext.fetchedFiles.find((f) => f.path === 'gone.py');
    assert.equal(gone.content, 'frozen fallback', 'a missing path keeps its frozen snapshot');
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT;
    else process.env.AGENT_MANAGER_REPO_ROOT = prev;
    delete require.cache[require.resolve('./config.js')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshCandidateFetchedFiles is a no-op when there are no fetchedFiles / no path-jail escape', () => {
  const { refreshCandidateFetchedFiles } = require('./local-draft.js');
  const t1 = { source: 'observability_fix', promptContext: {} };
  refreshCandidateFetchedFiles(t1); // must not throw
  const t2 = { source: 'observability_fix', promptContext: { fetchedFiles: [{ path: '../../etc/passwd', content: 'x' }] } };
  refreshCandidateFetchedFiles(t2);
  assert.equal(t2.promptContext.fetchedFiles[0].content, 'x', 'a path outside repoRoot is left untouched');
});
