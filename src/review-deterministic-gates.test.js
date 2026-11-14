'use strict';

// review-deterministic-gates.js: the deterministic gates of runReview that run after the fact-check (P6.4b). Each gate directly, the runner's order and
// outputs, and end-to-end calls through reviewTask() that pin what the call site hands the runner.

process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR || require('node:os').tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gates = require('./review-deterministic-gates.js');
const reviewTask = require('./review-task.js');
const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');
const decomposeRegistry = require('./decompose-review-registry.js');
const { registerDeterministicRecheck, clearDeterministicRecheckRegistry } = require('./deterministic-recheck-registry.js');

class Fx {
  static task(over = {}) {
    return { id: 'dg-1', domain: 'default', source: 'trouble_log', title: 't', planResponse: 'p', abCallId: 'call-dg', history: [], promptContext: {},
      implementResponse: '```diff\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n```', ...over };
  }

  static ctx(over = {}) {
    const outcomes = [];
    const task = over.task || Fx.task();
    const trimmed = (task.implementResponse || '').trim();
    return { task, factCheck: { flags: [] }, factCheckVerdict: 'pass', repoRootForCheck: os.tmpdir(), factCheckExtraRoots: [], groundingRef: null,
      pipelineDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dg-pipe-')), recordModelOutcome: (o) => outcomes.push(o), outcomes,
      trimmedImplResponse: trimmed, effectivelyEmpty: trimmed === '' || trimmed === '""', isProposalNotClaim: false, ...over };
  }

  static auditLines(pipelineDir) {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) if (line.includes('fact-check-block')) out.push(line);
      }
    };
    walk(pipelineDir);
    return out;
  }

  static blockedBy(result, provider, ctx) {
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.blockedStage, 'review');
    assert.equal(result.factCheckVerdict, ctx.factCheckVerdict);
    assert.equal(ctx.task.reviewProvider, provider);
    assert.equal(ctx.outcomes.length, 1);
    assert.equal(ctx.outcomes[0].callId, 'call-dg');
    assert.equal(ctx.outcomes[0].outcome, 'rejected');
    assert.equal(ctx.task.history.some((h) => h.stage === 'blocked'), true);
  }

  static fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dgates-'));
    const repoRoot = path.join(dir, 'repo');
    const secondBrainDir = path.join(dir, 'sb');
    const pipelineDir = path.join(dir, 'pipeline');
    for (const d of [repoRoot, secondBrainDir, pipelineDir]) fs.mkdirSync(d);
    const domainsPath = path.join(dir, 'task-domains.json');
    fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
    return { dir, repoRoot, secondBrainDir, pipelineDir, domainsPath };
  }
}

test('ungroundedValueGate blocks an ungrounded url or field, logs it under pipelineDir, and ignores a proposal source', () => {
  const flags = [{ type: 'ungrounded-url', detail: 'http://nowhere.example/x' }, { type: 'missing-file', detail: 'ignored' }];
  const ctx = Fx.ctx({ factCheck: { flags }, factCheckVerdict: 'flagged' });
  const r = gates.ungroundedValueGate(ctx);
  Fx.blockedBy(r, 'deterministic-ungrounded-value', ctx);
  assert.match(r.blockedReason, /ungrounded-url: http:\/\/nowhere\.example\/x/);
  assert.doesNotMatch(r.blockedReason, /ignored/);
  assert.equal(Fx.auditLines(ctx.pipelineDir).length, 1);
  assert.equal(gates.ungroundedValueGate(Fx.ctx({ factCheck: { flags }, isProposalNotClaim: true })), null);
  assert.equal(gates.ungroundedValueGate(Fx.ctx({ factCheck: { flags: [{ type: 'missing-file', detail: 'x' }] } })), null);
});

test('ungroundedValueGate forgives a flagged symbol that is only truncated out of the frozen window', () => {
  const task = Fx.task({ promptContext: { fetchedFiles: [{ path: 'frozen.js', context: 'text WINDOW_SYM more' }] } });
  const ctx = Fx.ctx({ task, factCheck: { flags: [{ type: 'ungrounded-field', detail: 'WINDOW_SYM' }] } });
  assert.equal(gates.ungroundedValueGate(ctx), null);
  assert.equal(task.history.some((h) => h.stage === 'relocation-validated'), true);
});

