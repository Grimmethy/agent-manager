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
// run prints a real uncaught-exception stack trace to stderr for no benefit. A
// throwaway value matches apply-task.test.js's own identical reasoning for the same var.
process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || require('os').tmpdir();

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
  assert.match(prompt, /PLAN above was drafted BLIND/);
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
    repoRoot, domainsPath, ornithMajorityVote: fakeApprove(captured),
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
      repoRoot, domainsPath, ornithMajorityVote: fakeApprove(captured),
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
    ornithMajorityVote: fakeApprove(captured),
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
    ornithMajorityVote: fakeApprove(captured),
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
    ornithMajorityVote: fakeApprove(captured),
    recordModelOutcome: () => {},
  });
  assert.equal(result.succeeded, true);
  assert.match(captured[0], /"claimedPath":"real\.ts","exists":true/);
});
