'use strict';

// Tests for adhoc tier-3 (local write-agentic). The worktree + resolveAgenticDraft path
// is covered by agentic-draft-common.test.js; here we fake the whole worktree run
// (runInWorktree) and check the tier's own contract + kill switches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshModule() {
  delete require.cache[require.resolve('./local-agentic-write-draft.js')];
  delete require.cache[require.resolve('./config.js')];
  return require('./local-agentic-write-draft.js');
}

function withRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'law-draft-test-'));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  const prev = { r: process.env.AGENT_MANAGER_REPO_ROOT, p: process.env.AGENT_MANAGER_PIPELINE_DIR, m: process.env.LOCAL_MODEL, k: process.env.AGENT_MANAGER_LOCAL_AGENTIC_WRITE };
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  process.env.LOCAL_MODEL = 'qwen-test';
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_WRITE;
  try { return fn(dir); } finally {
    for (const [e, v] of [['AGENT_MANAGER_REPO_ROOT', prev.r], ['AGENT_MANAGER_PIPELINE_DIR', prev.p], ['LOCAL_MODEL', prev.m], ['AGENT_MANAGER_LOCAL_AGENTIC_WRITE', prev.k]]) {
      if (v === undefined) delete process.env[e]; else process.env[e] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// runInWorktree bypasses git entirely -- it's passed a worktreeDir and returns the model
// result; resolveAgenticDraft then runs against that dir. For contract tests we hand a
// fake runInWorktree that also fakes resolveAgenticDraft's outcome by mutating task.
test('write tier: an implemented result flows through as a needs-review verdict', async () => {
  await withRepo(async () => {
    const { draftAdhocViaLocalAgenticWrite } = freshModule();
    const task = { id: 'w1', source: 'manual', promptContext: { rawText: 'do it' } };
    const res = await draftAdhocViaLocalAgenticWrite(task, {
      runInWorktree: async () => ({ response: 'RESOLUTION: implemented\n\ndid it' }),
    });
    // resolveAgenticDraft ran against a real worktree it created from origin/<main> -- but
    // there's no origin here, so prepare fails cleanly and we get a retryable infra error.
    // (The happy path is covered end-to-end in agentic-draft-common.test.js.)
    assert.equal(res.succeeded, false);
    assert.match(res.reason, /worktree|fetch|origin/i);
  });
});

test('write tier: disabled via AGENT_MANAGER_LOCAL_AGENTIC_WRITE=false -> clean block for human', async () => {
  await withRepo(async () => {
    process.env.AGENT_MANAGER_LOCAL_AGENTIC_WRITE = 'false';
    const { draftAdhocViaLocalAgenticWrite } = freshModule();
    const res = await draftAdhocViaLocalAgenticWrite({ id: 'w2', source: 'manual', promptContext: { rawText: 'x' } }, {
      runInWorktree: async () => { throw new Error('must not run when disabled'); },
    });
    assert.equal(res.succeeded, true);
    assert.equal(res.blocked, true);
    assert.match(res.blockedReason, /disabled \(AGENT_MANAGER_LOCAL_AGENTIC_WRITE=false\)/);
  });
});

test('write tier: disabled via the shared queue/.chat-write-tools-disabled kill switch -> clean block', async () => {
  await withRepo(async (dir) => {
    fs.writeFileSync(path.join(dir, 'queue', '.chat-write-tools-disabled'), '');
    const { draftAdhocViaLocalAgenticWrite } = freshModule();
    const res = await draftAdhocViaLocalAgenticWrite({ id: 'w3', source: 'manual', promptContext: { rawText: 'x' } }, {
      runInWorktree: async () => { throw new Error('must not run when kill switch set'); },
    });
    assert.equal(res.succeeded, true);
    assert.equal(res.blocked, true);
    assert.match(res.blockedReason, /chat-write-tools-disabled/);
  });
});

// --- AC-13a: external-dependency feasibility gate (2026-09-06) -----------------------
// Real field names verified against this codebase's actual task shape -- NOT task.ask/
// task.plan (those fields don't exist anywhere here). See detectExternalDependency's
// own header.
test('detectExternalDependency matches each real marker category via title/rawText/planResponse', () => {
  const { detectExternalDependency } = freshModule();
  assert.equal(detectExternalDependency({ title: 'Create a new repo for this' }), 'creating a new repo');
  assert.equal(detectExternalDependency({ promptContext: { rawText: 'deploy to production' } }), 'hosting/deploying/publishing');
  assert.equal(detectExternalDependency({ planResponse: 'run git push origin main' }), 'a git remote operation');
  assert.equal(detectExternalDependency({ title: 'add the API key to config' }), 'credentials/API keys/tokens/secrets');
  assert.equal(detectExternalDependency({ lastGoodPlan: 'call a third-party service for weather data' }), 'a network/third-party service call');
});

test('detectExternalDependency returns null for an ordinary local code task', () => {
  const { detectExternalDependency } = freshModule();
  assert.equal(detectExternalDependency({ title: 'Fix the off-by-one in countPending', promptContext: { rawText: 'narrow the catch block' } }), null);
  assert.equal(detectExternalDependency({}), null);
});

// 2026-09-08, root-caused live (adhoc-brain-dump-bd-...-reviewer-3-3-real-inconclusive-
// votes-are...): a task about tightening a review-vote config threshold got wrongly
// blocked because its own PLAN said "token counts" -- this codebase's own pervasive
// LLM-metrics vocabulary, unrelated to auth. The bare "tokens?" alternative is gone;
// only a qualified compound phrase (api/auth/access/bearer/session/oauth token(s)) still
// matches, the same discipline "api[\s_-]?keys?" already used (never a bare "key").
test('detectExternalDependency does NOT false-positive on "token counts" / LLM-metrics token vocabulary', () => {
  const { detectExternalDependency } = freshModule();
  assert.equal(detectExternalDependency({ planResponse: 'they read/report model_calls and token counts but do not make the pass/reject decision' }), null);
  assert.equal(detectExternalDependency({ title: 'Reduce the promptTok/evalTok climb in 3-call tasks' }), null);
  assert.equal(detectExternalDependency({ promptContext: { rawText: 'tighten the tokens used per implement pass' } }), null);
});

test('detectExternalDependency still matches a real auth/API token reference', () => {
  const { detectExternalDependency } = freshModule();
  assert.equal(detectExternalDependency({ title: 'Store the API token in a secrets manager' }), 'credentials/API keys/tokens/secrets');
  assert.equal(detectExternalDependency({ promptContext: { rawText: 'you will need an OAuth token to call this' } }), 'credentials/API keys/tokens/secrets');
  assert.equal(detectExternalDependency({ planResponse: 'generate a personal access token from GitHub settings' }), 'credentials/API keys/tokens/secrets');
  assert.equal(detectExternalDependency({ title: 'Set the bearer token on every request' }), 'credentials/API keys/tokens/secrets');
});

test('write tier: a task requiring an external resource is blocked with needsClarification BEFORE any model call', async () => {
  await withRepo(async () => {
    const { draftAdhocViaLocalAgenticWrite } = freshModule();
    const task = { id: 'w-ext', source: 'manual', title: 'Create a new repo for the plugin', promptContext: { rawText: 'we need a fresh repo' } };
    const res = await draftAdhocViaLocalAgenticWrite(task, {
      runInWorktree: async () => { throw new Error('must not spend a single turn on an externally-impossible task'); },
    });
    assert.equal(res.succeeded, true);
    assert.equal(res.blocked, true);
    assert.match(res.blockedReason, /external-state operation \(creating a new repo\)/);
    assert.equal(res.needsClarification.reason, 'external-dependency');
    assert.match(res.needsClarification.openQuestions[0], /creating a new repo/);
  });
});

test('write tier: a task whose PLAN (not the original ask) reveals an external dependency is still caught', async () => {
  await withRepo(async () => {
    const { draftAdhocViaLocalAgenticWrite } = freshModule();
    const task = {
      id: 'w-ext-plan', source: 'manual', title: 'Wire up the notification feature',
      promptContext: { rawText: 'add notifications when a task completes' },
      planResponse: 'Plan: call an external API (Twilio) to send the SMS notification.',
    };
    const res = await draftAdhocViaLocalAgenticWrite(task, {
      runInWorktree: async () => { throw new Error('must not run once the plan reveals an external dependency'); },
    });
    assert.equal(res.blocked, true);
    assert.equal(res.needsClarification.reason, 'external-dependency');
  });
});

test('write tier: buildWriteAgenticPrompt asks for real edits + targeted checks + the 4 RESOLUTION verbs', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const p = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'the ask' } });
    assert.match(p, /edit_file \/ write_file|edit\/write/i);
    assert.match(p, /run_bash/);
    assert.match(p, /py_compile/);
    assert.match(p, /RESOLUTION: implemented/);
    assert.match(p, /RESOLUTION: decompose/);
    assert.match(p, /RESOLUTION: needs-human-decision/);
    assert.match(p, /the ask/);
    // Fix 5: steer exploration onto the structured read-only tools, not run_bash.
    assert.match(p, /grep_codebase \/ read_file \/ list_directory/);
  });
});