test('revertsPriorFixGate blocks a reverts-a-prior-fix flag and logs it', () => {
  const ctx = Fx.ctx({ factCheck: { flags: [{ type: 'reverts-a-prior-fix', detail: 'undoes AC-12' }] } });
  const r = gates.revertsPriorFixGate(ctx);
  Fx.blockedBy(r, 'deterministic-reverts-a-prior-fix', ctx);
  assert.match(r.blockedReason, /undoes AC-12/);
  assert.equal(Fx.auditLines(ctx.pipelineDir).length, 1);
  assert.equal(gates.revertsPriorFixGate(Fx.ctx({ factCheck: { flags: [{ type: 'reverts-a-prior-fix', detail: 'd' }] }, isProposalNotClaim: true })), null);
});

test('onePassDecomposeGate and scriptExtractGate approve or block on the registered re-derivation, only for their own kinds', () => {
  for (const [kind, gate, approveProvider, rejectProvider] of [
    ['one-pass-decompose', gates.onePassDecomposeGate, 'deterministic-one-pass-decompose-approve', 'deterministic-one-pass-decompose-reject'],
    ['script-extract', gates.scriptExtractGate, 'deterministic-script-extract-approve', 'deterministic-script-extract-reject'],
  ]) {
    let seen = null;
    decomposeRegistry.registerDeterministicReview(kind, { verify: (task, root, ref) => { seen = { root, ref }; return task.verdictStub; } });
    try {
      const mk = (stub) => Fx.ctx({ task: Fx.task({ verdictStub: stub, promptContext: { deterministicApply: kind } }), repoRootForCheck: '/the/root', groundingRef: 'ref-1' });
      const okCtx = mk({ ok: true, moduleCount: 3 });
      const ok = gate(okCtx);
      assert.equal(ok.verdict, 'approved');
      assert.equal(ok.factCheckVerdict, 'pass');
      assert.equal(okCtx.task.reviewProvider, approveProvider);
      assert.equal(okCtx.outcomes[0].outcome, 'approved');
      assert.deepEqual(seen.root, '/the/root');
      if (kind === 'script-extract') assert.equal(seen.ref, 'ref-1');
      const badCtx = mk({ ok: false, reason: 'drifted' });
      const bad = gate(badCtx);
      Fx.blockedBy(bad, rejectProvider, badCtx);
      assert.match(bad.blockedReason, /drifted/);
      assert.equal(gate(Fx.ctx()), null);
    } finally { decomposeRegistry.clearDeterministicReviewRegistry(); }
  }
});

test('emptyOutcomeGate: approve, block and block-no-context for an empty-approval source, null otherwise', () => {
  clearRegistry();
  registerTaskSource('dg_empty', { priority: 5, next: () => null, emptyApproval: true });
  const mk = (over, pc) => { const task = Fx.task({ source: 'dg_empty', implementResponse: '', promptContext: pc, ...over }); return Fx.ctx({ task, trimmedImplResponse: '', effectivelyEmpty: true }); };
  const approveCtx = mk({}, { harnessHits: 3 });
  const approved = gates.emptyOutcomeGate(approveCtx);
  assert.equal(approved.verdict, 'approved');
  assert.equal(approveCtx.task.reviewProvider, 'deterministic-empty-approve');
  assert.equal(approveCtx.outcomes[0].outcome, 'approved');
  const blockCtx = mk({}, { harnessHits: 0 });
  Fx.blockedBy(gates.emptyOutcomeGate(blockCtx), 'deterministic-empty-fail', blockCtx);
  clearRegistry();
  registerTaskSource('dg_docs', { priority: 5, next: () => null, emptyApproval: true, candidateDocFormat: true });
  const noCtx = mk({ source: 'dg_docs', implementResponse: 'whatever' }, { files: [] });
  Fx.blockedBy(gates.emptyOutcomeGate(noCtx), 'deterministic-no-context-fail', noCtx);
  assert.equal(gates.emptyOutcomeGate(Fx.ctx()), null);
  clearRegistry();
});

