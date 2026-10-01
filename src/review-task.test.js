'use strict';

// Unit tests for review-task.js -- previously untested entirely, despite being the
// review gate that decides approved vs. blocked for every task in this pipeline.
// Added alongside the 2026-08-16 brain_dump_sort fix: confirmed live that EVERY real
// brain_dump_sort task was getting rejected at review for two compounding reasons, both
// covered here -- (1) buildVerdictPrompt's generic "does it contain real, complete
// code" framing, with no brain_dump_sort carve-out (unlike arch_discovery/
// project_search/deep_dive/arch_import, which already had one each), judged a
// classification JSON as if it were supposed to be a code change; (2) the fact-check
// step checked secondBrainPath against repoRoot instead of secondBrainDir, so it
// reported "missing" regardless of whether the destination note already existed.
//
// Run: node --test src/review-task.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// reviewTask spawns get-grounding-source.js as a real child process (execFileSync) --
// that script requires AGENT_MANAGER_REPO_ROOT at load time same as every other CLI
// entry point in this package. reviewTask's own try/catch around that call already
// swallows the failure into groundingText='' when this isn't set (confirmed harmless --
// every test below still passes without it), but leaving it unset just means each test
// run prints a real uncaught-exception stack trace to stderr for no benefit. Forced
// (not `||`-defaulted) unconditionally: confirmed live 2026-08-24 that apply-task.test.js's
// identical `||` pattern let an ambient real AGENT_MANAGER_REPO_ROOT leak straight through
// into getConfig() and pollute the real repo's own Docs/*_CANDIDATES.md files -- the same
// risk applies here even though this file's own tests don't touch that path today.
process.env.AGENT_MANAGER_REPO_ROOT = require('os').tmpdir();
// Executed verification (review-verify.js) creates a real scratch worktree and runs tests, so it is OFF for this file's many fixture-based adhoc
// tasks (fake rawDiffs, non-git repoRoot). The tests at the end of this file that exercise the gate switch it on and inject a fake verifier.
process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false';
process.env.AGENT_MANAGER_REVIEW_INERT_CHECK = 'false';
process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE = 'false';
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;

// 2026-08-23: review-task.js's own isEmptyApprovalSource/isAdvisoryProseSource now read
// each source's emptyApproval/advisoryProse flag off the shared task-source-registry
// (see that file's own comment) instead of a hardcoded local array -- which means the
// real registrations (task-sources.js's own registerTaskSource calls) have to have
// actually run before this test file's assertions about staleness_audit/
// observability_review/performance_review mean anything. Production always loads
// task-sources.js first; this test file didn't, so it's required here too, matching
// real load order rather than a standalone fixture.
require('./task-sources.js');

// observability_review/performance_review moved to the out-of-tree agent-manager-hygiene
// plugin (2026-08-27), so ./task-sources.js no longer registers them. The verdict-gate
// regression tests below assert that reviewTask does not auto-reject a short false-positive
// prose verdict from an advisoryProse source -- register a stub carrying that one flag so
// isAdvisoryProseSource() still resolves them the way production (plugin loaded) does.
//
// 2026-09-18: on a machine where plugins.json (gitignored, machine-local) actually names a
// real, loadable agent-manager-hygiene checkout, requiring './review-task.js' below calls
// config.js's ensureRegistered() at module top-level, which genuinely registers the REAL
// 'observability_review' etc. sources. Two failure modes came from this, both confirmed
// live on such a machine: (1) if this block's stub claims a name FIRST, the real
// registerTaskSource() call throws "already registered" when review-task.js is required
// below; (2) even letting the real registration win first avoids that crash, but the REAL
// plugin's actual behavior (e.g. arch_import's real harnessSearch/
// skipImplementWhenNoHarnessHits flags, observability_review's real deterministic-recheck
// rules instead of this file's fixture-bug-marker rule) then diverges from what tests below
// assert, since they were written against the stub shape. Neither reproduces in an
// isolated clone with no plugins.json (the normal CI/scratchpad shape) -- ensureRegistered()
// there is a safe no-op -- so this went unnoticed on any machine but one with a real,
// loadable plugin manifest.
//
// The robust fix: make this suite's plugin-loading behavior the same on EVERY machine,
// not conditional on what happens to be installed locally. Neutralize ensureRegistered()
// itself so the real plugin never loads during these tests regardless of ambient
// plugins.json/AGENT_MANAGER_REGISTER_PATH, and the fixture stubs below always win,
// matching what this file's tests were actually written against.
{
  const configModule = require('./config.js');
  configModule.ensureRegistered = () => {};
}
{
  const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  for (const name of ['observability_review', 'performance_review']) {
    if (!getRegisteredSource(name)) {
      registerTaskSource(name, { priority: 80, next: () => null, apply: () => ({ skipped: true }), advisoryProse: true });
    }
  }
  // The candidate-shape gate and the cited-path pre-validation are driven by registration flags (ADR-0022: core names no plugin
  // source). function_length_review (requireCodeShapeInCandidate) and arch_import (preValidateCitedPaths) register them in
  // production; project_search's flag is set by core's own registration.
  if (!getRegisteredSource('function_length_review')) {
    registerTaskSource('function_length_review', { priority: 80, next: () => null, apply: () => ({ skipped: true }), advisoryProse: true, requireCodeShapeInCandidate: true });
  }
  if (!getRegisteredSource('fixture_prevalidate_cited_paths')) {
    registerTaskSource('fixture_prevalidate_cited_paths', { priority: 80, next: () => null, apply: () => ({ skipped: true }), preValidateCitedPaths: true });
  }
  if (!getRegisteredSource('fixture_no_flags')) {
    registerTaskSource('fixture_no_flags', { priority: 80, next: () => null, apply: () => ({ skipped: true }), advisoryProse: true });
  }
  // 2026-09-18: a fixture candidateFulfillment sibling opted into premiseRecheckSource,
  // plus the deterministic-recheck rule set it points at -- see premise-recheck-decision
  // test coverage below and premise-recheck-decision.js's own unit tests for the module
  // itself. Real observability_fix/performance_fix registrations (agent-manager-hygiene)
  // carry the identical shape in production.
  if (!getRegisteredSource('fixture_premise_recheck_fix')) {
    registerTaskSource('fixture_premise_recheck_fix', {
      priority: 80, next: () => null, candidateFulfillment: true, premiseRecheckSource: 'observability_review',
    });
  }
  const { registerDeterministicRecheck, getDeterministicRecheck } = require('./deterministic-recheck-registry.js');
  if (!getDeterministicRecheck('observability_review')) {
    registerDeterministicRecheck('observability_review', {
      perFileRules: {
        'fixture-bug-marker': (text) => text.split('\n').flatMap((line, i) => (
          /\bBUG\b/.test(line) ? [{ file: null, line: i + 1, detail: 'BUG marker present' }] : []
        )),
      },
    });
  }
}

const { reviewTask, buildVerdictPrompt, renderImplementResponseForReview } = require('./review-task.js');

// A generic reviewable task that DOES go through the LLM majority vote. (brain_dump_sort
// stopped doing that in 2026-09-03 -- it uses deterministicReview now, see
// brainDumpSortReviewTask below and brain-dump-sort-classify.js.)
function baseTask(overrides = {}) {
  return {
    id: 'test-task-1',
    domain: 'default',
    source: 'trouble_log',
    title: 'Fix the thing',
    planResponse: '1. Add a guard in foo.js.',
    implementResponse: '{"mode":"edit","file":"foo.js","find":"doThing()","replace":"if (ok) doThing()"}',
    ...overrides,
  };
}

function brainDumpSortTask(overrides = {}) {
  return {
    id: 'brain-dump-sort-bd-test-1',
    domain: 'brain_dump_sort',
    source: 'brain_dump_sort',
    title: 'Sort brain dump entry: test',
    planResponse: '1. This note is about X.\n2. actionable: false\n3. reference\n4. References/x.md',
    implementResponse: JSON.stringify({
      secondBrainPath: 'References/x.md', tags: ['x'],
      actionable: false, rationale: 'documentation', belongsToProject: null,
    }),
    ...overrides,
  };
}

// 2026-08-24 (Grimmethy, caught live): a real, well-sourced research draft citing real
// June/August 2026 press coverage got rejected -- the reviewer's own blockedReason said
// "given the current real-world date context (2024/2025)", i.e. it had no real anchor for
// "today" at all. Fixed by stating the actual date unconditionally.
test('buildVerdictPrompt shows advisory grounding warnings, and omits the section when there are none', () => {
  const withWarn = buildVerdictPrompt({ ...baseTask(), groundingWarnings: ['symbol `resetResults` not found in the cited file(s)'] }, { flags: [] }, '');
  assert.match(withWarn, /Grounding warnings \(advisory\)/);
  assert.match(withWarn, /`resetResults` not found/);
  assert.match(withWarn, /not proof of a defect/);
  assert.doesNotMatch(buildVerdictPrompt(baseTask(), { flags: [] }, ''), /Grounding warnings/);
});

test('buildVerdictPrompt states the real current date so recency judgments have a real anchor', () => {
  const prompt = buildVerdictPrompt(baseTask(), { flags: [] }, '');
  const today = new Date().toISOString().slice(0, 10);
  assert.match(prompt, new RegExp(`real current date is ${today}`));
  assert.match(prompt, /do not reject a cited source, URL, or claimed date merely for being after some earlier date/);
});

test('brain_dump_sort takes the deterministic-review path -- a valid classification is approved with no vote', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const task = brainDumpSortTask();
  let voteCalled = false;
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: async () => { voteCalled = true; throw new Error('vote must not be called for brain_dump_sort'); },
    recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'approved');
  assert.equal(task.reviewProvider, 'deterministic-brain-dump-sort');
  assert.equal(voteCalled, false);
});

test('an honest null from an advisory report source is approved deterministically with no vote (advisory-null-outcome)', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const cases = [
    ['pipeline_forensics', 'NO CLEAR ROOT CAUSE -- the bundle has zero model_calls rows and zero contrast winners, so a counterfactual cannot be grounded; the trace of the subject is the one missing signal.'],
    ['pipeline_health_audit', 'FALSE POSITIVE -- a live operational event (pending backlog plus Ollama timeouts), not a code defect: none of the matched files shows a root cause worth patching.'],
    ['pipeline_debrief', ['WHAT', 'x', '', 'SO WHAT', 'None of the four flag categories cleanly apply.', '', 'NO CONFIDENT INEFFICIENCY -- the one additional signal needed is a model_calls row showing a plan or critique call.'].join('\n')],
  ];
  for (const [source, response] of cases) {
    const task = { id: `null-${source}`, source, domain: 'default', title: `t ${source}`, implementResponse: response, planResponse: 'p', promptContext: {} };
    let voteCalled = false;
    const outcomes = [];
    const result = await reviewTask(task, {
      repoRoot, secondBrainDir, domainsPath,
      localMajorityVote: async () => { voteCalled = true; throw new Error('vote must not be called for an honest null'); },
      recordModelOutcome: (o) => outcomes.push(o.outcome),
    });
    assert.equal(result.verdict, 'approved', source);
    assert.equal(task.reviewProvider, 'deterministic-null-outcome', source);
    assert.equal(voteCalled, false, source);
    assert.deepEqual(outcomes, ['approved'], source);
    assert.ok(task.history.some((h) => h.stage === 'approved' && /^deterministic-null-outcome: /.test(h.detail)), source);
  }
});

test('a report that merely mentions a null phrase is NOT auto-approved (falls through to the normal review path)', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const task = { id: 'not-null', source: 'pipeline_forensics', domain: 'default', title: 't', implementResponse: 'ROOT CAUSE 1: the retry cap is 2.\n\nNO CLEAR ROOT CAUSE -- for the second failure the evidence gives no trace to rank against at all here.', planResponse: 'p', promptContext: {} };
  try {
    await reviewTask(task, {
      repoRoot, secondBrainDir, domainsPath,
      localMajorityVote: async () => ({ verdict: 'APPROVE', votes: [], response: 'APPROVE: ok' }),
      recordModelOutcome: () => {},
    });
  } catch (e) { /* the normal path may need more fixture; only the routing matters here */ }
  assert.notEqual(task.reviewProvider, 'deterministic-null-outcome');
});

test('brain_dump_sort deterministic review BLOCKS a malformed classification with a specific reason (informed retry, not a dead end)', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const task = brainDumpSortTask({ implementResponse: 'let me read the vault first' });
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: async () => { throw new Error('vote must not be called'); },
    recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blockedStage, 'review');
  assert.match(result.blockedReason, /Deterministic review:/);
});

// 2026-09-08, brain-dump bd-1788787323412 ("investigate the COMPLETED 20 (line 2714)
// failure mode"): the real incident shape -- a refusal sentence followed by a code
// fragment that cuts off mid-string at an unterminated trailing quote -- must be rejected
// before any fact-check/vote call, on a real (non-brain_dump_sort) task that would
// otherwise reach the full review machinery.
test('a truncated implementResponse (refusal + unterminated code fragment) is blocked before any fact-check or vote call', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const task = baseTask({
    implementResponse: 'I could not find the exact pattern, but here is my best attempt:\nfunction example() {\n  return "Topology',
  });
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: async () => { throw new Error('vote must not be called for a truncated draft'); },
    recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blockedStage, 'review');
  assert.equal(result.blockedReason, 'truncated output');
  assert.equal(result.factCheckVerdict, 'skipped');
  assert.equal(task.reviewProvider, 'deterministic-truncation-guard');
});

test('a normal, well-formed implementResponse is NOT caught by the truncation guard', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const capturedPrompts = [];
  const task = baseTask();
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: fakeApprove(capturedPrompts),
    recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'approved');
  assert.equal(capturedPrompts.length, 1, 'the real vote path was reached, not short-circuited');
});

test('brain_dump_sort deterministic review BLOCKS an off-taxonomy secondBrainPath', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const task = brainDumpSortTask({
    implementResponse: JSON.stringify({ secondBrainPath: 'RandomFolder/x.md', tags: [], actionable: false }),
  });
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath, localMajorityVote: async () => { throw new Error('no vote'); }, recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.match(result.blockedReason, /not one of the allowed second-brain folders/);
});

test('buildVerdictPrompt keeps the generic code-review framing for a real code-change source', () => {
  const task = baseTask({ domain: 'default', source: 'trouble_log', implementResponse: '{"mode":"edit","file":"a.js","find":"x","replace":"y"}' });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /does it contain real, complete code/i);
  assert.doesNotMatch(prompt, /CLASSIFICATION task/);
});

test('buildVerdictPrompt gives adhoc (source: manual) tasks a grounded-deviation carve-out, not plan-scope-as-authoritative', () => {
  const task = baseTask({
    domain: 'default',
    source: 'manual',
    planResponse: '1. Add a null check in foo.js.',
    implementResponse: 'Investigated and the real bug was in bar.js, not foo.js.\n\n=== DIFF ===\ndiff --git a/bar.js b/bar.js\n...\nRESOLUTION: implemented',
  });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /PLAN section above was drafted BLIND/);
  assert.match(prompt, /do NOT reject the implement draft merely because it touches different files/);
  assert.doesNotMatch(prompt, /CLASSIFICATION task/);
});

test('buildVerdictPrompt does not fabricate a carve-out for a source with none defined', () => {
  const task = baseTask({ domain: 'default', source: 'unused_export' });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.doesNotMatch(prompt, /architecture-discovery task/);
  assert.doesNotMatch(prompt, /CLASSIFICATION task/);
});

// ADR-0022 Stage A2: buildVerdictPrompt no longer carries an if (task.source === ...) chain;
// it reads each source's carve-out + completeness question off the registry
// (source.reviewGuidance / source.reviewCompletenessQuestion). Guard the seam itself so a
// future refactor can't silently drop it -- register an ad-hoc source and prove both fields
// reach the prompt, including the (task) => string function form.
test('buildVerdictPrompt surfaces reviewGuidance / reviewCompletenessQuestion from the registry', () => {
  const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  if (!getRegisteredSource('sa2_probe_source')) {
    registerTaskSource('sa2_probe_source', {
      priority: 50,
      next: () => null,
      reviewGuidance: (t) => `PROBE GUIDANCE for ${t.title}`,
      reviewCompletenessQuestion: 'Does the PROBE draft answer every probe point?',
    });
  }
  const task = baseTask({ domain: 'default', source: 'sa2_probe_source', title: 'probe run' });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /PROBE GUIDANCE for probe run/);
  assert.match(prompt, /Does the PROBE draft answer every probe point\?/);
  assert.doesNotMatch(prompt, /does it contain real, complete code/i);
});

