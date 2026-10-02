'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { execFileSync } = require('child_process');
const { sweep, reAnchorFile } = require('./context-trim-sweep.js');
const { windowFetchedFileContent } = require('./sdk/candidate-fulfillment.js');
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

// --- HUB0112 (3/3): AC-111 citation auto-correction ------------------------------------
// observability-fix-ac-111's real shape: the report handler's code (its Snippet) moved out
// of python/dashboard/app.py into python/dashboard/routes/reports.py, so re-anchoring
// against the cited file can show no measurable improvement and the sweep would otherwise
// flag the task stale-grounding-unrecoverable. The auto-correction pass (2026-09-23,
// sibling 1/3) must instead re-point the candidate's Files: citation at the file that now
// owns the snippet, and the task must be requeued -- not flagged.
test('AC-111 citation correction: a candidate citing app.py whose Snippet only exists at routes/reports.py gets its Files: citation re-pointed and is NOT flagged stale-grounding-unrecoverable', async () => {
  const dir = tmpPipeline();
  const repo = path.join(dir, 'repo');

  // Synthetic stand-ins for the two REAL files (the test must not depend on their actual
  // on-disk contents). app.py: the report-detail handler is GONE (its code lived here
  // when the candidate was written) -- the snippet is genuinely absent from the cited
  // file. reports.py: the Snippet exists ONLY here, and nowhere else in the repo (so
  // relocateStaleAnchor's "exactly one file matches" tier acceptance can fire).
  fs.mkdirSync(path.join(repo, 'python', 'dashboard', 'routes'), { recursive: true });
  const appContent =
    'try:\n    payload = open(path)\nexcept OSError:\n    logger.warning("could not read %r", path)\n    return None\n';
  const handlerBlock =
    'def api_report_detail(period, filename):\n' +
    '    try:\n' +
    '        content = path.read_text(encoding="utf-8")\n' +
    '    except OSError:\n' +
    '        logger.exception("Failed to serve report file %r", path)\n' +
    '        abort(404)\n';
  fs.writeFileSync(path.join(repo, 'python', 'dashboard', 'app.py'), appContent);
  fs.writeFileSync(path.join(repo, 'python', 'dashboard', 'routes', 'reports.py'), handlerBlock);

  // The Snippet is the handler block itself -- comfortably past relocateStaleAnchor's
  // 120 whitespace-stripped-char floor (a snippet shorter than that is never followed,
  // as it would be ambiguous to a neighbour).
  const body =
    'Problem:\nThe `api_report_detail` error handler needs a cleaner failure path.\n\n' +
    'Snippet:\n' +
    '```\n' + handlerBlock + '\n```\n\n' +
    'Solution:\nReturn a JSON body instead of aborting.';

  // Stale snapshot taken at candidate-creation time: points at app.py (where the code
  // USED to live). Its frozen window is byte-identical to what's on disk and was
  // already anchored 'strong', so re-anchoring app.py shows NO measurable improvement
  // -- the branch under test is exactly the one where the sweep must fall through to
  // the citation auto-correction path instead of flagging.
  writeTask(dir, 'blocked', baseTask('t-ac111', {
    title: 'AC-111 · report handler moved out of app.py',
    promptContext: {
      body,
      fetchedFiles: [
        { path: 'python/dashboard/app.py', content: appContent, anchorConfidence: 'strong' },
      ],
    },
  }));

  const s = await sweep({ pipelineDir: dir, repoRoot: repo, now: Date.now() });

  assert.equal(s.requeued, 1, 'a relocatable citation is a measurable improvement -> requeue');
  assert.equal(s.flagged, 0);
  assert.equal(exists(dir, 'blocked', 't-ac111'), false, 'must be moved out of blocked');
  const fresh = readTask(dir, 'pending', 't-ac111');
  assert.equal(fresh.promptContext.fetchedFiles[0].path, 'python/dashboard/routes/reports.py',
    "the candidate's Files: citation must now point at the file that owns the Snippet");
  assert.ok(!fresh.contextTrimFlag, "'stale-grounding-unrecoverable' flag must NOT be set");
  assert.ok(JSON.stringify(fresh).indexOf('stale-grounding-unrecoverable') === -1,
    'no trace of the unrecoverable flag anywhere on the requeued task');
});