test('premiseRecheckGate approves a FALSE POSITIVE refusal when the re-scan finds nothing, using the fact-check root and extra roots', () => {
  const f = Fx.fixture();
  fs.writeFileSync(path.join(f.repoRoot, 'cited.js'), 'const fine = 1;\n');
  clearRegistry(); clearDeterministicRecheckRegistry();
  registerDeterministicRecheck('dg_review', { perFileRules: { none: () => [] } });
  registerTaskSource('dg_fix', { priority: 5, next: () => null, premiseRecheckSource: 'dg_review' });
  const mk = (root) => Fx.ctx({ task: Fx.task({ source: 'dg_fix', implementResponse: 'FALSE POSITIVE -- already gone', promptContext: { files: ['cited.js'] } }), repoRootForCheck: root });
  const ctx = mk(f.repoRoot);
  const r = gates.premiseRecheckGate(ctx);
  assert.equal(r.verdict, 'approved');
  assert.equal(ctx.task.reviewProvider, 'deterministic-premise-recheck-approve');
  assert.match(ctx.task.localVerdict, /dg_review/);
  assert.equal(ctx.outcomes[0].outcome, 'approved');
  assert.equal(gates.premiseRecheckGate(mk(path.join(f.dir, 'elsewhere'))), null);
  assert.equal(gates.premiseRecheckGate(Fx.ctx()), null);
  clearRegistry(); clearDeterministicRecheckRegistry();
});

test('nonImplementationGate blocks a "let me read" comment and a short fence-free reply, but not a structured change or an empty-approval source', () => {
  const run = (implementResponse, extra = {}) => {
    const task = Fx.task({ implementResponse, ...extra });
    const trimmed = implementResponse.trim();
    const ctx = Fx.ctx({ task, trimmedImplResponse: trimmed, effectivelyEmpty: trimmed === '' });
    return { r: gates.nonImplementationGate(ctx), ctx };
  };
  const a = run('Let me read the file first and then decide what to do about it all, since this is long enough to pass the length rule');
  Fx.blockedBy(a.r, 'deterministic-non-implementation', a.ctx);
  const b = run('I think it is fine.');
  assert.equal(b.r.verdict, 'blocked');
  assert.equal(run('{"mode": "delete", "file": "a.js"}').r, null);
  assert.equal(run('```diff\n+x\n```').r, null);
  clearRegistry();
  registerTaskSource('dg_empty2', { priority: 5, next: () => null, emptyApproval: true });
  assert.equal(run('I think it is fine.', { source: 'dg_empty2' }).r, null);
  clearRegistry();
});

test('fixedLiteralsGate requires every fixed block character for character and tolerates a missing trailing newline', () => {
  const lit = [{ name: 'BLOCK_A', content: 'line one\nline two\n' }];
  const mk = (resp) => { const task = Fx.task({ implementResponse: resp, promptContext: { fixedLiterals: lit } }); return Fx.ctx({ task, trimmedImplResponse: resp.trim() }); };
  const bad = mk('```\nline one\nline 2\n```');
  const r = gates.fixedLiteralsGate(bad);
  Fx.blockedBy(r, 'deterministic-fixed-literals', bad);
  assert.match(r.blockedReason, /BLOCK_A/);
  assert.equal(gates.fixedLiteralsGate(mk('```\nline one\nline two\n```')), null);
  assert.equal(gates.fixedLiteralsGate(mk('line one\nline two')), null, 'a missing trailing newline on the copied block is tolerated');
  assert.equal(gates.fixedLiteralsGate(Fx.ctx()), null);
});

test('unaddressedCritiqueGate blocks only when the critique flagged issues and no revision was applied', () => {
  const mk = (over) => Fx.ctx({ task: Fx.task(over) });
  const bad = mk({ critiqueOutcome: 'issues-flagged', revisionApplied: false });
  Fx.blockedBy(gates.unaddressedCritiqueGate(bad), 'deterministic-unaddressed-critique', bad);
  assert.equal(gates.unaddressedCritiqueGate(mk({ critiqueOutcome: 'issues-flagged', revisionApplied: true })), null);
  assert.equal(gates.unaddressedCritiqueGate(mk({ critiqueOutcome: 'clean', revisionApplied: false })), null);
});