// ADR-0022 Stage G: review-task.js no longer names any plugin source. arch_discovery /
// arch_import get their reviewGuidance from the agent-manager-hygiene plugin; with the
// plugin unloaded (as in this suite) buildVerdictPrompt just emits no source-specific
// carve-out for them -- the generic framing still applies.
test('buildVerdictPrompt emits no arch-specific carve-out when the hygiene plugin is not loaded (no core fallback)', () => {
  const { getRegisteredSource } = require('./task-source-registry.js');
  assert.equal(getRegisteredSource('arch_discovery'), undefined, 'precondition: plugin not loaded here');
  const prompt = buildVerdictPrompt(baseTask({ domain: 'default', source: 'arch_discovery' }), { flags: [] }, '');
  assert.doesNotMatch(prompt, /architecture-discovery task: finding ZERO real issues/);
  assert.match(prompt, /does it contain real, complete code/i, 'generic completeness framing still present');
});

// Regression, 2026-08-22: caught live -- a real staleness_audit advisory report
// (hedged, uncertain prose by design -- see stalenessAuditImplementPrompt, prompts.js)
// got rejected by review as "meta-commentary and hedging... rather than providing the
// requested implementation," because buildVerdictPrompt had no carve-out for it and the
// generic instructions explicitly tell a reviewer to reject exactly that language shape.
test('buildVerdictPrompt gives staleness_audit its own carve-out -- hedged prose is the expected deliverable, not a rejection signal', () => {
  const task = baseTask({
    domain: 'default',
    source: 'staleness_audit',
    implementResponse: '**Advisory report**\n\n1. Inconclusive on the original concern.\n2. Fabrication confirmed.\n\nRECOMMENDATION: worth a fresh investigation.',
  });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /staleness-audit task/);
  assert.match(prompt, /Hedged, uncertain language.*is the EXPECTED and CORRECT way/);
  assert.match(prompt, /RECOMMENDATION line/);
  assert.doesNotMatch(prompt, /does it contain real, complete code/i);
  assert.doesNotMatch(prompt, /CLASSIFICATION task/);
});

// Regression guard, 2026-08-24: a RESOLUTION: decompose draft (adhoc-agentic-draft.js)
// deliberately contains no diff -- without a carve-out, the generic "does it contain
// real, complete code" completeness question and the ordinary manual-source carve-out
// (which assumes every adhoc draft has a diff) would both push a reviewer toward
// rejecting a genuinely correct decomposition for the same reason the done-archive task
// got wrongly rejected once already (a degenerate "no changes needed" with no diff).
test('buildVerdictPrompt gives a RESOLUTION: decompose adhoc draft its own carve-out -- no diff is expected, not a rejection signal', () => {
  const task = baseTask({
    domain: 'default',
    source: 'manual',
    adhocResolution: 'decompose',
    planResponse: '1. Add a daily archive pass for queue/done/.',
    implementResponse: 'Too large for one pass.\n\n[{"title":"Add src/done-archive.js","rawText":"..."},{"title":"Wire into queue-watcher.sh","rawText":"..."}]\n\nSplit into 2 pieces.',
  });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /DECOMPOSE rather than implement directly/);
  assert.match(prompt, /COVERAGE IS THE MAIN TEST/);
  assert.match(prompt, /If even one named deliverable is not covered by any sub-task, REJECT/);
  assert.doesNotMatch(prompt, /does it contain real, complete code/i);
});

// Regression, 2026-08-26: candidateSplitProposals (local-draft.js's parseCandidateSplit,
// see prompts.js's candidateSplitInstructions for the full incident/design) is the same
// "deliberately no diff" shape as RESOLUTION: decompose above, for the candidate-
// fulfillment sources (arch_review, observability_fix, etc.) instead of adhoc.
test('buildVerdictPrompt gives a candidateSplitProposals draft its own carve-out -- no diff is expected, not a rejection signal', () => {
  const task = baseTask({
    domain: 'default',
    source: 'arch_review',
    candidateSplitProposals: [
      { title: 'Extract git path', problem: 'p1', solution: 's1', benefits: 'b1' },
      { title: 'Extract direct-write path', problem: 'p2', solution: 's2', benefits: 'b2' },
    ],
    planResponse: '1. Extract git vs direct-write apply paths.',
    implementResponse: JSON.stringify({ mode: 'split', candidates: [{ title: 'a' }, { title: 'b' }] }),
  });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /judged the original candidate too large\/risky/);
  assert.match(prompt, /COVERAGE IS THE MAIN TEST/);
  assert.match(prompt, /REJECT if any named deliverable/);
  assert.doesNotMatch(prompt, /does it contain real, complete code/i);
});

// S3-a of the hub-tasks extraction (2026-09-23): the ORIGINAL REQUEST injection (this
// test) and the fact-check hard-block carve-out (isDecomposeProposal, further down in
// review-task.js) both read hub-review-detection.js's swap point now, not an inline field
// check duplicated in two places. Proves an override actually changes
// buildVerdictPrompt's behavior for a task the DEFAULT predicate would say no to (not
// 'manual', no candidateSplitProposals), and restores the default afterward since the
// module is a process-wide singleton shared across every test in this file. (The separate
// "COVERAGE IS THE MAIN TEST" carve-out text a few lines below in review-task.js is gated
// by task.candidateSplitProposals directly, not this hook -- deliberately out of scope
// here, see the PR description.)
test('buildVerdictPrompt honors an overridden decompose-proposal detection instead of the default field check', () => {
  const { setDecomposeProposalDetection } = require('./hub-review-detection.js');
  const task = baseTask({
    domain: 'default', source: 'trouble_log', // NOT 'manual', no candidateSplitProposals -- the default predicate must say false
    promptContext: { rawText: 'the full original ask, ORIGINAL-REQUEST-MARKER-XYZ' },
  });
  try {
    setDecomposeProposalDetection({ isDecomposeOrSplitProposal: () => true });
    const prompt = buildVerdictPrompt(task, { flags: [] }, '');
    assert.match(prompt, /ORIGINAL REQUEST \(full text/);
    assert.match(prompt, /ORIGINAL-REQUEST-MARKER-XYZ/);
  } finally {
    setDecomposeProposalDetection(null); // restore the default -- singleton state shared across this whole suite
  }
});

test('buildVerdictPrompt injects the full ORIGINAL REQUEST for a decompose proposal so coverage is checkable', () => {
  const task = baseTask({
    domain: 'default', source: 'manual', adhocResolution: 'decompose',
    promptContext: { rawText: 'Add the marketplace backend: (1) a JSON schema, (2) config in app.py, (3) a GET /api/plugins/marketplace endpoint.' },
    planResponse: '1. do it',
    implementResponse: 'Too big.\n\n[{"title":"Add the seed file","rawText":"..."},{"title":"Add the test","rawText":"..."}]',
  });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /ORIGINAL REQUEST \(full text/);
  assert.match(prompt, /GET \/api\/plugins\/marketplace endpoint/);
  assert.match(prompt, /the sub-tasks below must TOGETHER cover every concrete deliverable/);
});

test('buildVerdictPrompt does NOT inject the ORIGINAL REQUEST block for a normal implemented adhoc draft', () => {
  const task = baseTask({
    domain: 'default', source: 'manual', adhocResolution: 'implemented',
    promptContext: { rawText: 'change X to Y' },
    implementResponse: 'done\n=== DIFF ===\ndiff --git a/x b/x\nRESOLUTION: implemented',
  });
  assert.doesNotMatch(buildVerdictPrompt(task, { flags: [] }, ''), /ORIGINAL REQUEST \(full text/);
});

test('buildVerdictPrompt keeps the ordinary manual-source (diff-grounded) carve-out for a normal adhoc task, not the decompose one', () => {
  const task = baseTask({
    domain: 'default',
    source: 'manual',
    adhocResolution: 'implemented',
    implementResponse: 'Fixed it.\n\n=== DIFF ===\ndiff --git a/x.js b/x.js\n...\nRESOLUTION: implemented',
  });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /PLAN section above was drafted BLIND/);
  assert.doesNotMatch(prompt, /DECOMPOSE rather than implement directly/);
});

// Regression, 2026-08-24: caught live on a real hardware-tracking-tab decompose -- a
// genuinely clean, well-scoped decomposition got rejected because the SEPARATE, earlier
// PLAN section (drafted blind, before any real investigation) contained a truncated/
// malformed illustrative Python snippet. buildVerdictPrompt always shows the PLAN
// unconditionally (its own fixed structure), so without telling the reviewer explicitly
// that the PLAN isn't the deliverable for a decompose resolution, a rough or broken plan
// sketch got read as evidence against the actual (clean) decomposition that followed it.
test('buildVerdictPrompt tells the reviewer NOT to judge a decompose draft by problems in the separate, blindly-drafted PLAN section', () => {
  const task = baseTask({
    domain: 'default',
    source: 'manual',
    adhocResolution: 'decompose',
    planResponse: '```python\ntry:\n    import psutil\nexcept ImportError:\npsutil = None\n\ns.gpu_mem_used_mb = gpu["mem_used\n```',
    implementResponse: 'Too large for one pass.\n\n[{"title":"Add a collector module","rawText":"a full, self-contained description"},{"title":"Persist snapshots","rawText":"a full, self-contained description"}]\n\nSplit into 2 pieces.',
  });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /PLAN section above was drafted BLIND/);
  assert.match(prompt, /NEVER reject over a problem in the PLAN itself/);
  assert.match(prompt, /Judge ONLY the actual DECOMPOSITION/);
});

// Proves the fix is actually systemic, not just a third copy-pasted carve-out: the
// "PLAN was drafted blind" protection fires for ANY source==='manual' task, including a
// resolution value that doesn't match decompose OR the plain diff carve-out below it (a
// stand-in for whatever adhoc resolution gets added next) -- because it's now stated
// once, unconditionally, ahead of the per-resolution branch chain, not duplicated inside
// each individual carve-out where a future addition could forget to repeat it.
test('buildVerdictPrompt protects the PLAN section for source==="manual" even under a resolution no specific carve-out recognizes', () => {
  const task = baseTask({
    domain: 'default',
    source: 'manual',
    adhocResolution: 'some-future-resolution-type-not-yet-invented',
    planResponse: 'some rough, possibly broken blind sketch',
    implementResponse: 'whatever this future resolution type actually produces',
  });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /PLAN section above was drafted BLIND/);
  assert.match(prompt, /NEVER reject over a problem in the PLAN itself/);
});

test('a short staleness_audit report is NOT auto-rejected by the deterministic non-implementation gate -- reaches the real (mocked) vote instead', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'staleness-test-1', domain: 'default', source: 'staleness_audit',
    title: 'Staleness audit: test',
    planResponse: 'QUERY: something',
    implementResponse: 'RECOMMENDATION: archive.', // deliberately short, no code fence -- would trip the <80-char heuristic for any other source
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured),
  });
  assert.notEqual(task.reviewProvider, 'deterministic-non-implementation');
  assert.equal(result.verdict, 'approved');
  assert.equal(captured.length, 1, 'a short-but-legitimate advisory report must reach the real reviewer vote, not get auto-rejected before it');
});

test('NON_IMPL gate: staleness_audit (advisoryProse) short prose is NOT flagged', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    source: 'staleness_audit',
    planResponse: 'QUERY: is this still valid?',
    implementResponse: 'This is a false positive; no action needed.', // 44 chars, no code fence -- would trip the <80-char heuristic for a non-exempt source
  });
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-non-implementation', 'advisoryProse source must be exempt from the deterministic non-implementation gate');
  assert.equal(result.verdict, 'approved', 'advisoryProse source must not be auto-rejected for short prose');
  assert.equal(captured.length, 1, 'the short advisory prose must reach the real reviewer vote');
});

test('NON_IMPL gate: non-exempt source short prose IS flagged', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    source: 'trouble_log', // NOT advisoryProse/emptyApproval -- the gate must fire
    planResponse: '1. Add a guard in foo.js.',
    implementResponse: 'This is a false positive; no action needed.', // same 44-char, no-code-fence prose as the exempt case above
  });
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(task.reviewProvider, 'deterministic-non-implementation', 'non-exempt source with <80-char no-code-fence prose must be flagged as non-implementation');
  assert.equal(result.verdict, 'blocked', 'non-exempt source SHOULD be auto-blocked for short prose');
  assert.equal(result.blockedStage, 'review');
  assert.match(result.blockedReason, /Deterministic gate: implementResponse is a bare tool-call request or meta-commentary/);
  assert.equal(captured.length, 0, 'no reviewer vote spent on a mechanically-decidable rejection');
});

// Regression, 2026-08-23: caught live -- observabilityReviewImplementPrompt/
// performanceReviewImplementPrompt (prompts.js) explicitly ask for a short 2-4 sentence
// prose paragraph on a FALSE POSITIVE/UNCERTAIN verdict, but neither source was in
// ADVISORY_PROSE_SOURCES, so a real, correct false-positive verdict routinely tripped
// the <80-char/no-code-fence heuristic and got blocked as "not a real implementation
// attempt" -- even though applyArchDiscoveryCandidates (task-sources.js) already treats
// a plain prose verdict as a documented no-op once it reaches apply().
for (const source of ['observability_review', 'performance_review']) {
  test(`a short ${source} false-positive verdict is NOT auto-rejected by the deterministic non-implementation gate -- reaches the real (mocked) vote instead`, async () => {
    const { repoRoot, domainsPath } = makeFixture();
    const task = {
      id: `${source}-test-1`, domain: 'default', source,
      title: `${source}: test finding`,
      planResponse: 'False positive -- this loop only runs once at startup.',
      implementResponse: 'False positive -- runs once at startup, not a hot path.', // short, no code fence -- would trip the <80-char heuristic for any other source
    };
    const captured = [];
    const result = await reviewTask(task, {
      repoRoot, domainsPath, localMajorityVote: fakeApprove(captured),
    });
    assert.notEqual(task.reviewProvider, 'deterministic-non-implementation');
    assert.equal(result.verdict, 'approved');
    assert.equal(captured.length, 1, 'a short-but-legitimate false-positive verdict must reach the real reviewer vote, not get auto-rejected before it');
  });

  // 2026-09-02: an advisoryProse source's GENUINE verdict is an `### AC-NNN` candidate
  // block whose Solution PROPOSES a name for a helper/constant a future fix should add.
  // checkGroundedValues flagged that ALLCAPS name as "ungrounded-field" and hard-blocked
  // before any vote -- a category error against a proposal, same as the decompose case.
  test(`an ${source} candidate block proposing a new ALLCAPS_CONST name is NOT hard-blocked by the ungrounded-value gate`, async () => {
    const { repoRoot, domainsPath } = makeFixture();
    const task = {
      id: `${source}-ungrounded-1`, domain: 'default', source,
      title: `${source}: test finding`,
      planResponse: 'GENUINE -- the loop awaits serially.',
      implementResponse: 'GENUINE\n\n### AC-1 Parallelize the serial await loop\nStrength: Strong\nFiles: a.js\nProblem: the loop awaits one item at a time.\nSolution: drive it with Promise.all, gated behind a new MAX_PARALLEL_FETCHES constant following the pattern of existing limits in config.js.\nBenefits: wall-clock drops from O(n) to O(1).',
      promptContext: { body: 'Background material with no mention of that constant at all.' },
    };
    const captured = [];
    const result = await reviewTask(task, {
      repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
    });
    assert.notEqual(task.reviewProvider, 'deterministic-ungrounded-value', 'MAX_PARALLEL_FETCHES is a PROPOSAL, not a claim it already exists');
    assert.equal(result.verdict, 'approved');
    assert.equal(captured.length, 1, 'the proposal must reach the real vote, not be auto-blocked');
  });
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-task-test-'));
  const repoRoot = path.join(dir, 'repo');
  const secondBrainDir = path.join(dir, 'secondbrain');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(secondBrainDir, { recursive: true });
  const domainsPath = path.join(dir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({
    brain_dump_sort: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' },
    default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' },
  }));
  return { dir, repoRoot, secondBrainDir, domainsPath };
}