test('write tier: buildWriteAgenticPrompt lists non-empty pre-filter flags verbatim', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const p = buildWriteAgenticPrompt({
      title: 'T', promptContext: { rawText: 'the ask' },
      preFilterFlags: [{ type: 'missing-file', detail: 'src/foo.js' }],
    });
    assert.match(p, /Here are the pre-filter flags/);
    assert.match(p, /missing-file/);
    assert.match(p, /src\/foo\.js/);
  });
});

test('write tier: buildWriteAgenticPrompt still shows the pre-filter flags header for an empty list, with the (none ...) sentinel', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const p = buildWriteAgenticPrompt({
      title: 'T', promptContext: { rawText: 'the ask' },
      preFilterFlags: [],
    });
    assert.match(p, /Here are the pre-filter flags/);
    assert.match(p, /\(none/);
  });
});

test('write tier: blindPlanBlock softens its "could NOT read any files" language when task.planWasGrounded', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const base = { title: 'T', promptContext: { rawText: 'the ask' }, planResponse: '1. do a thing\n2. do another' };
    assert.match(buildWriteAgenticPrompt(base), /could NOT read any files/);
    assert.match(buildWriteAgenticPrompt({ ...base, planWasGrounded: true }), /LIMITED file access/);
    assert.doesNotMatch(buildWriteAgenticPrompt({ ...base, planWasGrounded: true }), /could NOT read any files/);
  });
});

