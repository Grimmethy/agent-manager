'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { execFileSync } = require('child_process');
const { sweep, reAnchorFile } = require('./context-trim-sweep.js');
const candidateFulfillment = require('./sdk/candidate-fulfillment.js');
const { windowFetchedFileContent } = candidateFulfillment;
const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');
// Use test-namespaced source names, not real ones (arch_review etc. are registered by the
// out-of-tree hygiene plugin the moment local-draft.js loads it, so re-registering the
// same name here would collide) -- isCandidateFulfillmentSource only cares about the
// candidateFulfillment flag on whatever name a task's `source` field carries.
if (!getRegisteredSource('context_trim_test_source')) {
  registerTaskSource('context_trim_test_source', { priority: 80, next: () => null, candidateFulfillment: true });
}
if (!getRegisteredSource('context_trim_test_manual_source')) {
  registerTaskSource('context_trim_test_manual_source', { priority: 80, next: () => null });
}

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-trim-'));
  for (const d of ['blocked', 'pending', 'done']) {
    fs.mkdirSync(path.join(dir, 'queue', d), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, 'repo'), { recursive: true });
  return dir;
}

function writeTask(pipelineDir, state, task) {
  fs.writeFileSync(path.join(pipelineDir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function readTask(pipelineDir, state, id) {
  return JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', state, `${id}.json`), 'utf8'));
}

function exists(pipelineDir, state, id) {
  return fs.existsSync(path.join(pipelineDir, 'queue', state, `${id}.json`));
}

const padding = 'x'.repeat(9000);

const baseTask = (id, overrides = {}) => ({
  id,
  source: 'context_trim_test_source',
  domain: 'code',
  status: 'blocked',
  title: `AC-1 · ${id}`,
  promptContext: {
    body: 'Problem:\nThe `realTarget` function has a bug.\n\nSolution:\nFix it.',
    fetchedFiles: [
      { path: 'big.js', content: `${padding}\n...[truncated]`, anchorConfidence: 'none' },
    ],
  },
  ...overrides,
});

test('sweep requeues a task once re-anchoring flips confidence from none to strong', async () => {
  const dir = tmpPipeline();
  fs.writeFileSync(path.join(dir, 'repo', 'big.js'), `${padding}\nfunction realTarget() { return 1; }\n${padding}`);
  writeTask(dir, 'blocked', baseTask('t1'));

  const s = await sweep({ pipelineDir: dir, repoRoot: path.join(dir, 'repo'), now: Date.now() });

  assert.equal(s.requeued, 1);
  assert.equal(exists(dir, 'blocked', 't1'), false, 'must be moved out of blocked');
  const fresh = readTask(dir, 'pending', 't1');
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.contextTrimAttempts, 1);
  assert.match(fresh.promptContext.fetchedFiles[0].content, /realTarget/);
  assert.equal(fresh.promptContext.fetchedFiles[0].anchorConfidence, 'strong');
  assert.ok(!fresh.blockedReason, 'drafting/review artifacts must be dropped, not copied');
  // 2026-09-08, Grimmethy: "establish a single, documented task log template" -- the
  // fresh history entry must use the canonical { stage, at, detail } shape
  // (task-history.js's appendHistoryEvent), not a divergent { status, at, note }.
  assert.equal(fresh.history[0].stage, 'pending');
  assert.ok(fresh.history[0].at);
  assert.match(fresh.history[0].detail, /auto-requeued by context-trim-sweep/);
  assert.equal(fresh.history[0].status, undefined);
  assert.equal(fresh.history[0].note, undefined);
});

test('sweep does not requeue and does not flag when re-anchoring changes nothing measurable', async () => {
  const dir = tmpPipeline();
  // The file on disk is IDENTICAL to what it was at candidate-creation time -- no anchor
  // exists either before or after, so re-anchoring must reproduce byte-identical output.
  const unchangedContent = `${padding}\n${padding}`;
  fs.writeFileSync(path.join(dir, 'repo', 'big.js'), unchangedContent);
  const body = 'Problem:\nSomething about `aSymbolThatIsNotInTheFile`.\n\nSolution:\nFix it.';
  const frozen = windowFetchedFileContent(unchangedContent, body);
  writeTask(dir, 'blocked', baseTask('t2', {
    promptContext: {
      body,
      fetchedFiles: [{ path: 'big.js', content: frozen.text, anchorConfidence: frozen.confidence, usedSnippetFuzzyMatch: frozen.usedSnippetFuzzyMatch }],
    },
  }));

  const s = await sweep({ pipelineDir: dir, repoRoot: path.join(dir, 'repo'), now: Date.now() });

  assert.equal(s.requeued, 0);
  assert.equal(s.flagged, 1);
  assert.equal(exists(dir, 'blocked', 't2'), true, 'stays in blocked');
  const flagged = readTask(dir, 'blocked', 't2');
  assert.equal(flagged.contextTrimFlag.reason, 'stale-grounding-unrecoverable');
});

test('sweep flags instead of requeuing once the attempt cap is reached, even with an improvement available', async () => {
  const dir = tmpPipeline();
  fs.writeFileSync(path.join(dir, 'repo', 'big.js'), `${padding}\nfunction realTarget() { return 1; }\n${padding}`);
  writeTask(dir, 'blocked', baseTask('t3', { contextTrimAttempts: 2 }));

  const s = await sweep({ pipelineDir: dir, repoRoot: path.join(dir, 'repo'), now: Date.now() });

  assert.equal(s.requeued, 0);
  assert.equal(s.flagged, 1);
  assert.equal(exists(dir, 'blocked', 't3'), true);
  const flagged = readTask(dir, 'blocked', 't3');
  assert.match(flagged.contextTrimFlag.evidence[0], /attempt cap/);
});

test('sweep skips a task under an active contextTrimKeep cooldown, without reading its files', async () => {
  const dir = tmpPipeline();
  // No big.js written at all -- if the sweep tried to read it, reAnchorFile would just
  // fail closed anyway, so assert via the requeued/flagged counts staying at zero AND the
  // file being untouched, rather than a read-count spy (no file exists to spy on reading).
  writeTask(dir, 'blocked', baseTask('t4', {
    contextTrimKeep: { until: new Date(Date.now() + 1000000).toISOString(), by: 'human', reason: 'legit stale grounding, keep as-is' },
  }));

  const s = await sweep({ pipelineDir: dir, repoRoot: path.join(dir, 'repo'), now: Date.now() });

  assert.equal(s.requeued, 0);
  assert.equal(s.flagged, 0);
  assert.equal(s.skipped, 1);
  assert.equal(exists(dir, 'blocked', 't4'), true);
  const untouched = readTask(dir, 'blocked', 't4');
  assert.ok(!untouched.contextTrimFlag, 'must not have been flagged either');
});

test('sweep skips a task carrying a fresh stalenessFlag with disposition retire', async () => {
  const dir = tmpPipeline();
  fs.writeFileSync(path.join(dir, 'repo', 'big.js'), `${padding}\nfunction realTarget() { return 1; }\n${padding}`);
  writeTask(dir, 'blocked', baseTask('t5', {
    stalenessFlag: { reason: 'already-implemented', disposition: 'retire', confidence: 'high', evidence: [], flaggedAt: new Date().toISOString() },
  }));

  const s = await sweep({ pipelineDir: dir, repoRoot: path.join(dir, 'repo'), now: Date.now() });

  assert.equal(s.requeued, 0);
  assert.equal(s.flagged, 0);
  assert.equal(s.skipped, 1);
  assert.equal(exists(dir, 'blocked', 't5'), true);
});

test('kill switch AGENT_MANAGER_CONTEXT_TRIM_SWEEP=false is a total no-op', async () => {
  const dir = tmpPipeline();
  fs.writeFileSync(path.join(dir, 'repo', 'big.js'), `${padding}\nfunction realTarget() { return 1; }\n${padding}`);
  writeTask(dir, 'blocked', baseTask('t6'));

  process.env.AGENT_MANAGER_CONTEXT_TRIM_SWEEP = 'false';
  try {
    const s = await sweep({ pipelineDir: dir, repoRoot: path.join(dir, 'repo'), now: Date.now() });
    assert.equal(s.scanned, 0);
    assert.equal(s.requeued, 0);
    assert.equal(s.flagged, 0);
    assert.equal(exists(dir, 'blocked', 't6'), true);
  } finally {
    delete process.env.AGENT_MANAGER_CONTEXT_TRIM_SWEEP;
  }
});

test('sweep ignores a non-candidate-fulfillment source (e.g. manual) even if it sits in blocked/', async () => {
  const dir = tmpPipeline();
  writeTask(dir, 'blocked', baseTask('t7', { source: 'context_trim_test_manual_source' }));

  const s = await sweep({ pipelineDir: dir, repoRoot: path.join(dir, 'repo'), now: Date.now() });

  assert.equal(s.scanned, 0);
  assert.equal(exists(dir, 'blocked', 't7'), true);
});

// --- reAnchorFile: stacked-branch grounding (2026-09-08 incident) ----------------------
// A stacked task's re-anchor pass used to always read repoRoot's plain working tree (main)
// -- a file only real on the shared stacked branch (a sibling's already-committed content)
// read as missing/stale there, so the sweep could judge the task against the wrong branch.

function makeGitRepoWithStackedBranch() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-trim-stacked-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-trim-stacked-repo-'));
  execFileSync('git', ['init', '--bare', '-b', 'main', bareDir]);
  execFileSync('git', ['clone', bareDir, repoDir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'test');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: repoDir });

  execFileSync('git', ['checkout', '-b', 'agent/stacked-family'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'realTarget.js'), 'function realTarget() { return 42; }\n');
  execFileSync('git', ['add', 'realTarget.js'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'sibling commit'], { cwd: repoDir });
  execFileSync('git', ['push', 'origin', 'agent/stacked-family'], { cwd: repoDir });
  execFileSync('git', ['checkout', 'main'], { cwd: repoDir });

  return repoDir;
}