// Captures the exact prompt reviewTask hands to the (faked) majority-vote call, so these
// tests can assert on what the reviewer model actually saw -- not just the final verdict,
// which a badly-reasoned APPROVE could still accidentally produce.
function fakeApprove(capturedPrompts) {
  return async ({ prompt }) => {
    capturedPrompts.push(prompt);
    return { confident: true, verdict: 'APPROVE', votes: [{ verdict: 'APPROVE', reasoning: 'looks correct and complete' }], realVoteCount: 3, requestedVotes: 3 };
  };
}

// Regression, 2026-08-24: voteErrors (majorityVote's own per-vote hard-failure record,
// commit 0ac54b9) was computed but never actually read by reviewTask -- real diagnostic
// signal (which votes hard-failed, and why) silently discarded on every review.
test('reviewTask surfaces majorityVote\'s voteErrors onto the task and into the history detail when present', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const task = baseTask();
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: async () => ({
      confident: true, verdict: 'APPROVE',
      votes: [{ verdict: 'APPROVE', response: 'APPROVE: looks fine' }],
      realVoteCount: 1, requestedVotes: 3,
      voteErrors: ['Ollama request timed out after 145000ms', 'Ollama request timed out after 132000ms'],
    }),
    recordModelOutcome: () => {},
  });

  assert.equal(result.succeeded, true);
  assert.deepEqual(task.voteErrors, ['Ollama request timed out after 145000ms', 'Ollama request timed out after 132000ms']);
  const approvedEntry = task.history.find((h) => h.stage === 'approved');
  assert.match(approvedEntry.detail, /2 vote\(s\) hard-failed/);
});

test('reviewTask leaves the vote-error suffix out entirely when every vote succeeded', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const task = baseTask();
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: fakeApprove(captured),
    recordModelOutcome: () => {},
  });

  assert.equal(result.succeeded, true);
  assert.equal(task.voteErrors, undefined);
  const approvedEntry = task.history.find((h) => h.stage === 'approved');
  assert.doesNotMatch(approvedEntry.detail, /hard-failed/);
});

test('reviewTask overwrites the stale "needs-review" status with the verdict, so it tracks the queue dir the file moves to', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();

  const approvedTask = baseTask({ status: 'needs-review' });
  await reviewTask(approvedTask, {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: fakeApprove([]),
    recordModelOutcome: () => {},
  });
  assert.equal(approvedTask.status, 'approved');

  const blockedTask = baseTask({ status: 'needs-review' });
  await reviewTask(blockedTask, {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: async () => ({
      confident: true, verdict: 'REJECT',
      votes: [{ verdict: 'REJECT', response: 'REJECT: incomplete' }],
      realVoteCount: 3, requestedVotes: 3,
    }),
    recordModelOutcome: () => {},
  });
  assert.equal(blockedTask.status, 'blocked');
});

test('reviewTask still runs the deep_dive clonePath override correctly', async () => {
  const { secondBrainDir, domainsPath: baseDomainsPath, dir } = makeFixture();
  const domainsPath = path.join(dir, 'task-domains-dd.json');
  fs.writeFileSync(domainsPath, JSON.stringify({
    deep_dive: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' },
  }));
  const clonePath = path.join(dir, 'clone');
  fs.mkdirSync(clonePath, { recursive: true });
  fs.writeFileSync(path.join(clonePath, 'real.ts'), '// real\n');
  const deepDiveCoveragePath = path.join(dir, 'deep-dive-coverage.json');
  fs.writeFileSync(deepDiveCoveragePath, JSON.stringify({
    projects: { 'some-slug': { clonePath, communities: [] } },
  }));

  const task = {
    id: 'dd-1', domain: 'deep_dive', source: 'deep_dive', title: 'deep dive test',
    planResponse: 'plan', implementResponse: 'File: real.ts\nRating: Use\nRationale: x',
    promptContext: { projectSlug: 'some-slug' },
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot: path.join(dir, 'unrelated-repo'), secondBrainDir, domainsPath, deepDiveCoveragePath,
    localMajorityVote: fakeApprove(captured),
    recordModelOutcome: () => {},
  });
  assert.equal(result.succeeded, true);
  assert.match(captured[0], /"claimedPath":"real\.ts","exists":true/);
});

// --- Pipeline hardening (2026-08-24): resurrects two real gaps closed once already on
// 2026-08-12 for the old Windows/PowerShell review-runner.ps1, never carried forward
// across this project's Linux port -- confirmed live via git archaeology that a stale,
// unmergeable branch (383 commits behind, deletes a file long since removed) still named
// two genuinely still-open weaknesses in review-task.js today. ------------------------

test('reviewTask deterministically rejects a draft whose own critique flagged issues with no successful revision -- no review call spent', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    domain: 'default', source: 'manual',
    critiqueOutcome: 'issues-flagged',
    revisionApplied: false,
    critiqueText: 'The secondBrainPath does not match the plan\'s stated destination.',
  });
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-unaddressed-critique');
  assert.match(result.blockedReason, /own critique pass flagged real issues/);
  assert.match(result.blockedReason, /secondBrainPath does not match/);
  assert.equal(captured.length, 0, 'no review call should be spent voting on a draft with a known, unaddressed critique');
});

test('reviewTask deterministically rejects an adhoc "implemented" draft with acceptance criteria but no Acceptance: block -- no vote spent', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    domain: 'default', source: 'manual', adhocResolution: 'implemented',
    acceptanceCriteria: ['pytest test_plugins.py passes', 'POST /api/plugins/install returns 201'],
    acceptanceResults: [],
    rawDiff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n',
  });
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-missing-acceptance');
  assert.match(result.blockedReason, /2 acceptance criteria but the implement draft produced no "Acceptance:" block/);
  assert.equal(captured.length, 0);
});

test('reviewTask reaches the vote when the acceptance criteria draft DID report results', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    domain: 'default', source: 'manual', adhocResolution: 'implemented',
    acceptanceCriteria: ['x passes'],
    acceptanceResults: [{ criterion: 'x passes', check: 'pytest', result: 'PASS', pass: true }],
    rawDiff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n',
  });
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-missing-acceptance');
  assert.equal(captured.length, 1);
});

test('reviewTask deterministically rejects a function_length_review draft with no code block or diff -- no vote spent', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    domain: 'default', source: 'function_length_review',
    implementResponse: '### AC-9\nProblem: this function is too long and does three unrelated things.\nSolution: split it into three smaller helper functions, one per responsibility, and call each in turn.',
  });
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-missing-code-diff');
  assert.match(result.blockedReason, /missing-code-diff/);
  assert.equal(captured.length, 0, 'no review call should be spent voting on a function_length_review draft with no code shape at all');
});

test('reviewTask lets a prose-only FALSE POSITIVE verdict for function_length_review through to the vote (it is the prompt-mandated shape)', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    domain: 'default', source: 'function_length_review',
    implementResponse: 'The 110-line count is dominated by roughly 75 lines of flat, declarative JSX with no nested conditionals or loops. The remaining lines are standard React wiring that express one cohesive flow, so the line-count threshold is a blunt heuristic that does not reflect real maintainability risk here.',
  });
  const captured = [];
  await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-missing-code-diff');
  assert.equal(captured.length, 1, 'the verdict reaches a real vote');
});

test('reviewTask reaches the vote for a function_length_review draft whose Solution includes a diff hunk', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  // CODE_MARKERS was removed 2026-09-15; the advisoryProse guard in
  // detectTruncatedImplementResponse now covers the case it used to handle (a
  // code-bearing advisory-prose draft can never be flagged truncated). The fixture
  // below intentionally uses a brace-bearing shape to exercise the exact input that
  // previously tripped the CODE_MARKERS path (pipeline-self-audit-function_length_review
  // -truncated-draft-1788034686181, 2026-08-29).
  const task = baseTask({
    domain: 'default', source: 'function_length_review',
    implementResponse: '### AC-9\nProblem: this function is too long.\nSolution:\n@@ -10,3 +10,5 @@\n+function foo() { return computeHelper(x); }\n+return foo();',
  });
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-missing-code-diff');
  assert.equal(captured.length, 1);
});

test('the acceptance pre-vote gate is skipped when AGENT_MANAGER_ADHOC_ACCEPTANCE_GATE=false', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  process.env.AGENT_MANAGER_ADHOC_ACCEPTANCE_GATE = 'false';
  try {
    const task = baseTask({
      domain: 'default', source: 'manual', adhocResolution: 'implemented',
      acceptanceCriteria: ['x passes'], acceptanceResults: [],
      rawDiff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n',
    });
    const captured = [];
    await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {} });
    assert.notEqual(task.reviewProvider, 'deterministic-missing-acceptance');
  } finally { delete process.env.AGENT_MANAGER_ADHOC_ACCEPTANCE_GATE; }
});

test('reviewTask reaches the real vote (does not auto-reject) when critique flagged issues but a revision was successfully applied', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    domain: 'default', source: 'manual',
    critiqueOutcome: 'issues-flagged',
    revisionApplied: true,
    critiqueText: 'The path was wrong in the first draft.',
  });
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-unaddressed-critique');
  assert.equal(result.verdict, 'approved');
  assert.equal(captured.length, 1);
});

test('reviewTask folds the critique text into the review prompt when a revision was applied, so the SAME vote can verify compliance', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    domain: 'default', source: 'manual',
    critiqueOutcome: 'issues-flagged',
    revisionApplied: true,
    critiqueText: 'The original draft referenced a nonexistent function name.',
  });
  const captured = [];
  await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.match(captured[0], /revised in response to an earlier critique/);
  assert.match(captured[0], /nonexistent function name/);
});

// 2026-09-18 (brain-dump bd-1789602450613): a real, correct fix (performance-fix-ac-6)
// was rejected twice, both votes quoting the CRITIQUE's description of the pre-revision
// draft as if it described the current one. Closes the loop immediately after the
// critique text with an explicit "this is the OLD version, not the current draft" line.
test('reviewTask closes the critique block with an explicit disambiguation, positioned AFTER the critique text', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    domain: 'default', source: 'manual',
    critiqueOutcome: 'issues-flagged',
    revisionApplied: true,
    critiqueText: 'The original draft was a bare refusal with no real edit.',
  });
  const captured = [];
  await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.match(captured[0], /EARLIER, ALREADY-SUPERSEDED version/);
  assert.match(captured[0], /do not reject the current draft/i);
  const critiqueIdx = captured[0].indexOf('The original draft was a bare refusal');
  const disambigIdx = captured[0].indexOf('EARLIER, ALREADY-SUPERSEDED version');
  assert.ok(critiqueIdx !== -1 && disambigIdx !== -1 && disambigIdx > critiqueIdx,
    'the disambiguation must come AFTER the critique text, closest to where the confusion originates');
});

test('reviewTask does not touch the critique gate at all when no critique ever ran (critiqueOutcome unset)', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({ domain: 'default', source: 'manual' });
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-unaddressed-critique');
  assert.equal(result.verdict, 'approved');
});

// promptContext.body is a plain grounding field get-grounding-source.js includes
// unconditionally for any domain (see that file's own main()) -- the simplest real path
// to a non-empty groundingText for this test, since reviewTask() builds it via a real
// child-process spawn keyed off the task's actual shape, not an injectable param.
test('reviewTask deterministically rejects a draft citing a URL not present anywhere in its real grounding source -- no review call spent', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'ungrounded-url-test', domain: 'default', source: 'manual',
    title: 'test', planResponse: 'plan',
    implementResponse: 'Real findings, citing https://totally-made-up-source.example-nonexistent.test/page for support.',
    promptContext: { body: 'Some real grounding text with no URLs in it at all.' },
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-ungrounded-value');
  assert.match(result.blockedReason, /ungrounded-url/);
  assert.match(result.blockedReason, /totally-made-up-source/);
  assert.equal(captured.length, 0, 'no review call should be spent voting on a draft with a known hallucinated URL');
});

// preValidateCitedPaths gate (2026-09-08 brain-dump request): project_search/arch_import
// drafts cite specific files/line-numbers as prose evidence, not a Group B diff -- this
// runs BEFORE the rest of the fact-checker, scoped to exactly those two sources.
test('reviewTask deterministically rejects a project_search draft citing a fabricated file path -- no review call spent', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'pre-validate-test', domain: 'default', source: 'project_search',
    title: 'test', planResponse: 'plan',
    implementResponse: 'The relevant logic lives in src/totally-made-up-file.js:12.',
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-pre-validation');
  assert.match(result.blockedReason, /^ungrounded draft: fabricated file path/);
  assert.match(result.blockedReason, /src\/totally-made-up-file\.js:12/);
  assert.equal(captured.length, 0, 'no review call should be spent voting on a draft with a known fabricated citation');
});

test('reviewTask applies the preValidateCitedPaths gate to ANY source that registers the flag (not by source name)', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'pre-validate-flag-test', domain: 'default', source: 'fixture_prevalidate_cited_paths',
    title: 'test', planResponse: 'plan',
    implementResponse: 'The relevant logic lives in src/totally-made-up-file.js:12.',
  };
  const captured = [];
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {} });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-pre-validation');
  assert.equal(captured.length, 0);
});

test('reviewTask does NOT apply the code-shape gate to a source that does not register requireCodeShapeInCandidate', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = baseTask({
    domain: 'default', source: 'fixture_no_flags',
    implementResponse: '### AC-9\nProblem: this function is too long and does three unrelated things.\nSolution: split it into three smaller helper functions, one per responsibility, and call each in turn.',
  });
  const captured = [];
  await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {} });
  assert.notEqual(task.reviewProvider, 'deterministic-missing-code-diff');
  assert.equal(captured.length, 1, 'a prose-only candidate from an unflagged source reaches the vote');
});

test('reviewTask does NOT apply the preValidateCitedPaths gate outside sources that register it', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'pre-validate-scope-test', domain: 'default', source: 'observability_fix',
    title: 'test', planResponse: 'plan',
    implementResponse: 'Added a console.warn to log the previously-swallowed error. The relevant logic lives in src/totally-made-up-file.js:12, which now surfaces the failure instead of silently discarding it.',
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-pre-validation');
  assert.equal(result.verdict, 'approved', 'same fabricated citation must not be auto-blocked for a source outside this gate\'s scope');
});

// reverts-a-prior-fix (2026-09-08, root-caused live via change-review-fix-ac-1 -- see
// fact-checker.js's checkRevertsAPriorFix header for the full incident) ------------------