test('missingAcceptanceGate blocks an implemented adhoc task with criteria but no results, and honours the kill switch', () => {
  clearRegistry();
  registerTaskSource('adhoc', { priority: 5, next: () => null });
  const mk = (over) => Fx.ctx({ task: Fx.task({ source: 'adhoc', adhocResolution: 'implemented', acceptanceCriteria: ['c1', 'c2'], ...over }) });
  const bad = mk({});
  const r = gates.missingAcceptanceGate(bad);
  Fx.blockedBy(r, 'deterministic-missing-acceptance', bad);
  assert.match(r.blockedReason, /2 acceptance criteria/);
  assert.equal(gates.missingAcceptanceGate(mk({ acceptanceResults: [{ ok: true }] })), null);
  assert.equal(gates.missingAcceptanceGate(mk({ adhocResolution: 'decompose' })), null);
  process.env.AGENT_MANAGER_ADHOC_ACCEPTANCE_GATE = 'false';
  try { assert.equal(gates.missingAcceptanceGate(mk({})), null); } finally { delete process.env.AGENT_MANAGER_ADHOC_ACCEPTANCE_GATE; }
  clearRegistry();
});

test('missingCodeShapeGate blocks a prose-only candidate from a source that requires code, and passes one with a fence, a diff line or named pieces', () => {
  clearRegistry();
  registerTaskSource('dg_shape', { priority: 5, next: () => null, requireCodeShapeInCandidate: true });
  const mk = (resp) => Fx.ctx({ task: Fx.task({ source: 'dg_shape', implementResponse: resp }), trimmedImplResponse: resp.trim() });
  const bad = mk('### AC-1\nSolution: just rewrite it somehow.');
  Fx.blockedBy(gates.missingCodeShapeGate(bad), 'deterministic-missing-code-diff', bad);
  assert.equal(gates.missingCodeShapeGate(mk('### AC-1\nSolution: use\n```js\nx()\n```')), null);
  assert.equal(gates.missingCodeShapeGate(mk('### AC-1\nSolution:\n+added line here')), null);
  assert.equal(gates.missingCodeShapeGate(mk('### AC-1\nSolution: extract parse_header and buildFooter pieces')), null);
  assert.equal(gates.missingCodeShapeGate(mk('Prose without a candidate header.')), null);
  clearRegistry();
});

test('runDeterministicGates keeps the original gate order, returns the trimmed draft when nothing fires, and passes its context to the gates', () => {
  clearRegistry();
  const both = Fx.ctx({ task: Fx.task({ implementResponse: 'Let me read the file first and then decide what to do about it all, long enough for length' }),
    factCheck: { flags: [{ type: 'ungrounded-url', detail: 'http://u.example' }] } });
  const base = (c) => ({ task: c.task, factCheck: c.factCheck, factCheckVerdict: 'flagged', repoRootForCheck: c.repoRootForCheck, factCheckExtraRoots: [], groundingRef: null, pipelineDir: c.pipelineDir, recordModelOutcome: c.recordModelOutcome });
  const first = gates.runDeterministicGates(base(both));
  assert.equal(first.early.verdict, 'blocked');
  assert.equal(both.task.reviewProvider, 'deterministic-ungrounded-value');
  const twoFlags = Fx.ctx({ factCheck: { flags: [{ type: 'reverts-a-prior-fix', detail: 'rev' }, { type: 'ungrounded-field', detail: 'FIELD_X' }] } });
  gates.runDeterministicGates(base(twoFlags));
  assert.equal(twoFlags.task.reviewProvider, 'deterministic-ungrounded-value', 'the ungrounded-value gate runs before the reverts-a-prior-fix gate');
  const clean = Fx.ctx({ task: Fx.task({ implementResponse: '  ```diff\n+x\n```  ' }) });
  const out = gates.runDeterministicGates(base(clean));
  assert.equal(out.early, undefined);
  assert.equal(out.trimmedImplResponse, '```diff\n+x\n```');
  const crit = Fx.ctx({ task: Fx.task({ critiqueOutcome: 'issues-flagged', revisionApplied: false, implementResponse: 'I think it is fine.' }) });
  const secondStage = gates.runDeterministicGates(base(crit));
  assert.equal(crit.task.reviewProvider, 'deterministic-non-implementation', 'the non-implementation gate runs before the critique gate');
  assert.equal(secondStage.early.verdict, 'blocked');
  assert.equal(Fx.auditLines(both.pipelineDir).length, 1);
});