test('reAnchorFile reads a stacked task\'s file from its own stacked branch, not main', () => {
  const repoRoot = makeGitRepoWithStackedBranch();
  const task = { id: 't-stacked', stacked: { branch: 'agent/stacked-family', seq: 2, total: 2 } };
  const result = reAnchorFile(repoRoot, { path: 'realTarget.js', anchorConfidence: 'none' }, 'Problem:\nThe `realTarget` function has a bug.', task);
  assert.ok(result, 'a file real on the stacked branch must be found, not silently dropped');
  assert.match(result.windowed.text, /realTarget/);
});

test('reAnchorFile falls back to null (unreadable) for a NON-stacked task when the file only exists on some other branch', () => {
  const repoRoot = makeGitRepoWithStackedBranch();
  const result = reAnchorFile(repoRoot, { path: 'realTarget.js', anchorConfidence: 'none' }, 'Problem:\nThe `realTarget` function has a bug.', { id: 't-plain' });
  assert.equal(result, null, 'a non-stacked task must not see a file that only exists on some other branch');
});

// --- AC-111: pre-filing citation gate (HUB0154) ---------------------------------------
// A review candidate's Snippet: is REAL code read at scan time. If it is no longer at any
// cited path it MOVED (gate CORRECTED -> re-point, requeue, do NOT archive) or it is GONE
// (gate REJECTED -> archive with a recorded reason). validateCitationBeforeFiling is the
// single verdict function; these tests drive it directly AND through the sweep's re-point
// path (the same relocateStaleAnchor primitive), reusing the synthetic-repo setup above.