function makeGitFixtureWithPriorFix() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-task-revert-test-'));
  const repoRoot = path.join(dir, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  const filePath = path.join(repoRoot, 'sweep.js');
  fs.writeFileSync(filePath, "  for (const dir of DIRS) {\n    try { names = fs.readdirSync(dir); } catch { continue; }\n  }\n");
  execFileSync('git', ['add', 'sweep.js'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'initial sweep loop'], { cwd: repoRoot });
  fs.writeFileSync(filePath, "  for (const dir of DIRS) {\n    try { names = fs.readdirSync(dir); } catch (err) { if (err.code === 'ENOENT') continue; console.error(err); throw err; }\n  }\n");
  execFileSync('git', ['add', 'sweep.js'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'AC-164 · Bare catch swallows non-ENOENT filesystem errors'], { cwd: repoRoot });
  const domainsPath = path.join(dir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  return { repoRoot, domainsPath };
}

test('reviewTask deterministically blocks a draft that reverts toward code removed by a prior AC-marked fix -- no review call spent', async () => {
  const { repoRoot, domainsPath } = makeGitFixtureWithPriorFix();
  const task = {
    id: 'revert-test', domain: 'default', source: 'change_review_fix',
    title: 'test', planResponse: 'plan',
    implementResponse: JSON.stringify([{
      file: 'sweep.js', mode: 'edit',
      find: "console.error(err); throw err; }",
      replace: "console.error(err); continue; }",
    }]),
    promptContext: { body: 'Some grounding text.' },
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-reverts-a-prior-fix');
  assert.match(result.blockedReason, /reverts-a-prior-fix|reverts toward/);
  assert.match(result.blockedReason, /AC-164/);
  assert.equal(captured.length, 0, 'no review call should be spent voting on a draft already known to revert a confirmed fix');
});

test('reviewTask does NOT block an edit near a prior AC-marked fix that is not actually a revert', async () => {
  const { repoRoot, domainsPath } = makeGitFixtureWithPriorFix();
  const task = {
    id: 'not-a-revert-test', domain: 'default', source: 'change_review_fix',
    title: 'test', planResponse: 'plan',
    implementResponse: JSON.stringify([{
      file: 'sweep.js', mode: 'edit',
      find: "console.error(err); throw err; }",
      replace: "logHardFailureAudit({ code: err.code }); throw err; }",
    }]),
    promptContext: { body: 'Some grounding text.' },
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-reverts-a-prior-fix');
  assert.equal(result.verdict, 'approved');
});

// stacked-branch grounding (2026-09-08 incident) -----------------------------------------
// A stacked task correctly citing a sibling's real, committed-but-unmerged value used to be
// hard-blocked here -- the git-grep fallback inside checkGroundedValues ran against
// repoRootForCheck's plain working tree (main), never task.stacked.branch, the branch the
// value actually lives on.

function makeGitFixtureWithStackedBranch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-task-stacked-test-'));
  const bareDir = path.join(dir, 'origin.git');
  const repoRoot = path.join(dir, 'repo');
  const secondBrainDir = path.join(dir, 'secondbrain');
  fs.mkdirSync(secondBrainDir, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', bareDir]);
  execFileSync('git', ['clone', bareDir, repoRoot]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'test');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoRoot });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: repoRoot });

  execFileSync('git', ['checkout', '-b', 'agent/stacked-family'], { cwd: repoRoot });
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'sibling.js'), 'const SIBLING_ONLY_FIELD = 1;\n');
  execFileSync('git', ['add', 'src/sibling.js'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'sibling commit'], { cwd: repoRoot });
  execFileSync('git', ['push', 'origin', 'agent/stacked-family'], { cwd: repoRoot });
  execFileSync('git', ['checkout', 'main'], { cwd: repoRoot });

  const domainsPath = path.join(dir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({
    default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' },
  }));
  return { dir, repoRoot, secondBrainDir, domainsPath };
}

test('reviewTask does NOT hard-block a stacked task citing a real value that only exists on its own stacked branch', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeGitFixtureWithStackedBranch();
  const task = {
    id: 'stacked-grounding-test', domain: 'default', source: 'manual',
    title: 'test', planResponse: 'plan',
    implementResponse: 'Wire this through SIBLING_ONLY_FIELD, already added by the sibling move task earlier in this same stacked branch, with enough detail here to clear the length floor.',
    promptContext: { body: 'unrelated grounding material that never mentions this field' },
    stacked: { branch: 'agent/stacked-family', seq: 2, total: 2 },
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-ungrounded-value',
    'a value real on the task\'s own stacked branch must not trip the ungrounded-value gate');
  assert.equal(captured.length, 1, 'should reach the real review vote, not a false hard-block');
});

test('reviewTask STILL hard-blocks the same stacked task citing a genuinely fabricated field', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeGitFixtureWithStackedBranch();
  const task = {
    id: 'stacked-grounding-control-test', domain: 'default', source: 'manual',
    title: 'test', planResponse: 'plan',
    implementResponse: 'This relies on TOTALLY_MADE_UP_FIELD being set, with enough detail here to clear the length floor and reach the real fact-check gate.',
    promptContext: { body: 'grounding material with no mention of this field' },
    stacked: { branch: 'agent/stacked-family', seq: 2, total: 2 },
  };
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath, localMajorityVote: fakeApprove([]), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-ungrounded-value',
    'a value fabricated everywhere, including on the stacked branch, must still be caught -- proves this is not a blanket loosening of the gate');
});

// 2026-09-08, Second Brain [[dspy-deterministic-prompt-tuning]] research applied: this
// gate's own header comment calls itself "high-precision, almost never a false positive,"
// but this session found 4 confirmed false positives against that exact claim, discovered
// only by manually grepping every historical hard-block. One NDJSON line per hard block
// (now in pipeline-history.js's unified instances/pipeline-history.log, type:'fact-check-
// block' -- see that module's own header for why the 4 separately-invented per-class log
// files were consolidated) means the next investigation is `grep`, not archaeology across
// queue/done/.
test('reviewTask appends one NDJSON line to the unified pipeline-history.log every time the ungrounded-value gate hard-blocks', async () => {
  const { repoRoot, domainsPath, dir } = makeFixture();
  const task = {
    id: 'audit-log-test-1', domain: 'default', source: 'manual',
    title: 'test', planResponse: 'plan',
    implementResponse: 'Real findings, citing https://totally-made-up-source.example-nonexistent.test/page for support.',
    promptContext: { body: 'Some real grounding text with no URLs in it at all.' },
  };
  await reviewTask(task, { repoRoot, domainsPath, pipelineDir: dir, localMajorityVote: fakeApprove([]), recordModelOutcome: () => {} });

  const logPath = path.join(dir, 'instances', 'pipeline-history.log');
  assert.ok(fs.existsSync(logPath), 'the unified pipeline history log must exist after a hard block');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'fact-check-block');
  assert.equal(lines[0].taskId, 'audit-log-test-1');
  assert.equal(lines[0].source, 'adhoc', 'resolveSourceName maps a manual/default task to its real registered source name');
  assert.ok(lines[0].at, 'each entry carries its own real timestamp');
  assert.ok(Array.isArray(lines[0].flags) && lines[0].flags.length > 0);
  assert.equal(lines[0].flags[0].type, 'ungrounded-url');
});

test('reviewTask reaches the real vote when every URL in the draft actually appears in its grounding source', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'grounded-url-test', domain: 'default', source: 'manual',
    title: 'test', planResponse: 'plan',
    implementResponse: 'Real findings, citing https://real-source.example.test/page for support, with enough detail here to clear the length floor.',
    promptContext: { body: 'Background material mentioning https://real-source.example.test/page directly.' },
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-ungrounded-value');
  assert.equal(result.verdict, 'approved');
  assert.equal(captured.length, 1);
});

// Decompose-proposal exemption, 2026-08-25: root-caused live via a real blocked adhoc
// task (second-brain review sweep) -- a RESOLUTION: decompose sub-task proposal
// suggesting a FUTURE config name (e.g. "add AGENT_MANAGER_SECOND_BRAIN_REVIEW_PATH,
// following the pattern of X") got hard-blocked by the same ungrounded-field gate a real
// diff would, even though it never claims that name already exists anywhere.
test('reviewTask does NOT deterministically block a decompose proposal for suggesting a future config field name', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'decompose-field-test', domain: 'default', source: 'manual', adhocResolution: 'decompose',
    title: 'test', planResponse: 'plan',
    implementResponse: 'RESOLUTION: decompose\n\n[{"title": "Add config plumbing", "rawText": "Add a new path, e.g. AGENT_MANAGER_SECOND_BRAIN_REVIEW_PATH, following the pattern of existing paths in config.js."}]',
    promptContext: { body: 'Background material with no mention of that field at all.' },
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-ungrounded-value');
  assert.equal(result.verdict, 'approved');
  assert.equal(captured.length, 1, 'a decompose proposal must still reach a real review vote, not skip review entirely');
});

test('reviewTask does NOT deterministically block a candidateSplitProposals draft for suggesting a future config field name', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'split-field-test', domain: 'default', source: 'arch_review',
    candidateSplitProposals: [
      { title: 'Add config plumbing', problem: 'p', solution: 'Add a new path, e.g. AGENT_MANAGER_SECOND_BRAIN_REVIEW_PATH, following the pattern of existing paths in config.js.', benefits: 'b' },
      { title: 'Wire it in', problem: 'p2', solution: 's2', benefits: 'b2' },
    ],
    title: 'test', planResponse: 'plan',
    implementResponse: JSON.stringify({
      mode: 'split',
      candidates: [
        { title: 'Add config plumbing', problem: 'p', solution: 'Add a new path, e.g. AGENT_MANAGER_SECOND_BRAIN_REVIEW_PATH, following the pattern of existing paths in config.js.', benefits: 'b' },
        { title: 'Wire it in', problem: 'p2', solution: 's2', benefits: 'b2' },
      ],
    }),
    promptContext: { body: 'Background material with no mention of that field at all.' },
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.notEqual(task.reviewProvider, 'deterministic-ungrounded-value');
  assert.equal(result.verdict, 'approved');
  assert.equal(captured.length, 1, 'a split proposal must still reach a real review vote, not skip review entirely');
});

test('reviewTask STILL deterministically blocks a non-decompose manual task citing the same kind of ungrounded field', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'non-decompose-field-test', domain: 'default', source: 'manual',
    title: 'test', planResponse: 'plan',
    implementResponse: 'The response includes the AGENT_MANAGER_SECOND_BRAIN_REVIEW_PATH field for review output.',
    promptContext: { body: 'Background material with no mention of that field at all.' },
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-ungrounded-value');
  assert.equal(captured.length, 0, 'the exemption must be scoped to decompose only, not manual tasks in general');
});

// --- Deterministic script-extract review gate (2026-09-07, "Ghost in the Machine") ------
// Real incident: a script-extract decompose move's real implementResponse was 600,794
// chars (~200K tokens) against this pipeline's 16,384-token PINNED_NUM_CTX -- the
// reviewer never actually saw the real diff and hallucinated "the draft is empty, no
// IMPLEMENT diff." verifyDeterministicScriptExtractDraft re-derives the expected
// extraction fresh and requires an exact byte match instead of asking a model to skim
// something it structurally cannot fit in context.

// S4a of the hub-tasks extraction (2026-09-24): the byte-exact/tampered/drifted
// re-derivation tests that used to live here moved to script-extract.test.js -- they test
// the REGISTERED verify() function's actual extraction/byte-compare logic, which belongs
// with script-extract.js itself (still in this repo -- see its own header for why it did
// NOT move to agent-manager-hygiene with the rest of the file-decompose family), not this
// dispatcher's own test file. What remains here is only the kind-gate/shape-fallthrough
// behavior (still needing a real HTML fixture for the reviewTask() integration tests
// further down), which needs no real producer at all.
function writeHtmlWithFn(repoRoot, relPath, scriptBody) {
  const abs = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `<html><body>\n<script>\n${scriptBody}\n</script>\n</body></html>\n`);
}

test('verifyDeterministicScriptExtractDraft: returns null (not applicable) for an ordinary task', () => {
  const { verifyDeterministicScriptExtractDraft } = require('./review-task.js');
  assert.equal(verifyDeterministicScriptExtractDraft(baseTask(), '/tmp'), null);
});

// The real incident, 2026-09-07, Grimmethy ("review blocked the decompose task again --
// forensic analysis mode"): promptContext.deterministicApply describes TASK-level
// eligibility, set once and persisted -- it does NOT mean THIS attempt's implementResponse
// actually came from the deterministic short-circuit. That short-circuit already falls
// through to the NORMAL agentic drafting path (local-draft.js's own tryDeterministic
// ScriptExtractEdit, advisory-only) whenever ITS OWN re-derivation drifts -- so a
// deterministicApply task can perfectly legitimately carry a normal, non-JSON agentic
// implementResponse. Before this fix, every one of these branches returned {ok:false,
// reason}, which reviewTask's own caller treats identically to {ok:true} for "the gate
// applies" (only a literal null skips it) -- so a genuine agentic draft got hard-rejected
// with "implementResponse is not valid JSON" and zero real review of its actual content.
// Confirmed live against the real stuck task: exactly this happened (history shows
// "implement-started ... adhoc: local-agentic-write", a 108,459-char agentic transcript,
// rejected by this gate purely on shape).
test('verifyDeterministicScriptExtractDraft: a non-JSON agentic implementResponse on a deterministicApply task returns null (falls through to normal review), not a hard reject', () => {
  const task = {
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: 'Let me look at the file first.\n\n<read_file>...</read_file>\n\nHere is the diff:\n--- a/index.html\n+++ b/index.html\n',
  };
  const { verifyDeterministicScriptExtractDraft } = require('./review-task.js');
  assert.equal(verifyDeterministicScriptExtractDraft(task, '/tmp'), null);
});

test('verifyDeterministicScriptExtractDraft: valid JSON but the wrong array length falls through (null), not a hard reject', () => {
  const task = {
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([{ mode: 'create', file: 'a.js', content: 'x' }]), // only 1, not the required 2
  };
  const { verifyDeterministicScriptExtractDraft } = require('./review-task.js');
  assert.equal(verifyDeterministicScriptExtractDraft(task, '/tmp'), null);
});

test('verifyDeterministicScriptExtractDraft: valid 2-element JSON but the wrong change shape (not create+edit of the right files) falls through (null)', () => {
  const task = {
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([
      { mode: 'create', file: 'wrong-file.js', content: 'x' }, // file does not match ctx.newFile
      { mode: 'edit', file: 'index.html', find: 'x', replace: 'y' },
    ]),
  };
  const { verifyDeterministicScriptExtractDraft } = require('./review-task.js');
  assert.equal(verifyDeterministicScriptExtractDraft(task, '/tmp'), null);
});

// The "correctly-shaped JSON that byte-mismatches still hard-rejects" boundary case moved
// to script-extract.test.js with the rest of the byte-compare coverage (S4a, 2026-09-24)
// -- same reasoning as the block comment above.

// S4a of the hub-tasks extraction (2026-09-24): proves verifyDeterministicScriptExtractDraft
// dispatches through decompose-review-registry.js's live registry rather than calling a
// producer's logic inline -- an override changes the outcome with zero changes to
// review-task.js itself. This repo's own test process has no default 'script-extract'
// registration to restore (that lives in agent-manager-hygiene now), so clearing is
// simply the end state -- same discipline as decompose-review-registry.test.js's own
// clear test.
test('verifyDeterministicScriptExtractDraft honors an overridden "script-extract" registration', () => {
  const { registerDeterministicReview, clearDeterministicReviewRegistry } = require('./decompose-review-registry.js');
  const task = { promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] }, implementResponse: '[]' };
  registerDeterministicReview('script-extract', { verify: () => ({ ok: true, fromOverride: true }) });
  try {
    const { verifyDeterministicScriptExtractDraft } = require('./review-task.js');
    assert.deepEqual(verifyDeterministicScriptExtractDraft(task, '/tmp'), { ok: true, fromOverride: true });
  } finally {
    clearDeterministicReviewRegistry();
  }
});

// --- Deterministic ONE-PASS / node-module decompose review gate (2026-09-09) ------------
// A whole fully-mechanical file-decompose filed as ONE task ([[hub-task-integration]]):
// N `create` changes + one `edit`, re-derivable byte-for-byte, and a diff (index.html:
// ~370K chars) far larger than the review model's context. Caught live: the index.html
// one-pass draft was blocked twice by a reviewer misreading the reduced template as "a
// truncated fragment". The byte-exact/tampered-content coverage moved to
// agent-manager-hygiene/src/decompose-node-module.test.js with decompose-node-module.js
// itself (S4a, 2026-09-24, unlike script-extract.js -- see its own header for why that one
// stayed in this repo) -- same "moves with the producer" reasoning as script-extract's
// coverage above, just the other direction.

test('verifyDeterministicOnePassDecomposeDraft: not a decompose task -> null (falls through to normal review)', () => {
  const { verifyDeterministicOnePassDecomposeDraft } = require('./review-task.js');
  assert.equal(verifyDeterministicOnePassDecomposeDraft({ promptContext: { deterministicApply: 'script-extract' } }, '/tmp'), null);
  assert.equal(verifyDeterministicOnePassDecomposeDraft({ promptContext: {} }, '/tmp'), null);
  assert.equal(verifyDeterministicOnePassDecomposeDraft(
    { promptContext: { deterministicApply: 'one-pass-decompose', sourceFile: 'x.html', moves: [{ newFile: 'a.js', symbols: ['a'] }] }, implementResponse: 'Let me read the file first...' },
    '/tmp',
  ), null, 'a non-JSON agentic retry on the same task falls through, not a hard reject');
});