test('end to end through reviewTask(): a fixed-literals block reaches the caller with the recorded outcome and the fact-check label', async () => {
  const f = Fx.fixture();
  clearRegistry();
  registerTaskSource('dg_e2e', { priority: 5, next: () => null });
  const outcomes = [];
  const result = await reviewTask.reviewTask(Fx.task({ id: 'dg-e2e', source: 'dg_e2e', promptContext: { fixedLiterals: [{ name: 'LIT_X', content: 'must appear' }] } }), {
    repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, pipelineDir: f.pipelineDir,
    recordModelOutcome: (o) => outcomes.push(o), localMajorityVote: async () => { throw new Error('no vote expected'); } });
  clearRegistry();
  assert.equal(result.verdict, 'blocked');
  assert.match(result.blockedReason, /LIT_X/);
  assert.equal(result.factCheckVerdict, 'flagged', 'the fixture diff cites a file that does not exist, so the fact-check label is flagged');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].callId, 'call-dg');
});

test('end to end through reviewTask(): an ungrounded url in a real adhoc draft is blocked and logged under the pipelineDir runReview was given', async () => {
  const f = Fx.fixture();
  fs.mkdirSync(path.join(f.repoRoot, 'src'));
  fs.writeFileSync(path.join(f.repoRoot, 'src', 'real.js'), 'module.exports = "hello";\n');
  fs.writeFileSync(f.domainsPath, JSON.stringify({ adhoc: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' }, default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  const savedRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_REPO_ROOT = f.repoRoot;
  const outcomes = [];
  try {
    const task = Fx.task({ id: 'dg-url', domain: 'adhoc', source: 'adhoc', adhocResolution: 'implemented', promptContext: { rawText: 'change src/real.js' },
      implementResponse: 'Edit src/real.js to call http://fabricated.example/zzz/endpoint now.\n```diff\n--- a/src/real.js\n+++ b/src/real.js\n@@ -1 +1 @@\n-module.exports = "hello";\n+module.exports = "http://fabricated.example/zzz/endpoint";\n```' });
    const result = await reviewTask.reviewTask(task, { repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, pipelineDir: f.pipelineDir,
      recordModelOutcome: (o) => outcomes.push(o), localMajorityVote: async () => { throw new Error('no vote expected'); } });
    assert.equal(result.verdict, 'blocked');
    assert.match(result.blockedReason, /ungrounded-url: http:\/\/fabricated\.example\/zzz\/endpoint/);
    assert.equal(task.reviewProvider, 'deterministic-ungrounded-value');
    assert.equal(outcomes.length, 1);
    assert.equal(Fx.auditLines(f.pipelineDir).length, 1);
  } finally { if (savedRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = savedRoot; }
});

test('end to end through reviewTask(): the draft the gates trimmed is what the later stages see (an empty-string draft is approved by an empty-approval source)', async () => {
  const f = Fx.fixture();
  clearRegistry();
  registerTaskSource('dg_e2e_empty', { priority: 5, next: () => null, emptyApproval: true });
  const result = await reviewTask.reviewTask(Fx.task({ id: 'dg-e2e2', source: 'dg_e2e_empty', implementResponse: '""', promptContext: { harnessHits: 2 } }), {
    repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, pipelineDir: f.pipelineDir,
    recordModelOutcome: () => {}, localMajorityVote: async () => { throw new Error('no vote expected'); } });
  clearRegistry();
  assert.equal(result.verdict, 'approved');
});

test('the gates module does not require review-task.js (no import cycle)', () => {
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/review-deterministic-gates.js'].includes('src/review-task.js'), false);
});
