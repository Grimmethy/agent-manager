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

test('write tier: rescopedFromDecompose alone also triggers leaf mode', async () => {
  await withRepo(async () => {
    const { buildWriteAgenticPrompt } = freshModule();
    const leaf = buildWriteAgenticPrompt({ title: 'T', rescopedFromDecompose: true, promptContext: { rawText: 'the sharpened scope' } });
    assert.match(leaf, /CONFIRMED-ATOMIC LEAF/);
    assert.doesNotMatch(leaf, /decomposed from parent task/); // no parent id in this case
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