// These 4 reviewTask() integration tests exercise THIS file's own
// dispatch/short-circuit/groundingRef-threading behavior, not script-extract.js's actual
// byte-extraction logic (already covered directly by the dedicated
// verifyDeterministicScriptExtractDraft tests above and, end to end, by
// decompose-review-registry.js's own tests) -- so they register a trivial local fake
// 'script-extract' kind instead of building real HTML fixtures through buildExtraction.
// The fake only checks the edit's `find` against the actual file content (grounding-ref-
// aware, same as the real verify's own read path) -- sufficient to drive reviewTask's real
// approve/reject/zero-model-call/stacked-branch
// behavior without needing real symbol extraction, which is hygiene's job to verify now
// (see script-extract.test.js there).
function registerFakeScriptExtractReview() {
  const { registerDeterministicReview } = require('./decompose-review-registry.js');
  registerDeterministicReview('script-extract', {
    verify(task, repoRoot, groundingRef) {
      const ctx = task.promptContext;
      let parsed;
      try { parsed = JSON.parse(task.implementResponse); } catch { return null; }
      if (!Array.isArray(parsed) || parsed.length !== 2) return null;
      const [createChange, editChange] = parsed;
      if (!(createChange && createChange.mode === 'create' && createChange.file === ctx.newFile)) return null;
      if (!(editChange && editChange.mode === 'edit' && editChange.file === ctx.sourceFile)) return null;
      let actual;
      if (groundingRef) {
        const { readFileAtRef } = require('./stacked-grounding.js');
        actual = readFileAtRef(repoRoot, groundingRef, ctx.sourceFile);
      } else {
        try { actual = fs.readFileSync(path.join(repoRoot, ctx.sourceFile), 'utf8'); } catch (e) {
          return { ok: false, reason: `could not re-read ${ctx.sourceFile}: ${e.message}` };
        }
      }
      if (editChange.find !== actual) return { ok: false, reason: 'edit find does not byte-match current repo state (fake test verify)' };
      return { ok: true };
    },
  });
}

test('reviewTask auto-approves a script-extract move deterministically -- zero model calls, even though the diff is huge', async () => {
  registerFakeScriptExtractReview();
  const { repoRoot, domainsPath } = makeFixture();
  writeHtmlWithFn(repoRoot, 'index.html', 'function a() { return 1; }\nfunction b() { return 2; }\n');
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const task = {
    id: 'script-extract-review-1', domain: 'default', source: 'manual', title: 'test',
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([
      { mode: 'create', file: 'a.js', content: 'function a() { return 1; }\n' },
      { mode: 'edit', file: 'index.html', find: html, replace: '<html><body>\n<script>\nfunction b() { return 2; }\n</script>\n</body></html>\n' },
    ]),
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'approved');
  assert.equal(task.reviewProvider, 'deterministic-script-extract-approve');
  assert.equal(captured.length, 0, 'no model call at all -- this is exactly the class of diff too large for the review model\'s own context window');
});

test('reviewTask deterministically rejects a script-extract move whose diff no longer matches current repo state -- zero model calls', async () => {
  registerFakeScriptExtractReview();
  const { repoRoot, domainsPath } = makeFixture();
  writeHtmlWithFn(repoRoot, 'index.html', 'function somethingElseEntirely() {}\n');
  const task = {
    id: 'script-extract-review-2', domain: 'default', source: 'manual', title: 'test',
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([
      { mode: 'create', file: 'a.js', content: 'function a() {}\n' },
      { mode: 'edit', file: 'index.html', find: 'x', replace: 'y' },
    ]),
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-script-extract-reject');
  assert.equal(captured.length, 0);
});

// 2026-09-09, root-caused live (file-decompose-hub-autodecomp-adhoc-add-job-stage-
// groups-...): verifyDeterministicScriptExtractDraft used to always re-read the plain
// repoRoot working tree (main's content) to check a draft's byte-match -- for a stacked
// sub-task that meant re-deriving against the WRONG base (missing an earlier sibling
// move only committed to the shared, not-yet-merged stacked branch), so a draft built
// from that same wrong base "byte-matched" and got approved, then failed a real
// `git apply` once actually applied to the real branch.
function makeGitFixtureWithStackedSourceFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-task-stacked-script-extract-'));
  const bareDir = path.join(dir, 'origin.git');
  const repoRoot = path.join(dir, 'repo');
  execFileSync('git', ['init', '--bare', '-b', 'main', bareDir]);
  execFileSync('git', ['clone', bareDir, repoRoot]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  writeHtmlWithFn(repoRoot, 'index.html', 'function a() { return 1; }\n');
  execFileSync('git', ['add', 'index.html'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoRoot });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: repoRoot });

  execFileSync('git', ['checkout', '-b', 'agent/stacked-script-extract'], { cwd: repoRoot });
  writeHtmlWithFn(repoRoot, 'index.html', 'function a() { return 1; }\nfunction siblingAlreadyMoved() { return 2; }\n');
  execFileSync('git', ['add', 'index.html'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'sibling move already landed here'], { cwd: repoRoot });
  execFileSync('git', ['push', 'origin', 'agent/stacked-script-extract'], { cwd: repoRoot });
  execFileSync('git', ['checkout', 'main'], { cwd: repoRoot });

  const domainsPath = path.join(dir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  return { repoRoot, domainsPath };
}

test('reviewTask auto-approves a stacked script-extract move derived from the shared stacked branch, not main', async () => {
  registerFakeScriptExtractReview();
  const { repoRoot, domainsPath } = makeGitFixtureWithStackedSourceFile();
  const { execFileSync: exec2 } = require('child_process');
  const stackedHtml = exec2('git', ['show', 'origin/agent/stacked-script-extract:index.html'], { cwd: repoRoot, encoding: 'utf8' });
  const task = {
    id: 'script-extract-stacked-review-1', domain: 'default', source: 'manual', title: 'test',
    stacked: { branch: 'agent/stacked-script-extract', seq: 2, total: 3 },
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([
      { mode: 'create', file: 'a.js', content: 'function a() { return 1; }\n' },
      { mode: 'edit', file: 'index.html', find: stackedHtml, replace: '<html><body>\n<script>\nfunction siblingAlreadyMoved() { return 2; }\n</script>\n</body></html>\n' },
    ]),
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'approved');
  assert.equal(task.reviewProvider, 'deterministic-script-extract-approve');
  assert.equal(captured.length, 0);
});

test('reviewTask rejects a stacked script-extract move derived from MAIN instead of the shared stacked branch (the exact bug this closes)', async () => {
  registerFakeScriptExtractReview();
  const { repoRoot, domainsPath } = makeGitFixtureWithStackedSourceFile();
  const mainHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8'); // main's content -- missing the sibling move
  const task = {
    id: 'script-extract-stacked-review-2', domain: 'default', source: 'manual', title: 'test',
    stacked: { branch: 'agent/stacked-script-extract', seq: 2, total: 3 },
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([
      { mode: 'create', file: 'a.js', content: 'function a() { return 1; }\n' },
      { mode: 'edit', file: 'index.html', find: mainHtml, replace: '<html><body></body></html>\n' },
    ]),
  };
  const captured = [];
  const result = await reviewTask(task, {
    repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(task.reviewProvider, 'deterministic-script-extract-reject');
});

// Inconclusive-vote outcomes (review-task.js decideInconclusiveOutcome, line ~926): an
// adhoc-resolving source (source:'manual') PASSES THROUGH with a caveat -- verdict
// 'approved', reviewProvider 'local', localVotes recorded -- while every other source
// BLOCKS with "Local-model review inconclusive, no confident majority (...)". Note there
// is NO literal 'inconclusive' verdict in review-task.js; 'approved' (pass-with-caveat)
// is adhoc's real outcome.
//
// arch_import lives in the out-of-tree agent-manager-hygiene plugin (like
// observability_review/performance_review above), so ./task-sources.js doesn't register
// it here. Stub it (only if unregistered) so the inconclusive-block test below resolves
// the source the same way production (plugin loaded) does.
{
  const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  if (!getRegisteredSource('arch_import')) {
    registerTaskSource('arch_import', { priority: 80, next: () => null, apply: () => ({ skipped: true }) });
  }
}

const inconclusiveVote = () => async () => ({
  confident: false,
  verdict: null,
  votes: [
    { verdict: 'UNSURE', response: 'unsure' },
    { verdict: 'UNSURE', response: 'unsure' },
    { verdict: 'UNSURE', response: 'unsure' },
  ],
  realVoteCount: 3,
  requestedVotes: 3,
});

// Plain prose >80 chars, no NON_IMPL_PATTERNS hits, no backticks -- clears the
// deterministic non-implementation gate so the (faked) majority vote is actually reached.
const inconclusiveProse = 'This change refactors the review pipeline to separate the voting logic from the verdict assembly, making each stage independently testable and easier to reason about in isolation.';

test('reviewTask passes an inconclusive local vote through for an adhoc (manual) task -- approved with a caveat, not blocked', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const task = baseTask({
    source: 'manual',
    implementResponse: inconclusiveProse,
  });
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: inconclusiveVote(),
    recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'approved');
  assert.equal(task.reviewProvider, 'local');
  assert.ok(Array.isArray(task.localVotes));
});

test('reviewTask BLOCKS an inconclusive local vote for a non-adhoc source (arch_import) with a specific reason', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  const task = baseTask({
    source: 'arch_import',
    implementResponse: inconclusiveProse,
  });
  const result = await reviewTask(task, {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: inconclusiveVote(),
    recordModelOutcome: () => {},
  });
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blockedStage, 'review');
  assert.match(result.blockedReason, /Local-model review inconclusive, no confident majority/);
});

// --- empty-implement outcome via the shared decideEmptyApprovalOutcome (2026-09-10) ------
// Replaces the old AGENT_MANAGER_DEEP_DIVE_EMPTY_APPROVE_FAIL kill-switch flip; the same
// module is called by review-runner.ps1's CLI so the two runtimes cannot drift.

test('empty deep_dive draft + ZERO harness hits -> deterministic block, no reviewer vote', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'empty-zero-hit', domain: 'default', source: 'deep_dive',
    title: 'Deep dive: test', planResponse: 'QUERY: x',
    implementResponse: '',
    promptContext: { harnessHits: [] },
  };
  const captured = [];
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured) });
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blockedStage, 'review');
  assert.equal(task.reviewProvider, 'deterministic-empty-fail');
  assert.match(result.blockedReason, /zero hits/i);
  assert.equal(captured.length, 0, 'no reviewer vote spent on a mechanically-decidable empty+zero-hit outcome');
});

test('empty deep_dive draft + real harness hits -> deterministic approve, no reviewer vote', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'empty-with-hits', domain: 'default', source: 'deep_dive',
    title: 'Deep dive: test', planResponse: 'QUERY: x',
    implementResponse: '',
    promptContext: { harnessHits: [{ file: 'a.py' }, { file: 'b.py' }] },
  };
  const captured = [];
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured) });
  assert.equal(result.verdict, 'approved');
  assert.equal(task.reviewProvider, 'deterministic-empty-approve');
  assert.equal(captured.length, 0);
});

// 2026-09-19: arch_discovery-shaped (emptyApproval + candidateDocFormat) -- its material is
// promptContext.files, not a search. Fixture mirrors the real registration in agent-manager-hygiene.
{
  const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  if (!getRegisteredSource('fixture_arch_discovery_like')) {
    registerTaskSource('fixture_arch_discovery_like', { priority: 80, next: () => null, emptyApproval: true, candidateDocFormat: true });
  }
}

test('arch_discovery-shaped: an EMPTY draft with real files in context -> deterministic approve (clean community), no vote', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'ad-empty-with-files', domain: 'default', source: 'fixture_arch_discovery_like',
    title: 'Architecture discovery: x', planResponse: '0 friction points', implementResponse: '',
    promptContext: { files: [{ path: 'src/a.ts', degree: 3, content: 'x' }] },
  };
  const captured = [];
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured) });
  assert.equal(result.verdict, 'approved');
  assert.equal(task.reviewProvider, 'deterministic-empty-approve');
  assert.equal(captured.length, 0);
});

test('arch_discovery-shaped: ZERO files in context -> deterministic block-no-context, even for a NON-empty draft, no vote', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  for (const implementResponse of ['', '### AC-001 · Invented\nStrength: Strong\nFiles: src/x.js\n\nProblem: p\nSolution: s\nBenefits: b']) {
    const task = {
      id: 'ad-no-files-' + implementResponse.length, domain: 'default', source: 'fixture_arch_discovery_like',
      title: 'Architecture discovery: y', planResponse: 'p', implementResponse,
      promptContext: { files: [] },
    };
    const captured = [];
    const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured) });
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.blockedStage, 'review');
    assert.equal(task.reviewProvider, 'deterministic-no-context-fail');
    assert.match(result.blockedReason, /^Deterministic gate: fixture_arch_discovery_like was given no source files/);
    assert.equal(captured.length, 0, 'no reviewer vote spent on a draft the model wrote without seeing any code');
  }
});

test('empty draft for a NON-emptyApproval source is unaffected (falls through, not auto-decided here)', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'empty-adhoc', domain: 'default', source: 'trouble_log',
    title: 'x', planResponse: 'p', implementResponse: '',
    promptContext: { harnessHits: [] },
  };
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove([]) });
  assert.notEqual(task.reviewProvider, 'deterministic-empty-fail');
  assert.notEqual(task.reviewProvider, 'deterministic-empty-approve');
});

// --- FALSE POSITIVE premise re-check (2026-09-18, premise-recheck-decision.js) -----------
// A candidate-fulfillment "_fix" task's FALSE POSITIVE refusal used to fall straight into
// the isNonImplementation gate below (short, no code fence) and get rejected exactly like
// a bad draft -- even when the refusal is correct. See premise-recheck-decision.js's own
// header for the full incident (brain-dump bd-1789602379616).

test('FALSE POSITIVE refusal + the original scanner rule finds nothing in the current file -> deterministic approve, no reviewer vote', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  fs.writeFileSync(path.join(repoRoot, 'a.js'), 'function f() { return 1; }\n'); // clean -- no BUG marker
  const task = {
    id: 'fp-resolved', domain: 'default', source: 'fixture_premise_recheck_fix',
    title: 'x', planResponse: 'p',
    implementResponse: 'FALSE POSITIVE -- the flagged issue no longer exists in the real file.',
    promptContext: { files: ['a.js'] },
  };
  const captured = [];
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured) });
  assert.equal(result.verdict, 'approved');
  assert.equal(task.reviewProvider, 'deterministic-premise-recheck-approve');
  assert.equal(captured.length, 0, 'no reviewer vote spent on a mechanically-verified false-positive refusal');
});

test('FALSE POSITIVE refusal + the original scanner rule still finds it in the current file -> falls through, not auto-approved', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  fs.writeFileSync(path.join(repoRoot, 'a.js'), '// BUG: still here\nfunction f() { return 1; }\n');
  const task = {
    id: 'fp-still-live', domain: 'default', source: 'fixture_premise_recheck_fix',
    title: 'x', planResponse: 'p',
    implementResponse: 'FALSE POSITIVE -- the flagged issue no longer exists in the real file.',
    promptContext: { files: ['a.js'] },
  };
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove([]) });
  assert.notEqual(task.reviewProvider, 'deterministic-premise-recheck-approve');
});

test('FALSE POSITIVE refusal for a source with no premiseRecheckSource opt-in is unaffected', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = {
    id: 'fp-no-optin', domain: 'default', source: 'trouble_log',
    title: 'x', planResponse: 'p',
    implementResponse: 'FALSE POSITIVE -- nothing to do here.',
    promptContext: { files: ['a.js'] },
  };
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove([]) });
  assert.notEqual(task.reviewProvider, 'deterministic-premise-recheck-approve');
});

// renderImplementResponseForReview (2026-09-13, screaminggoatclubmt investigation,
// pipeline-forensics-fix-ac-24) -----------------------------------------------------------
// Root-caused live: a Group B draft ([{mode:'edit',...},{mode:'create',...}]) that
// genuinely included a correct edit AND a real, substantial new test file was rejected
// TWICE by the local reviewer with "the draft omits the acceptance test" -- the test file's
// full content really was in the prompt, but buried as an escaped substring inside one
// unbroken compact-JSON line (real newlines shown as literal backslash-n) that the
// quantized local reviewer failed to parse/attend to.