// 2026-09-09, root-caused live (see hub-status-grounding.js's own header): a stacked
// wiring child's own prompt must include a real, verified per-sibling status check --
// this is the actual pass that produced the wrong "files don't exist" conclusion.
test('write tier: buildWriteAgenticPrompt includes real hub-status grounding for a decomposed hub child', async () => {
  await withRepo(async (dir) => {
    fs.mkdirSync(path.join(dir, 'queue', 'coordinating'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue', 'coordinating', 'file-decompose-hub-fixture.json'), JSON.stringify({
      id: 'file-decompose-hub-fixture',
      subTasks: [
        { id: 'move-1', title: 'Decompose index.html → static/js/core-ui.js', status: 'merged' },
        { id: 'wiring-1', title: 'wire up 1 new file(s)', status: 'needs-clarification' },
      ],
    }));
    const { buildWriteAgenticPrompt } = freshModule();
    const p = buildWriteAgenticPrompt({
      id: 'wiring-1', title: 'T',
      promptContext: { rawText: 'wire it up', decomposedFrom: 'file-decompose-hub-fixture' },
    });
    assert.match(p, /HUB STATUS/);
    assert.match(p, /hub status: merged/);
    assert.match(p, /do NOT immediately trust either one/);
  });
});

test('write tier: buildWriteAgenticPrompt adds no hub-status content for an ordinary (non-decomposed) task', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const p = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'the ask' } });
    assert.doesNotMatch(p, /HUB STATUS/);
  });
});

test('write tier: a confirmed-atomic leaf (decomposedFrom) is told NOT to decompose and loses the "split into 2-6" clause', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const leaf = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'add one route', decomposedFrom: 'parent-123' } });
    assert.match(leaf, /CONFIRMED-ATOMIC LEAF/);
    assert.match(leaf, /decomposed from parent task parent-123/);
    assert.match(leaf, /do NOT answer RESOLUTION: decompose/i);
    assert.doesNotMatch(leaf, /split it into 2-6 smaller/);
    // the RESOLUTION verb list itself is still intact (the parser needs the token)
    assert.match(leaf, /RESOLUTION: decompose/);

    const normal = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'do a big thing' } });
    assert.doesNotMatch(normal, /CONFIRMED-ATOMIC LEAF/);
    assert.match(normal, /split it into 2-6 smaller/);
  });
});