const gateBlock =
  'function computePremiseEvidence(section, fetchedFiles) {\n' +
  '  const evidence = [];\n' +
  '  for (const f of fetchedFiles) { if (f.content.includes(section.symbol)) evidence.push(f.path); }\n' +
  '  return evidence;\n' +
  '}';
const gateSection =
  'Problem:\nThe `computePremiseEvidence` helper has a bug.\n\n' +
  'Snippet:\n```\n' + gateBlock + '\n```\n\n' +
  'Solution:\nFix it.';

test('AC-111 re-point: sweep re-points a stale citation to its unique new home and requeues, flagging nothing', async () => {
  const dir = tmpPipeline();
  fs.mkdirSync(path.join(dir, 'repo', 'src'), { recursive: true });
  const oldContent = `${padding}\n${padding}`;
  fs.writeFileSync(path.join(dir, 'repo', 'src', 'old.js'), oldContent);
  fs.writeFileSync(path.join(dir, 'repo', 'src', 'moved.js'), `${padding}\n${gateBlock}\n${padding}`);
  const frozen = windowFetchedFileContent(oldContent, gateSection);
  writeTask(dir, 'blocked', baseTask('ac-111-repoint', {
    promptContext: {
      body: gateSection,
      fetchedFiles: [{ path: 'src/old.js', content: frozen.text, anchorConfidence: frozen.confidence, usedSnippetFuzzyMatch: frozen.usedSnippetFuzzyMatch }],
    },
  }));

  const s = await sweep({ pipelineDir: dir, repoRoot: path.join(dir, 'repo'), now: Date.now() });

  assert.equal(s.requeued, 1, 'a fixable stale citation must be re-pointed and requeued, not flagged');
  assert.equal(s.flagged, 0, 'a fixable stale citation must NOT be flagged stale-grounding-unrecoverable');
  assert.equal(exists(dir, 'blocked', 'ac-111-repoint'), false, 'must be moved out of blocked');
  const fresh = readTask(dir, 'pending', 'ac-111-repoint');
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.promptContext.fetchedFiles[0].path, 'src/moved.js', 'citation must re-point to the unique new home');
  assert.equal(fresh.promptContext.fetchedFiles[0].anchorConfidence, 'strong');
  assert.equal(fresh.history[0].stage, 'pending');
  // The fresh record's single pending event carries the improvement list, which must
  // name the new home (the sweep's "cited Files: path corrected to ..." improvement).
  assert.match(fresh.history[0].detail, /auto-requeued by context-trim-sweep/);
  assert.match(fresh.history[0].detail, /moved\.js/, 'the requeue event must record the correction to the new home');
});

function tmpRepoRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac111-gate-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

// Direct-verdict helpers -- these are the neuter-discriminating asserts: with the gate
// reduced to a pass-through (always null) the CORRECTED and REJECTED verdicts never
// materialize and both throw; the PASS case is a null either way, so only A/B discriminate.
function expectGateA(repoRoot) {
  const verdict = candidateFulfillment.validateCitationBeforeFiling({
    sourceName: 'observability_fix', section: gateSection, files: ['src/old.js'], repoRoot,
  });
  assert.ok(verdict, 'a stale citation with a unique new home must produce a CORRECTED verdict, not a pass-through null');
  assert.equal(verdict.correctedFrom, 'src/old.js');
  assert.equal(verdict.correctedTo, 'src/moved.js');
  assert.ok(verdict.files.includes('src/moved.js'), 'Files: list must gain the new home');
  assert.ok(!verdict.files.includes('src/old.js'), 'Files: list must drop the stale path');
  assert.ok(!verdict.archiveReason, 'a CORRECTED citation is re-pointed, NOT archived');
  return verdict;
}

function expectGateB(repoRoot) {
  const verdict = candidateFulfillment.validateCitationBeforeFiling({
    sourceName: 'observability_fix', section: gateSection, files: ['src/gone.js'], repoRoot,
  });
  assert.ok(verdict, 'an unfixable citation must produce a REJECTED verdict, not a pass-through null');
  assert.match(String(verdict.archiveReason), /Snippet is absent from every cited path/);
  assert.ok(!verdict.correctedTo, 'a GONE snippet must not be re-pointed anywhere');
  return verdict;
}

function expectGateC(repoRoot) {
  const verdict = candidateFulfillment.validateCitationBeforeFiling({
    sourceName: 'observability_fix', section: gateSection, files: ['src/handler.js'], repoRoot,
  });
  assert.equal(verdict, null, 'a valid citation at its cited path must pass untouched (PASS -> null)');
  return verdict;
}

test('AC-111 gate A: a stale citation is CORRECTED to its unique new home and the candidate is NOT archived', () => {
  const repoRoot = tmpRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'src', 'old.js'), `${padding}\n${padding}`);
  fs.writeFileSync(path.join(repoRoot, 'src', 'moved.js'), `${padding}\n${gateBlock}\n${padding}`);
  expectGateA(repoRoot);
});

test('AC-111 gate B: an unfixable citation is REJECTED and archived with a recorded reason', () => {
  const repoRoot = tmpRepoRoot();
  // src/gone.js deliberately ABSENT; the snippet is nowhere else in the repo.
  fs.writeFileSync(path.join(repoRoot, 'src', 'unrelated.js'), `${padding}\n${padding}`);
  expectGateB(repoRoot);
});

test('AC-111 gate C: a valid citation at its cited path passes untouched (PASS -> no correction, no rejection)', () => {
  const repoRoot = tmpRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'src', 'handler.js'), `${padding}\n${gateBlock}\n${padding}`);
  expectGateC(repoRoot);
});

test('AC-111 gate discrimination: neutering the gate to a pass-through makes A and B fail while C still passes', () => {
  const repoA = tmpRepoRoot();
  fs.writeFileSync(path.join(repoA, 'src', 'old.js'), `${padding}\n${padding}`);
  fs.writeFileSync(path.join(repoA, 'src', 'moved.js'), `${padding}\n${gateBlock}\n${padding}`);
  const repoB = tmpRepoRoot();
  const repoC = tmpRepoRoot();
  fs.writeFileSync(path.join(repoC, 'src', 'handler.js'), `${padding}\n${gateBlock}\n${padding}`);

  // Live gate: A and B's verdicts materialize, so their helpers pass (no throw); C passes too.
  assert.doesNotThrow(() => expectGateA(repoA), 'with a live gate, gate A asserts a CORRECTED verdict and must NOT throw');
  assert.doesNotThrow(() => expectGateB(repoB), 'with a live gate, gate B asserts a REJECTED verdict and must NOT throw');
  assert.doesNotThrow(() => expectGateC(repoC));

  const original = candidateFulfillment.validateCitationBeforeFiling;
  candidateFulfillment.validateCitationBeforeFiling = () => null; // neuter to a pass-through
  try {
    assert.throws(() => expectGateA(repoA), 'a pass-through gate returns null, so gate A must FAIL when the gate is neutered');
    assert.throws(() => expectGateB(repoB), 'a pass-through gate returns null, so gate B must FAIL when the gate is neutered');
    assert.doesNotThrow(() => expectGateC(repoC), 'gate C is a null verdict either way -- it must NOT regress');
  } finally {
    candidateFulfillment.validateCitationBeforeFiling = original;
  }
});