test('renderImplementResponseForReview: a Group B edit+create array is rendered as labeled sections with real newlines', () => {
  const implementResponse = JSON.stringify([
    { mode: 'edit', file: 'src/blocked-drain.js', find: 'const isDesignDecision = x;', replace: 'const isDesignDecision = y;' },
    { mode: 'create', file: 'test/ac-24-duplicate-flag-acceptance.js', content: "assert.strictEqual(after.status, 'pending');\nconsole.log('PASS positive');" },
  ]);
  const rendered = renderImplementResponseForReview(implementResponse);
  // Real newlines, not the escaped `\n` two-character sequence JSON.stringify produced.
  assert.ok(rendered.includes('\n'));
  assert.ok(!rendered.includes('\\n'));
  assert.match(rendered, /--- EDIT: src\/blocked-drain\.js ---/);
  assert.match(rendered, /--- NEW FILE: test\/ac-24-duplicate-flag-acceptance\.js ---/);
  // The exact regression: the test file's real content must be present and legible.
  assert.ok(rendered.includes("assert.strictEqual(after.status, 'pending');"));
  assert.ok(rendered.includes("console.log('PASS positive');"));
});

test('renderImplementResponseForReview: a lone edit op (no array wrapper) still gets a legible label', () => {
  const implementResponse = JSON.stringify({ mode: 'edit', file: 'a.js', find: 'x', replace: 'y' });
  const rendered = renderImplementResponseForReview(implementResponse);
  assert.match(rendered, /--- EDIT: a\.js ---/);
  assert.match(rendered, /FIND:\nx/);
  assert.match(rendered, /REPLACE:\ny/);
});

test('renderImplementResponseForReview: a lone create op (no array wrapper) still gets a legible label', () => {
  const implementResponse = JSON.stringify({ mode: 'create', file: 'new.js', content: 'module.exports = {};' });
  const rendered = renderImplementResponseForReview(implementResponse);
  assert.match(rendered, /--- NEW FILE: new\.js ---/);
  assert.ok(rendered.includes('module.exports = {};'));
});

test('renderImplementResponseForReview: non-Group-B free text (e.g. a local-agentic-write transcript) passes through unchanged', () => {
  const implementResponse = 'Investigated and the real bug was in bar.js, not foo.js.\n\n=== DIFF ===\ndiff --git a/bar.js b/bar.js\nRESOLUTION: implemented';
  assert.equal(renderImplementResponseForReview(implementResponse), implementResponse);
});

test('renderImplementResponseForReview: a split-proposal array (title/rawText shape, not Group B) passes through unchanged', () => {
  const implementResponse = JSON.stringify([{ title: 'Add config plumbing', rawText: 'do the thing' }]);
  assert.equal(renderImplementResponseForReview(implementResponse), implementResponse);
});

test('renderImplementResponseForReview: malformed JSON is returned unchanged, never throws', () => {
  const implementResponse = 'not valid json {[';
  assert.equal(renderImplementResponseForReview(implementResponse), implementResponse);
});

test('renderImplementResponseForReview: an empty array passes through unchanged', () => {
  assert.equal(renderImplementResponseForReview('[]'), '[]');
});

test('buildVerdictPrompt renders a Group B implementResponse through the legible formatter, not as raw escaped JSON', () => {
  const implementResponse = JSON.stringify([
    { mode: 'edit', file: 'src/blocked-drain.js', find: 'old', replace: 'new' },
    { mode: 'create', file: 'test/x.test.js', content: "it('works', () => { assert.ok(true); });" },
  ]);
  const task = baseTask({ implementResponse });
  const prompt = buildVerdictPrompt(task, { flags: [] }, '');
  assert.match(prompt, /--- NEW FILE: test\/x\.test\.js ---/);
  assert.ok(prompt.includes("it('works', () => { assert.ok(true); });"));
  // The old raw-string behavior would have put the whole implementResponse on one line
  // inside the "--- IMPLEMENT draft ---" section with literal backslash-n sequences.
  assert.ok(!prompt.includes(implementResponse));
});

test('reviewTask puts a deterministic SCOPE CHECK in the vote prompt when the diff changes a file nothing mentions (2026-09-19: a sandbox npm install rewrote package-lock.json)', async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const rawDiff = ['diff --git a/src/App.tsx b/src/App.tsx', '--- a/src/App.tsx', '+++ b/src/App.tsx', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/package-lock.json b/package-lock.json', '--- a/package-lock.json', '+++ b/package-lock.json', '@@ -1 +1 @@', '-x', '+y', ''].join('\n');
  const task = baseTask({
    domain: 'default', source: 'manual', adhocResolution: 'implemented', title: 'startTour leaks a timer',
    promptContext: { rawText: 'In src/App.tsx the timeout id is discarded.' },
    implementResponse: 'Implemented the fix in src/App.tsx: startTour now stores its timeout id in a ref and clears any pending one before scheduling a new one, and an unmount cleanup effect clears it. RESOLUTION: implemented', rawDiff,
  });
  const captured = [];
  const res = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {} });
  assert.equal(captured.length, 1, `the vote must be reached: ${JSON.stringify(res).slice(0, 300)}`);
  const prompt = JSON.stringify(captured[0] || '');
  assert.match(prompt, /SCOPE CHECK \(deterministic\)/);
  assert.match(prompt, /package-lock\.json/);
  assert.doesNotMatch(prompt.replace(/diff --git[^"]*/g, ''), /file\(s\) that NEITHER[^.]*App\.tsx/, 'a mentioned file is not listed as unnamed');
});


// --- executed verification gate (review-verify.js wired into runReview, slice 2b) -------------------------------------------------------
function withExecutedVerify(fn) {
  return async () => {
    process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'true';
    try { await fn(); } finally { process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false'; }
  };
}

function adhocImplementedTask(overrides = {}) {
  return baseTask({
    domain: 'default', source: 'manual', adhocResolution: 'implemented',
    acceptanceCriteria: ['the helper works'],
    acceptanceResults: [{ criterion: 'the helper works', check: '`node --test src/a.test.js`', result: 'PASS', pass: true }],
    rawDiff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n',
    ...overrides,
  });
}

test('executed verification: a genuinely failed check blocks before any vote, names what failed, and is recorded on the task', withExecutedVerify(async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = adhocImplementedTask();
  const captured = [];
  const fake = () => ({
    status: 'failed', reasons: ['covering js tests failed'],
    tests: { ran: ['src/a.test.js'], passed: false, failures: ['the helper adds', 'the helper subtracts'], raw: 'not ok 1 - the helper adds\nAssertionError: 3 !== 4' },
    commands: [{ criterion: 'the helper works', command: 'node --test src/a.test.js', claimedPass: true, outcome: 'contradicted', exitCode: 1, detail: 'AssertionError' }],
  });
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {}, verifyDiffFn: fake });
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blockedStage, 'review');
  assert.equal(task.reviewProvider, 'deterministic-executed-verification');
  assert.match(result.blockedReason, /executed verification failed/);
  assert.match(result.blockedReason, /src\/a\.test\.js/);
  assert.match(result.blockedReason, /the helper adds; the helper subtracts/);
  assert.match(result.blockedReason, /claimed PASS for `node --test src\/a\.test\.js` but it exits 1/);
  assert.equal(captured.length, 0, 'no vote is spent on a draft whose own tests fail');
  assert.equal(task.executedVerification.status, 'failed');
  assert.deepEqual(task.executedVerification.tests.failures, ['the helper adds', 'the helper subtracts']);
  assert.equal(task.executedVerification.commands[0].outcome, 'contradicted');
  const stages = task.history.map((h) => h.stage);
  assert.ok(stages.includes('advisory') && stages.includes('blocked'));
}));

test('executed verification: passed and inconclusive both go on to the vote, with the result recorded', withExecutedVerify(async () => {
  for (const [status, reasons] of [['passed', []], ['inconclusive', ['the diff does not apply to main (often a slice that depends on an unmerged earlier one): x']]]) {
    const { repoRoot, domainsPath } = makeFixture();
    const task = adhocImplementedTask({ id: `ev-${status}` });
    const captured = [];
    await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {},
      verifyDiffFn: () => ({ status, reasons, tests: status === 'passed' ? { ran: ['src/a.test.js'], passed: true, failures: [] } : null, commands: [] }) });
    assert.notEqual(task.reviewProvider, 'deterministic-executed-verification', status);
    assert.equal(captured.length, 1, `${status} must reach the vote`);
    assert.equal(task.executedVerification.status, status);
    const note = task.history.find((h) => h.stage === 'advisory' && /executed verification/.test(h.detail || ''));
    assert.ok(note, `${status} leaves an advisory history event`);
    if (status === 'inconclusive') assert.match(note.detail, /does not apply/);
  }
}));

test('executed verification: a verifier that throws never blocks and never breaks the review', withExecutedVerify(async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = adhocImplementedTask();
  const captured = [];
  const origErr = console.error; console.error = () => {};
  try {
    await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {}, verifyDiffFn: () => { throw new Error('bwrap exploded'); } });
  } finally { console.error = origErr; }
  assert.notEqual(task.reviewProvider, 'deterministic-executed-verification');
  assert.equal(captured.length, 1);
  assert.equal(task.executedVerification, undefined);
}));

test('executed verification: the kill switch, a non-adhoc source, an unimplemented draft and a missing rawDiff each skip the verifier entirely', async () => {
  const cases = [
    ['kill switch', { env: 'false', task: {} }],
    ['not adhoc', { env: 'true', task: { domain: 'default', source: 'trouble_log' } }],
    ['not implemented', { env: 'true', task: { adhocResolution: 'needs-human-decision' } }],
    ['no rawDiff', { env: 'true', task: { rawDiff: '' } }],
  ];
  for (const [label, { env, task: overrides }] of cases) {
    const { repoRoot, domainsPath } = makeFixture();
    const calls = [];
    process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = env;
    try {
      await reviewTask(adhocImplementedTask({ id: `skip-${label.replace(/ /g, '-')}`, ...overrides }), {
        repoRoot, domainsPath, localMajorityVote: fakeApprove([]), recordModelOutcome: () => {}, verifyDiffFn: (a) => { calls.push(a); return { status: 'passed', reasons: [], tests: null, commands: [] }; } });
    } finally { process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false'; }
    assert.equal(calls.length, 0, `${label}: the verifier must not run`);
  }
});

test('executed verification: the verifier is handed the task id, raw diff, claimed results, repo root, base branch and budget', withExecutedVerify(async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = adhocImplementedTask({ id: 'ev-args' });
  let seen = null;
  process.env.AGENT_MANAGER_REVIEW_VERIFY_BUDGET_MS = '12345';
  try {
    await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove([]), recordModelOutcome: () => {},
      verifyDiffFn: (a) => { seen = a; return { status: 'passed', reasons: [], tests: null, commands: [] }; } });
  } finally { delete process.env.AGENT_MANAGER_REVIEW_VERIFY_BUDGET_MS; }
  assert.equal(seen.taskId, 'ev-args');
  assert.equal(seen.rawDiff, task.rawDiff);
  assert.equal(seen.acceptanceResults, task.acceptanceResults);
  assert.equal(seen.repoRoot, repoRoot);
  assert.equal(seen.mainBranch, 'main', 'a non-git fixture falls back to the literal main, the same way the apply stage does');
  assert.equal(seen.budgetMs, 12345);
}));

test('summariseExecutedVerification keeps the record small and executedVerificationBlockReason ends with the output tail', () => {
  const { summariseExecutedVerification, executedVerificationBlockReason } = require('./review-task.js');
  const ev = {
    status: 'failed', reasons: Array.from({ length: 9 }, (_, i) => `r${i}`),
    tests: { ran: ['a.test.js'], passed: false, failures: Array.from({ length: 15 }, (_, i) => `t${i}`), raw: 'x'.repeat(5000) + 'THE-END' },
    commands: [{ criterion: 'c'.repeat(400), command: 'node --test a.test.js', claimedPass: true, outcome: 'contradicted', exitCode: 1, detail: 'd'.repeat(3000) }],
  };
  const s = summariseExecutedVerification(ev);
  assert.equal(s.reasons.length, 6);
  assert.equal(s.tests.failures.length, 10);
  assert.equal(s.commands[0].criterion.length, 160);
  assert.equal('raw' in s.tests, false);
  assert.equal('detail' in s.commands[0], false);
  const reason = executedVerificationBlockReason(ev);
  assert.match(reason, /THE-END/);
  assert.ok(reason.length < 1600);
});

test('executed verification: a stacked hub sub-task is verified against its shared branch, not master (real git remote)', withExecutedVerify(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-task-stacked-'));
  const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const origin = path.join(dir, 'origin.git');
    const work = path.join(dir, 'repo');
    git(['init', '--bare', '-b', 'main', origin], dir);
    git(['clone', origin, work], dir);
    git(['checkout', '-b', 'main'], work);
    fs.writeFileSync(path.join(work, 'f.txt'), 'base\n');
    git(['add', '-A'], work); git(['commit', '-m', 'base'], work); git(['push', 'origin', 'main'], work);
    git(['checkout', '-b', 'agent/decompose-hub-x'], work);
    fs.writeFileSync(path.join(work, 'g.txt'), 'sibling work\n');
    git(['add', '-A'], work); git(['commit', '-m', 'sibling'], work); git(['push', 'origin', 'agent/decompose-hub-x'], work);
    git(['checkout', 'main'], work);
    const domainsPath = path.join(dir, 'task-domains.json');
    fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
    const stacked = adhocImplementedTask({ id: 'ev-stacked', stacked: { branch: 'agent/decompose-hub-x', seq: 2, total: 2 } });
    const plain = adhocImplementedTask({ id: 'ev-plain' });
    const seen = {};
    for (const [key, t] of [['stacked', stacked], ['plain', plain]]) {
      await reviewTask(t, { repoRoot: work, domainsPath, localMajorityVote: fakeApprove([]), recordModelOutcome: () => {},
        verifyDiffFn: (a) => { seen[key] = a.mainBranch; return { status: 'passed', reasons: [], tests: null, commands: [] }; } });
    }
    assert.equal(seen.stacked, 'agent/decompose-hub-x');
    assert.equal(seen.plain, 'main');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}));

test('summariseExecutedVerification carries the failures that already exist on the base ("preexisting"), capped, and omits the key when there are none', () => {
  const { summariseExecutedVerification } = require('./review-task.js');
  const withPre = summariseExecutedVerification({ status: 'inconclusive', reasons: ['x'], tests: { ran: ['a.test.js'], passed: null, failures: [], preexisting: Array.from({ length: 14 }, (_, i) => `p${i}`) }, commands: [] });
  assert.equal(withPre.tests.preexisting.length, 10);
  assert.equal(withPre.tests.passed, null);
  const without = summariseExecutedVerification({ status: 'passed', reasons: [], tests: { ran: ['a.test.js'], passed: true, failures: [] }, commands: [] });
  assert.equal('preexisting' in without.tests, false);
});


// --- the voters see the executed-verification result (brain dump #1647 step 2) --------------------------------------------------------------
const EV_PASSED = {
  status: 'passed', reasons: [],
  tests: { ran: ['python/dashboard/test_thing.py', 'src/a.test.js'], passed: true, failures: [] },
  commands: [{ criterion: 'c', command: 'python3 -m unittest python.dashboard.test_thing', claimedPass: true, outcome: 'confirmed', exitCode: 0 },
    { criterion: 'd', command: 'python3 -m unittest test_x', claimedPass: true, outcome: 'skipped' }],
};

test('the voter prompt carries the executed-verification section, right after the fact-check JSON and before the judging instructions', () => {
  const { buildVerdictPrompt, formatExecutedVerificationSection } = require('./review-task.js');
  const prompt = buildVerdictPrompt({ ...baseTask(), executedVerification: EV_PASSED }, { flags: [], marker: 'FACTCHECK-JSON' }, 'GROUNDING-SOURCE');
  const section = formatExecutedVerificationSection(EV_PASSED);
  assert.match(prompt, /--- Executed verification \(GROUND TRUTH: the review harness ran this itself; the drafter did not\) ---/);
  assert.match(prompt, /Result: PASSED\./);
  assert.match(prompt, /Covering test files run \(2\): python\/dashboard\/test_thing\.py, src\/a\.test\.js -- all PASSED\./);
  assert.match(prompt, /re-ran and CONFIRMED \(they exited 0\): `python3 -m unittest python\.dashboard\.test_thing`/);
  assert.match(prompt, /1 claimed check\(s\) could not be re-run from the repo root/);
  assert.ok(prompt.indexOf('FACTCHECK-JSON') < prompt.indexOf(section), 'after the fact-check JSON');
  assert.ok(prompt.indexOf(section) < prompt.indexOf('GROUNDING-SOURCE'), 'before the grounding source');
  assert.ok(prompt.indexOf(section) < prompt.indexOf('Judge whether this draft is correct'), 'before the judging instructions');
});