// 2026-09-02: a leaf is only decompose-LOCKED while it is fresh. Once it has demonstrably
// blown a whole turn budget (turnBudgetExhaustedBefore) or already been auto-split once
// (autoDecomposeCount), it may choose RESOLUTION: decompose again -- the MAX_AUTO_DECOMPOSE
// cap + review still bound it.
test('write tier: a leaf that already exhausted a budget is NOT decompose-locked', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const base = { title: 'T', promptContext: { rawText: 'add one route', decomposedFrom: 'parent-1' } };

    const locked = buildWriteAgenticPrompt(base);
    assert.match(locked, /CONFIRMED-ATOMIC LEAF/);

    const unlocked = buildWriteAgenticPrompt({ ...base, turnBudgetExhaustedBefore: true });
    assert.doesNotMatch(unlocked, /CONFIRMED-ATOMIC LEAF/);
    assert.match(unlocked, /split it into 2-6 smaller/);

    const unlocked2 = buildWriteAgenticPrompt({ ...base, autoDecomposeCount: 1 });
    assert.doesNotMatch(unlocked2, /CONFIRMED-ATOMIC LEAF/);

    // a leaf that already tried to decompose on a prior pass is likewise no longer locked
    const unlocked3 = buildWriteAgenticPrompt({ ...base, decomposeBlockCount: 1 });
    assert.doesNotMatch(unlocked3, /CONFIRMED-ATOMIC LEAF/);
    assert.match(unlocked3, /split it into 2-6 smaller/);
  });
});

test('write tier: the too-large + decompose guidance spells out the one-file / prefer-a-new-file rule', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const p = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'do a big thing' } });
    // appears both in the "too large -> split" clause and in the RESOLUTION: decompose shape block
    const hits = p.match(/strongly prefer a NEW self-contained file\/module/g) || [];
    assert.ok(hits.length >= 2, `expected the prefer-a-new-file rule in both places, saw ${hits.length}`);
  });
});

test('write tier: rescopedFromDecompose alone also triggers leaf mode', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const leaf = buildWriteAgenticPrompt({ title: 'T', rescopedFromDecompose: true, promptContext: { rawText: 'the sharpened scope' } });
    assert.match(leaf, /CONFIRMED-ATOMIC LEAF/);
    assert.doesNotMatch(leaf, /decomposed from parent task/); // no parent id in this case
  });
});

test('write tier: buildWriteAgenticPrompt feeds back a prior local-agentic-write attempt analysis', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const bare = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'x' } });
    assert.doesNotMatch(bare, /YOUR OWN PRIOR ATTEMPT/);

    const withPrior = buildWriteAgenticPrompt({
      title: 'T', promptContext: { rawText: 'x' },
      draftAttempts: [
        { tiers: [{ tier: 'local-agentic', response: 'read-only pass note' }] },
        { tiers: [{ tier: 'harness-search' }, { tier: 'local-agentic-write', response: '_call_chat is at app.py:3654; add the route after the message route' }] },
      ],
    });
    assert.match(withPrior, /YOUR OWN PRIOR ATTEMPT at this task ended without making an edit/);
    assert.match(withPrior, /_call_chat is at app\.py:3654/);
    // the read-only tier's response is NOT what this block surfaces
    assert.doesNotMatch(withPrior, /read-only pass note/);
  });
});

test('write tier: isLeafTask is true for decomposedFrom or rescopedFromDecompose, false otherwise', async () => {
  await withRepo(async () => {
    const { isLeafTask } = freshModule();
    assert.equal(isLeafTask({ promptContext: { decomposedFrom: 'p-1' } }), true);
    assert.equal(isLeafTask({ rescopedFromDecompose: true }), true);
    assert.equal(isLeafTask({ promptContext: { rawText: 'x' } }), false);
    assert.equal(isLeafTask({}), false);
  });
});

