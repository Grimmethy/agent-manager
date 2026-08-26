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

const { reviewTask, buildVerdictPrompt } = require('./review-task.js');

function baseTask(overrides = {}) {
  return {
    id: 'test-task-1',
    domain: 'brain_dump_sort',
    source: 'brain_dump_sort',
    title: 'Sort brain dump entry: test',
    planResponse: '1. This note is about X.\n2. actionable: false\n3. reference\n4. references/x.md\n5. none apply',
    implementResponse: JSON.stringify({
      category: 'reference', secondBrainPath: 'references/x.md', tags: ['x'],
      actionable: false, rationale: 'documentation', belongsToProject: null,
    }),
    ...overrides,
  };
}

// 2026-08-24 (Grimmethy, caught live): a real, well-sourced research draft citing real
// June/August 2026 press coverage got rejected -- the reviewer's own blockedReason said
// "given the current real-world date context (2024/2025)", i.e. it had no real anchor for
// "today" at all. Fixed by stating the actual date unconditionally.
test('buildVerdictPrompt states the real current date so recency judgments have a real anchor', () => {
  const prompt = buildVerdictPrompt(baseTask(), { flags: [] }, '');
  const today = new Date().toISOString().slice(0, 10);
  assert.match(prompt, new RegExp(`real current date is ${today}`));
  assert.match(prompt, /do not reject a cited source, URL, or claimed date merely for being after some earlier date/);
});

test('buildVerdictPrompt gives brain_dump_sort its own carve-out, not the generic code-review framing', () => {
  const prompt = buildVerdictPrompt(baseTask(), { flags: [] }, '');
  assert.match(prompt, /CLASSIFICATION task, not a code-change task/);
  assert.match(prompt, /secondBrainPath.*commonly does NOT exist yet/s);
  // The generic phrasing must not appear anywhere for this source -- confirmed live
  // 2026-08-16 this exact sentence, present unconditionally, contradicted the carve-out
  // above it and was one of two compounding causes of every real rejection.
  assert.doesNotMatch(prompt, /does it contain real, complete code/i);
  assert.match(prompt, /complete, valid classification JSON/);
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
  assert.match(prompt, /do the sub-tasks, together, actually cover everything/);
  assert.match(prompt, /well-formed JSON array of sub-tasks/);
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
  assert.match(prompt, /do the sub-candidates, together, actually cover/);
  assert.match(prompt, /well-formed JSON array of sub-candidates/);
  assert.doesNotMatch(prompt, /does it contain real, complete code/i);
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

test('reviewTask fact-checks brain_dump_sort secondBrainPath against secondBrainDir, not repoRoot -- exists:true for a note that is only in the vault', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = makeFixture();
  fs.mkdirSync(path.join(secondBrainDir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(secondBrainDir, 'references', 'x.md'), '# X\n');
  // Deliberately NOT created under repoRoot -- proves the fact-check is really looking
  // at secondBrainDir, not silently passing because the same relative path happens to
  // exist under repoRoot too.
  assert.equal(fs.existsSync(path.join(repoRoot, 'references', 'x.md')), false);

  const captured = [];
  const result = await reviewTask(baseTask(), {
    repoRoot, secondBrainDir, domainsPath,
    localMajorityVote: fakeApprove(captured),
    recordModelOutcome: () => {},
  });

  assert.equal(result.succeeded, true);
  assert.equal(result.verdict, 'approved');
  assert.equal(captured.length, 1);
  assert.match(captured[0], /"claimedPath":"references\/x\.md","exists":true/);
});

test('reviewTask reports exists:false (not an error) for a brand-new secondBrainPath, and the prompt tells the reviewer that is expected', async () => {
  const { secondBrainDir, domainsPath } = makeFixture();
  // Nothing written to secondBrainDir at all -- the common "filing something new" case.

  const captured = [];
  const result = await reviewTask(baseTask(), {
    repoRoot: path.join(secondBrainDir, '..', 'repo'), secondBrainDir, domainsPath,
    localMajorityVote: fakeApprove(captured),
    recordModelOutcome: () => {},
  });

  assert.equal(result.succeeded, true);
  assert.match(captured[0], /"claimedPath":"references\/x\.md","exists":false/);
  // The carve-out explaining that this specific flag is expected must actually be in
  // the same prompt the reviewer sees it alongside -- not just true in the abstract.
  assert.match(captured[0], /missing-file.*fact-check flag on secondBrainPath ALONE is expected/s);
});

test('reviewTask still runs the deep_dive clonePath override correctly (no regression from adding the brain_dump_sort branch alongside it)', async () => {
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