test('the executed-verification rules limit what a pass proves and say what INCONCLUSIVE is, and tell voters a diff-created file is not missing', () => {
  const { formatExecutedVerificationSection } = require('./review-task.js');
  const section = formatExecutedVerificationSection(EV_PASSED);
  assert.match(section, /PASSED means ONLY that the listed tests passed and the listed commands exited 0/);
  assert.match(section, /says nothing about whether the diff does what the TASK asked, stays in scope, or meets every requirement/);
  assert.match(section, /INCONCLUSIVE is neither a pass nor a failure/);
  assert.match(section, /do not reject a draft because a file IT CREATES is missing from the live repo/);
  assert.match(section, /Do not re-litigate a confirmed check or call its reported result fabricated/);
});

test('an inconclusive result names why and lists the tests that already fail on the base, without calling anything passed', () => {
  const { formatExecutedVerificationSection } = require('./review-task.js');
  const section = formatExecutedVerificationSection({
    status: 'inconclusive', reasons: ['covering py tests already fail on master in the review sandbox, so the failure is not caused by the diff', 'second reason', 'third reason'],
    tests: { ran: ['python/dashboard/test_start_pipeline_apply_root.py'], passed: null, failures: [], preexisting: ['test_registry_upsert_preserves_apply_root'] }, commands: [],
  });
  assert.match(section, /Result: INCONCLUSIVE\./);
  assert.match(section, /-- no clean result\./);
  assert.match(section, /ALREADY fail on the base branch in this sandbox \(not caused by the diff, so not counted against it\): test_registry_upsert_preserves_apply_root/);
  assert.match(section, /Why it is inconclusive: covering py tests already fail on master.*, second reason \(\+1 more\)\./);
  assert.doesNotMatch(section, /third reason/, 'at most two reasons are quoted; the rest is counted');
  assert.doesNotMatch(section, /all PASSED/);
});

test('with no executed-verification result the prompt is exactly what it was before: no section, no rules', () => {
  const { buildVerdictPrompt, formatExecutedVerificationSection } = require('./review-task.js');
  const plain = buildVerdictPrompt(baseTask(), { flags: [] }, 'G');
  assert.doesNotMatch(plain, /Executed verification/);
  const withEv = buildVerdictPrompt({ ...baseTask(), executedVerification: EV_PASSED }, { flags: [] }, 'G');
  assert.equal(withEv.replace(`${formatExecutedVerificationSection(EV_PASSED)}\n\n`, ''), plain, 'the section is the ONLY difference');
  for (const junk of [undefined, null, {}, { status: 'weird' }, 'passed', 42]) assert.equal(formatExecutedVerificationSection(junk), '', String(junk));
});

test('the section stays small: file, test-name and reason lists are capped', () => {
  const { formatExecutedVerificationSection } = require('./review-task.js');
  const section = formatExecutedVerificationSection({
    status: 'failed', reasons: [], commands: [],
    tests: { ran: Array.from({ length: 20 }, (_, i) => `t${i}.test.js`), passed: false, failures: Array.from({ length: 12 }, (_, i) => `failing test ${i}`), preexisting: [] },
  });
  assert.match(section, /Covering test files run \(20\): t0\.test\.js.*t7\.test\.js \(\+12 more\) -- FAILED\./);
  assert.match(section, /Failing tests the diff introduced: failing test 0.*failing test 5 \(\+6 more\)\./);
  assert.ok(section.length < 2200, `section is ${section.length} chars`);
});

test('end to end: a recorded executed-verification result reaches the prompt the voters are actually given, and the kill switch removes it', async () => {
  for (const [env, expectSection] of [['true', true], ['false', false]]) {
    const { repoRoot, domainsPath } = makeFixture();
    const task = adhocImplementedTask({ id: `ev-prompt-${env}` });
    const captured = [];
    process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = env;
    try {
      await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {}, verifyDiffFn: () => ({ status: 'passed', reasons: [], tests: { ran: ['src/a.test.js'], passed: true, failures: [] }, commands: [] }) });
    } finally { process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false'; }
    assert.equal(captured.length, 1);
    assert.equal(/--- Executed verification \(GROUND TRUTH/.test(captured[0]), expectSection, `env=${env}`);
    if (expectSection) assert.match(captured[0], /Covering test files run \(1\): src\/a\.test\.js -- all PASSED\./);
  }
});


// --- replay of the session's false rejections through the REAL engines (brain dump #1647 step 3) -----------------------------------------
// Everything above stubs verifyDiffFn or the fact-checker. These tests stub only the vote: the real fact-checker, the real
// executed-verification engine (bwrap sandbox, scratch worktree of a real git remote) and the real prompt builder all run, so a break in the
// wiring between them -- which is exactly what produced HUB0068-02's false rejection -- fails here instead of in production.
const HAS_BWRAP = (() => { try { execFileSync('bwrap', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function withReplayRepo(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-replay-'));
  const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const origin = path.join(dir, 'origin.git');
    const work = path.join(dir, 'repo');
    git(['init', '--bare', '-b', 'main', origin], dir);
    git(['clone', origin, work], dir);
    git(['checkout', '-b', 'main'], work);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), body);
    }
    git(['add', '-A'], work); git(['commit', '-m', 'base'], work); git(['push', 'origin', 'main'], work);
    const domainsPath = path.join(dir, 'task-domains.json');
    fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
    return fn({ work, domainsPath });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const REPLAY_TEST_SRC = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('./a.js');\ntest('add', () => { assert.equal(add(1, 2), 3); });\n";

function newFileDiff(rel, content) {
  const lines = content.split('\n').slice(0, -1);
  return `diff --git a/${rel} b/${rel}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
}

function replayTask(id, rawDiff, check) {
  return adhocImplementedTask({
    id, title: 'replay', rawDiff,
    acceptanceResults: [{ criterion: 'the new test passes', check: `\`${check}\``, result: 'PASS', pass: true }],
    implementResponse: `Added the change.\n\nAcceptance:\n1. the new test passes -- \`${check}\` -- PASS\n\n=== DIFF ===\n${rawDiff}`,
  });
}

async function runReplay(task, work, domainsPath) {
  const captured = [];
  process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'true';
  try {
    await reviewTask(task, { repoRoot: work, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {} });
  } finally { process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false'; }
  return captured;
}

// Replay of HUB0068-02: a diff whose only content is a NEW test file. The voters called the new path fabricated ("does not exist") and
// doubted the acceptance result, because nothing told them the file is created by the diff or that the harness had run it.
test('replay: a diff that creates a new passing test file is seen by the voters as a create target whose claimed command the harness CONFIRMED', { skip: !HAS_BWRAP && 'bwrap unavailable' }, async () => {
  await withReplayRepo({ 'src/a.js': 'module.exports = { add: (x, y) => x + y };\n' }, async ({ work, domainsPath }) => {
    const task = replayTask('replay-create', newFileDiff('src/a.test.js', REPLAY_TEST_SRC), 'node --test src/a.test.js');
    const captured = await runReplay(task, work, domainsPath);
    assert.equal(captured.length, 1, 'a passing change must reach the vote');
    assert.equal(task.executedVerification.status, 'passed');
    const prompt = captured[0];
    assert.match(prompt, /"claimedPath":"src\/a\.test\.js","exists":false,"resolvedPath":null,"resolvedVia":null,"isCreateTarget":true/);
    assert.match(prompt, /Result: PASSED\./);
    assert.match(prompt, /Covering test files run \(1\): src\/a\.test\.js -- all PASSED\./);
    assert.match(prompt, /re-ran and CONFIRMED \(they exited 0\): `node --test src\/a\.test\.js`/);
    assert.ok(!task.executedVerification.commands.some((c) => c.outcome !== 'confirmed'));
  });
});

// A path the diff only MODIFIES (never creates) and that is not on the base is still flagged: the create-target fix must not turn
// every missing path into a pass.
test('replay: a path the diff modifies but the base does not contain is still flagged missing-file, and nothing is called PASSED', { skip: !HAS_BWRAP && 'bwrap unavailable' }, async () => {
  await withReplayRepo({ 'src/a.js': 'module.exports = { add: (x, y) => x + y };\n' }, async ({ work, domainsPath }) => {
    const diff = 'diff --git a/src/ghost.js b/src/ghost.js\n--- a/src/ghost.js\n+++ b/src/ghost.js\n@@ -1 +1 @@\n-old\n+new\n';
    const task = replayTask('replay-ghost', diff, 'node --test src/ghost.test.js');
    const captured = await runReplay(task, work, domainsPath);
    assert.equal(captured.length, 1);
    const prompt = captured[0];
    assert.match(prompt, /"type":"missing-file","detail":"src\/ghost\.test\.js"/, 'the test file the draft claims to run does not exist anywhere');
    assert.doesNotMatch(prompt, /"claimedPath":"[^"]*ghost[^"]*","exists":false,"resolvedPath":null,"resolvedVia":null,"isCreateTarget":true/, 'nothing here is a create target');
    assert.notEqual(task.executedVerification.status, 'passed');
    assert.doesNotMatch(prompt, /Result: PASSED\./);
  });
});

// Replay of the dependent-slice rejection: slice 2 edits a file only slice 1 (unmerged) creates. The diff cannot apply to the base,
// which is "cannot tell", never "failed" -- the review must reach the vote instead of hard-blocking.
test('replay: a slice that depends on an unmerged sibling is INCONCLUSIVE -- it is not blocked, and the voters are told not to count it either way', { skip: !HAS_BWRAP && 'bwrap unavailable' }, async () => {
  await withReplayRepo({ 'src/a.js': 'module.exports = { add: (x, y) => x + y };\n' }, async ({ work, domainsPath }) => {
    const diff = 'diff --git a/src/sibling.js b/src/sibling.js\n--- a/src/sibling.js\n+++ b/src/sibling.js\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n';
    const task = replayTask('replay-dependent', diff, 'node --test src/a.test.js');
    const captured = await runReplay(task, work, domainsPath);
    assert.equal(captured.length, 1, 'inconclusive must not block');
    assert.equal(task.executedVerification.status, 'inconclusive');
    assert.notEqual(task.status, 'blocked');
    assert.match(captured[0], /Result: INCONCLUSIVE\./);
    assert.match(captured[0], /INCONCLUSIVE is neither a pass nor a failure/);
  });
});


// --- the voters see changed code no test pins (brain dump #1664 slice 2) ---------------------------------------------------------------------
const EV_UNPINNED = {
  status: 'passed', reasons: [],
  tests: { ran: ['src/a.test.js'], passed: true, failures: [] },
  commands: [],
  unpinned: { total: 3, checked: 3, skipped: 0, hunks: [{ file: 'src/local-draft.js', start: 1367, end: 1384 }, { file: 'src/a.js', start: 12, end: 12 }] },
};

test('summariseExecutedVerification carries the unpinned result (counts clamped, hunks capped and trimmed) and omits the key when there is none', () => {
  const { summariseExecutedVerification } = require('./review-task.js');
  const s = summariseExecutedVerification(EV_UNPINNED);
  assert.deepEqual(s.unpinned, EV_UNPINNED.unpinned);
  const junk = summariseExecutedVerification({ ...EV_UNPINNED, unpinned: { total: -4, checked: 'x', skipped: 2.9, hunks: Array.from({ length: 9 }, (_, i) => ({ file: `f${i}.js`.padEnd(300, 'x'), start: i, end: NaN })) } });
  assert.deepEqual([junk.unpinned.total, junk.unpinned.checked, junk.unpinned.skipped], [0, 0, 2]);
  assert.equal(junk.unpinned.hunks.length, 6);
  assert.equal(junk.unpinned.hunks[0].file.length, 160);
  assert.equal(junk.unpinned.hunks[3].end, 0);
  assert.equal('unpinned' in summariseExecutedVerification({ ...EV_UNPINNED, unpinned: undefined }), false);
  assert.equal('unpinned' in summariseExecutedVerification({ ...EV_UNPINNED, unpinned: 'junk' }), false);
});

test('the section names each unpinned hunk as file:start-end (file:line for one line), says what that does and does not prove, and is unchanged when there are none', () => {
  const { formatExecutedVerificationSection } = require('./review-task.js');
  const section = formatExecutedVerificationSection(EV_UNPINNED);
  assert.match(section, /- Changed code NOT pinned by any test \(2 of 3 hunk\(s\) checked\): src\/local-draft\.js:1367-1384, src\/a\.js:12\./);
  assert.match(section, /every covering test still passed/);
  assert.match(section, /may be a pure refactor, so this alone is not a reason to reject/);
  const without = formatExecutedVerificationSection({ ...EV_UNPINNED, unpinned: undefined });
  const emptyHunks = formatExecutedVerificationSection({ ...EV_UNPINNED, unpinned: { total: 2, checked: 2, skipped: 0, hunks: [] } });
  assert.doesNotMatch(without, /NOT pinned/);
  assert.equal(emptyHunks, without, 'every checked hunk pinned: nothing extra for the voters');
  assert.equal(section.split('\n').filter((l) => !l.startsWith('- Changed code NOT pinned')).join('\n'), without);
});

test('the verifier is asked for the unpinned check by default, and AGENT_MANAGER_REVIEW_UNPINNED_CHECK=false turns only that off', withExecutedVerify(async () => {
  const seen = {};
  for (const [label, env] of [['default', undefined], ['off', 'false'], ['on', 'true']]) {
    const { repoRoot, domainsPath } = makeFixture();
    if (env === undefined) delete process.env.AGENT_MANAGER_REVIEW_UNPINNED_CHECK; else process.env.AGENT_MANAGER_REVIEW_UNPINNED_CHECK = env;
    try {
      await reviewTask(adhocImplementedTask({ id: `ev-unpinned-${label}` }), { repoRoot, domainsPath, localMajorityVote: fakeApprove([]), recordModelOutcome: () => {},
        verifyDiffFn: (a) => { seen[label] = a.checkUnpinned; return { status: 'passed', reasons: [], tests: null, commands: [] }; } });
    } finally { delete process.env.AGENT_MANAGER_REVIEW_UNPINNED_CHECK; }
  }
  assert.deepEqual(seen, { default: true, off: false, on: true });
}));

test('end to end: an unpinned result from the verifier is recorded on the task, noted in its history and shown in the prompt the voters get', withExecutedVerify(async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = adhocImplementedTask({ id: 'ev-unpinned-e2e' });
  const captured = [];
  await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {}, verifyDiffFn: () => EV_UNPINNED });
  assert.equal(captured.length, 1, 'advisory: it never blocks');
  assert.deepEqual(task.executedVerification.unpinned.hunks.map((h) => h.file), ['src/local-draft.js', 'src/a.js']);
  assert.match(task.history.find((h) => h.stage === 'advisory' && /executed verification/.test(h.detail)).detail, /2 unpinned hunk\(s\)/);
  assert.match(captured[0], /Changed code NOT pinned by any test \(2 of 3 hunk\(s\) checked\): src\/local-draft\.js:1367-1384, src\/a\.js:12\./);
}));

// Real engines end to end: a diff that changes two functions but adds a test for only one of them.
test('replay: the real verification engine reports the hunk the new test does not exercise, and the voters are shown it', { skip: !HAS_BWRAP && 'bwrap unavailable' }, async () => {
  const filler = Array.from({ length: 12 }, (_, i) => `// filler ${i}`).join('\n');
  const base = `function add(a, b) { return a + b; }\n${filler}\nfunction twice(a) { return a * 2; }\nmodule.exports = add;\nmodule.exports.twice = twice;\n`;
  await withReplayRepo({ 'src/add.js': base }, async ({ work, domainsPath }) => {
    const git = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    fs.writeFileSync(path.join(work, 'src/add.js'), base.replace('return a + b;', 'return Number(a) + Number(b);').replace('return a * 2;', 'return a * 3;'));
    fs.writeFileSync(path.join(work, 'src/add.test.js'), "const test = require('node:test'); const assert = require('node:assert/strict'); const add = require('./add.js');\ntest('coerces', () => assert.equal(add('1', 2), 3));\n");
    git(['add', '-A']);
    const diff = git(['diff', '--cached', '--full-index', '--binary']);
    git(['reset', '-q', '--hard']);
    const task = replayTask('replay-unpinned', diff, 'node --test src/add.test.js');
    const captured = await runReplay(task, work, domainsPath);
    assert.equal(captured.length, 1);
    assert.equal(task.executedVerification.status, 'passed');
    assert.equal(task.executedVerification.unpinned.hunks.length, 1);
    assert.equal(task.executedVerification.unpinned.hunks[0].file, 'src/add.js');
    assert.ok(task.executedVerification.unpinned.hunks[0].start > 10, 'the twice() hunk, not the add() hunk');
    assert.match(captured[0], /Changed code NOT pinned by any test \(1 of 2 hunk\(s\) checked\): src\/add\.js:\d+\./);
  });
});