test('write tier: buildWriteAgenticPrompt folds in the plan (with a blind-plan disclaimer) and the prior investigation, in order', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();

    // no plan, no investigation -> neither block appears
    const bare = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'x' } });
    assert.doesNotMatch(bare, /could NOT read any files/);
    assert.doesNotMatch(bare, /PRIOR INVESTIGATION/);

    // plan only -> disclaimer + plan text
    const withPlan = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'x' }, planResponse: '1. Add the /api/chat/inject route near line 3622' });
    assert.match(withPlan, /drafted earlier by a separate pass that could NOT read any files/);
    assert.match(withPlan, /every path, line number, function name and "already exists.*is UNVERIFIED/);
    assert.match(withPlan, /1\. Add the \/api\/chat\/inject route near line 3622/);

    // investigation only
    const withInv = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'x' }, _priorInvestigation: 'Files already read: python/dashboard/app.py' });
    assert.match(withInv, /PRIOR INVESTIGATION -- a read-only pass already explored this/);
    assert.match(withInv, /Files already read: python\/dashboard\/app\.py/);

    // all three present -> prior-rejection, then plan, then prior-investigation, then the static instructions
    const full = buildWriteAgenticPrompt({
      title: 'T', promptContext: { rawText: 'x' },
      priorRejectionFeedback: ['REJECTION_MARKER'],
      planResponse: 'PLAN_MARKER',
      _priorInvestigation: 'INVEST_MARKER',
    });
    const iRej = full.indexOf('REJECTION_MARKER');
    const iPlan = full.indexOf('PLAN_MARKER');
    const iInv = full.indexOf('INVEST_MARKER');
    const iStatic = full.indexOf('First, investigate whether this specific request is ALREADY satisfied');
    assert.ok(iRej > -1 && iRej < iPlan && iPlan < iInv && iInv < iStatic,
      `expected rejection < plan < investigation < static, got ${iRej}/${iPlan}/${iInv}/${iStatic}`);
  });
});

// The repeated-decompose backstop: it fires on ANY give-up verdict (blocked OR
// needsClarification), not just blocked. Confirmed live 2026-09-02: after two decompose
// blocks the model punts pass 3 to needs-human-decision, which is blocked:false, and the
// old `verdict.blocked && ...` gate skipped the deterministic split -> needs-clarification/
// with a placeholder non-question.
test('write tier: backstop runs the deterministic split when a decomposeBlockCount>=2 task punts to needsClarification', async () => {
  await withRepo(async () => {
    delete require.cache[require.resolve('./agentic-draft-common.js')];
    delete require.cache[require.resolve('./decompose-pass.js')];
    const adc = require('./agentic-draft-common.js');
    const dp = require('./decompose-pass.js');
    const realRun = adc.runAgenticDraftInWorktree;
    const realDec = dp.runDecomposePass;
    adc.runAgenticDraftInWorktree = async () => ({ succeeded: true, blocked: false, needsClarification: true, response: 'ran out of turns' });
    dp.runDecomposePass = async () => ({ subTasks: [{ title: 'a', rawText: 'aa' }, { title: 'b', rawText: 'bb' }] });
    try {
      const { draftAdhocViaLocalAgenticWrite } = freshModule();
      const task = { id: 'wbk', source: 'manual', decomposeBlockCount: 2, needsClarification: { reason: 'x' }, promptContext: { rawText: 'big multi-part thing' } };
      const res = await draftAdhocViaLocalAgenticWrite(task, { runInWorktree: async () => ({ response: 'x' }) });
      assert.equal(res.resolution, 'decompose');
      assert.equal(task.adhocResolution, 'decompose');
      assert.equal(task.subTaskProposals.length, 2);
      assert.equal(task.needsClarification, undefined, 'the needs-clarification routing is cleared');
      assert.equal(task.autoDecomposeCount, 1);
    } finally {
      adc.runAgenticDraftInWorktree = realRun;
      dp.runDecomposePass = realDec;
    }
  });
});

test('write tier: turn cap default is 35, env override still wins', async () => {
  await withRepo(async () => {
    const prev = process.env.AGENT_MANAGER_LOCAL_AGENTIC_WRITE_MAX_TURNS;
    delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_WRITE_MAX_TURNS;
    assert.equal(freshModule().LOCAL_AGENTIC_WRITE_MAX_TURNS, 35);
    process.env.AGENT_MANAGER_LOCAL_AGENTIC_WRITE_MAX_TURNS = '50';
    assert.equal(freshModule().LOCAL_AGENTIC_WRITE_MAX_TURNS, 50);
    if (prev === undefined) delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_WRITE_MAX_TURNS;
    else process.env.AGENT_MANAGER_LOCAL_AGENTIC_WRITE_MAX_TURNS = prev;
  });
});