// --- the voters see additions nothing references (brain dump #1665 slice 2) -----------------------------------------------------------------------
function withInertCheck(fn) {
  return async () => {
    process.env.AGENT_MANAGER_REVIEW_INERT_CHECK = 'true';
    try { await fn(); } finally { process.env.AGENT_MANAGER_REVIEW_INERT_CHECK = 'false'; }
  };
}
const INERT_FOUND = { considered: 3, unknown: 0, inert: [{ kind: 'function', name: 'orphanHelper', file: 'src/a.js', line: 21 }, { kind: 'file', name: 'new-lib.js', file: 'src/new-lib.js', line: 1 }] };

test('isHubChildTask recognises a slice of a hub by its coordination fields, title or id, and nothing else', () => {
  const { isHubChildTask } = require('./review-task.js');
  for (const t of [{ stacked: { branch: 'agent/x', seq: 2, total: 3 } }, { parentHub: 'h1' }, { dependsOn: ['HUB0001-01-a'] }, { softDependsOn: ['x'] }, { title: 'HUB0068 · 2/3 · Extract it' }, { id: 'HUB0068-02-extract' }]) assert.equal(isHubChildTask(t), true, JSON.stringify(t));
  for (const t of [{}, { dependsOn: [] }, { title: 'Add a helper' }, { id: 'adhoc-thing-17' }, null, undefined, 'x']) assert.equal(isHubChildTask(t), false, JSON.stringify(t));
});

test('summariseInertAdditions clamps junk, caps the list and remembers the real total', () => {
  const { summariseInertAdditions } = require('./review-task.js');
  const s = summariseInertAdditions(INERT_FOUND, true);
  assert.deepEqual([s.considered, s.unknown, s.hubChild, s.total, s.inert.length], [3, 0, true, 2, 2]);
  const many = summariseInertAdditions({ considered: -5, unknown: 'x', inert: Array.from({ length: 12 }, (_, i) => ({ kind: 'weird', name: `n${i}`.padEnd(300, 'x'), file: 'f', line: NaN })) }, false);
  assert.deepEqual([many.considered, many.unknown, many.total, many.inert.length], [0, 0, 12, 8]);
  assert.equal(many.inert[0].kind, 'function');
  assert.equal(many.inert[0].name.length, 120);
  assert.equal(many.inert[0].line, 0);
  assert.deepEqual(summariseInertAdditions(null, false).inert, []);
});

test('the inert section names each addition, differs for a hub slice, shows how many more there are, and is empty when there is nothing', () => {
  const { formatInertAdditionsSection, summariseInertAdditions } = require('./review-task.js');
  const plain = formatInertAdditionsSection(summariseInertAdditions(INERT_FOUND, false));
  assert.match(plain, /--- Unreferenced additions \(deterministic check; advisory\) ---/);
  assert.match(plain, /function orphanHelper \(src\/a\.js:21\); file new-lib\.js \(src\/new-lib\.js\)/);
  assert.match(plain, /Nothing in this task wires them in/);
  assert.doesNotMatch(plain, /one slice of a hub/);
  const hub = formatInertAdditionsSection(summariseInertAdditions(INERT_FOUND, true));
  assert.match(hub, /one slice of a hub, so a later sibling may legitimately wire these up/);
  assert.doesNotMatch(hub, /Nothing in this task wires them in/);
  const more = formatInertAdditionsSection(summariseInertAdditions({ inert: Array.from({ length: 11 }, (_, i) => ({ kind: 'function', name: `fn${i}`, file: 'f.js', line: i })) }, false));
  assert.match(more, /\(\+3 more\)/);
  for (const none of [undefined, null, {}, 'x', summariseInertAdditions({ considered: 4, inert: [] }, false)]) assert.equal(formatInertAdditionsSection(none), '');
});

test('the inert finder is not called while its switch is off, or for a task that is not an implemented adhoc diff', async () => {
  let calls = 0;
  const finder = () => { calls += 1; return INERT_FOUND; };
  const run = async (task) => {
    const { repoRoot, domainsPath } = makeFixture();
    await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove([]), recordModelOutcome: () => {}, findInertFn: finder });
  };
  await run(adhocImplementedTask({ id: 'inert-off' }));                                   // switch is 'false' here (set at the top of the file)
  assert.equal(calls, 0);
  await withInertCheck(async () => {
    await run(adhocImplementedTask({ id: 'inert-no-diff', rawDiff: '' }));
    await run(adhocImplementedTask({ id: 'inert-not-implemented', adhocResolution: 'no-changes-needed' }));
    assert.equal(calls, 0);
    await run(adhocImplementedTask({ id: 'inert-on' }));
    assert.equal(calls, 1);
  })();
});

test('end to end: an inert finding is recorded, noted in the history and shown to the voters, and it never blocks', withInertCheck(async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = adhocImplementedTask({ id: 'inert-e2e' });
  const captured = [];
  let seen = null;
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {}, findInertFn: (a) => { seen = a; return INERT_FOUND; } });
  assert.equal(result.verdict, 'approved');
  assert.equal(captured.length, 1, 'advisory: the vote still happens');
  assert.equal(seen.rawDiff, task.rawDiff);
  assert.equal(seen.repoRoot, repoRoot);
  assert.equal(task.inertAdditions.total, 2);
  assert.equal(task.inertAdditions.hubChild, false);
  assert.match(task.history.find((h) => h.stage === 'advisory' && /inert-addition check/.test(h.detail)).detail, /2 unreferenced addition\(s\) \(orphanHelper, new-lib\.js\)$/);
  assert.match(captured[0], /Unreferenced additions \(deterministic check; advisory\)/);
  assert.match(captured[0], /Nothing in this task wires them in/);
}));

test('a hub slice gets the hub wording and a history note saying a sibling may wire it', withInertCheck(async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = adhocImplementedTask({ id: 'inert-hub', dependsOn: ['HUB0001-01-a'], stacked: { branch: 'agent/decompose-hub-x', seq: 2, total: 2 } });
  const captured = [];
  await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {}, findInertFn: () => INERT_FOUND });
  assert.equal(task.inertAdditions.hubChild, true);
  assert.match(captured[0], /one slice of a hub/);
  assert.match(task.history.find((h) => /inert-addition check/.test(h.detail || '')).detail, /hub slice, a sibling may wire it/);
}));

test('nothing inert means no section and no history note, and a finder that throws or returns junk cannot break the review', withInertCheck(async () => {
  for (const [label, finder] of [['clean', () => ({ considered: 2, unknown: 0, inert: [] })], ['throws', () => { throw new Error('git exploded'); }], ['junk', () => 'nope']]) {
    const { repoRoot, domainsPath } = makeFixture();
    const task = adhocImplementedTask({ id: `inert-${label}` });
    const captured = [];
    const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {}, findInertFn: finder });
    assert.equal(result.verdict, 'approved', label);
    assert.equal(captured.length, 1, label);
    assert.doesNotMatch(captured[0], /Unreferenced additions/, label);
    assert.equal(task.history.some((h) => /inert-addition check/.test(h.detail || '')), false, label);
  }
}));

// Real engine, real git: a diff that adds a function nothing calls (and one the base already calls).
test('replay: the real inert check, against a real git remote, tells the voters about the orphan helper and not about the one the base already calls', withInertCheck(async () => {
  await withReplayRepo({ 'src/lib.js': 'const keep = 1;\nmodule.exports = { keep };\n', 'src/caller.js': 'const x = waitedForHelper();\n' }, async ({ work, domainsPath }) => {
    const git = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    fs.writeFileSync(path.join(work, 'src/lib.js'), 'const keep = 1;\nfunction orphanHelper() { return 1; }\nfunction waitedForHelper() { return 2; }\nmodule.exports = { keep };\n');
    git(['add', '-A']);
    const diff = git(['diff', '--cached', '--full-index', '--binary']);
    git(['reset', '-q', '--hard']);
    const task = replayTask('replay-inert', diff, 'node --check src/lib.js');
    const captured = [];
    await reviewTask(task, { repoRoot: work, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {} });
    assert.equal(captured.length, 1);
    assert.deepEqual(task.inertAdditions.inert.map((i) => i.name), ['orphanHelper']);
    assert.match(captured[0], /function orphanHelper \(src\/lib\.js:\d+\)/);
    assert.doesNotMatch(captured[0], /waitedForHelper \(/, 'the base already calls it');
  });
}));



// --- the voters are told when a diff adds a skip / dismiss / early-exit path (brain dump #1667) ---------------------------------------------------------
function withSkipPathRule(fn) {
  return async () => {
    process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE = 'true';
    try { await fn(); } finally { process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE = 'false'; }
  };
}
const SKIP_FOUND = { total: 3, paths: [{ kind: 'gate-function', file: 'src/gate.js', line: 12, text: 'gateThing' }, { kind: 'status-label', file: 'src/gate.js', line: 15, text: "status: 'archived'" }] };
const GATE_DIFF = "diff --git a/src/gate.js b/src/gate.js\n--- a/src/gate.js\n+++ b/src/gate.js\n@@ -10,0 +11,4 @@\n+function gateThing(snippet) {\n+  if (!/loop/.test(snippet)) return { ruleId: 'x', status: 'archived', reason: 'no loop' };\n+  return null;\n+}\n";

test('summariseSkipPaths clamps junk, caps the list and never reports fewer than it lists', () => {
  const { summariseSkipPaths } = require('./review-task.js');
  const s = summariseSkipPaths(SKIP_FOUND);
  assert.deepEqual([s.total, s.paths.length, s.paths[0].kind], [3, 2, 'gate-function']);
  const junk = summariseSkipPaths({ total: -9, paths: Array.from({ length: 12 }, (_, i) => ({ kind: 'weird', file: `f${i}`.padEnd(300, 'x'), line: NaN, text: 't'.repeat(400) })) });
  assert.deepEqual([junk.total, junk.paths.length], [12, 8]);
  assert.equal(junk.paths[0].kind, 'status-label');
  assert.equal(junk.paths[0].file.length, 160);
  assert.equal(junk.paths[0].text.length, 120);
  assert.equal(junk.paths[0].line, 0);
  assert.deepEqual(summariseSkipPaths(null).paths, []);
});

test('the skip-path section lists each path, states the three things the draft must show and when to reject, and is empty when there are none', () => {
  const { formatSkipPathSection, summariseSkipPaths } = require('./review-task.js');
  const section = formatSkipPathSection(summariseSkipPaths(SKIP_FOUND));
  assert.match(section, /--- Skip \/ dismiss paths in this diff \(deterministic check; advisory\) ---/);
  assert.match(section, /src\/gate\.js:12 \(gate-function: gateThing\); src\/gate\.js:15 \(status-label: status: 'archived'\) \(\+1 more\)/);
  assert.match(section, /\(1\) it names a real case the path could wrongly drop; \(2\) a test shows that case still goes through; \(3\) every dismissal leaves an audit\/history line or a counter/);
  assert.match(section, /a status label or a helper name alone is not enough/);
  assert.match(section, /concrete reason to REJECT: say which one is missing/);
  assert.match(section, /only skips what the task explicitly asked to skip, with a test, is fine/);
  for (const none of [undefined, null, {}, 'x', { total: 0, paths: [] }]) assert.equal(formatSkipPathSection(none), '');
});

test('a prompt for a task with no skip paths is byte-identical to one that never ran the check', () => {
  const { buildVerdictPrompt } = require('./review-task.js');
  const task = adhocImplementedTask({ id: 'skip-identical' });
  const before = buildVerdictPrompt(task, { flags: [] }, 'GROUNDING');
  const after = buildVerdictPrompt({ ...task, skipPaths: { total: 0, paths: [] } }, { flags: [] }, 'GROUNDING');
  assert.equal(after, before);
  assert.doesNotMatch(before, /Skip \/ dismiss paths/);
  assert.match(buildVerdictPrompt({ ...task, skipPaths: SKIP_FOUND }, { flags: [] }, 'GROUNDING'), /Skip \/ dismiss paths in this diff/);
});

test('the skip-path finder is not called while its switch is off, or for a task that is not an implemented adhoc diff', async () => {
  let calls = 0;
  const finder = () => { calls += 1; return SKIP_FOUND; };
  const run = async (task) => {
    const { repoRoot, domainsPath } = makeFixture();
    await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove([]), recordModelOutcome: () => {}, findSkipPathsFn: finder });
  };
  await run(adhocImplementedTask({ id: 'skip-off' }));
  assert.equal(calls, 0);
  await withSkipPathRule(async () => {
    await run(adhocImplementedTask({ id: 'skip-no-diff', rawDiff: '' }));
    await run(adhocImplementedTask({ id: 'skip-not-implemented', adhocResolution: 'no-changes-needed' }));
    assert.equal(calls, 0);
    await run(adhocImplementedTask({ id: 'skip-on' }));
    assert.equal(calls, 1);
  })();
});

test('end to end: the finding is recorded, noted in the history and shown to the voters, and it never blocks', withSkipPathRule(async () => {
  const { repoRoot, domainsPath } = makeFixture();
  const task = adhocImplementedTask({ id: 'skip-e2e' });
  const captured = [];
  let seen = null;
  const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {}, findSkipPathsFn: (a) => { seen = a; return SKIP_FOUND; } });
  assert.equal(result.verdict, 'approved');
  assert.equal(captured.length, 1, 'advisory: the vote still happens');
  assert.equal(seen.rawDiff, task.rawDiff);
  assert.equal(task.skipPaths.total, 3);
  assert.match(task.history.find((h) => /skip-path rule/.test(h.detail || '')).detail, /3 dismiss\/skip path\(s\) in the diff \(gate-function, status-label\)$/);
  assert.match(captured[0], /Skip \/ dismiss paths in this diff/);
  assert.match(captured[0], /\(3\) every dismissal leaves an audit\/history line or a counter/);
}));

test('a clean result, a throwing finder and a junk result all leave the review untouched', withSkipPathRule(async () => {
  for (const [label, finder] of [['clean', () => ({ total: 0, paths: [] })], ['throws', () => { throw new Error('boom'); }], ['junk', () => 'nope']]) {
    const { repoRoot, domainsPath } = makeFixture();
    const task = adhocImplementedTask({ id: `skip-${label}` });
    const captured = [];
    const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {}, findSkipPathsFn: finder });
    assert.equal(result.verdict, 'approved', label);
    assert.equal(captured.length, 1, label);
    assert.doesNotMatch(captured[0], /Skip \/ dismiss paths/, label);
    assert.equal(task.history.some((h) => /skip-path rule/.test(h.detail || '')), false, label);
  }
}));

test('replay: the real detector flags a diff that adds a gate returning an archived status, and says nothing about an ordinary diff', withSkipPathRule(async () => {
  const run = async (id, rawDiff) => {
    const { repoRoot, domainsPath } = makeFixture();
    const task = adhocImplementedTask({ id, rawDiff });
    const captured = [];
    await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: fakeApprove(captured), recordModelOutcome: () => {} });
    return { task, prompt: captured[0] };
  };
  const gate = await run('skip-real-gate', GATE_DIFF);
  assert.deepEqual(gate.task.skipPaths.paths.map((p) => p.kind), ['gate-function', 'status-label']);
  assert.match(gate.prompt, /src\/gate\.js:11 \(gate-function: gateThing\)/);
  assert.match(gate.prompt, /src\/gate\.js:12 \(status-label: /);
  const plain = await run('skip-real-plain', adhocImplementedTask().rawDiff);
  assert.equal(plain.task.skipPaths.paths.length, 0);
  assert.doesNotMatch(plain.prompt, /Skip \/ dismiss paths/);
}));
