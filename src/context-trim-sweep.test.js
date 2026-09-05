'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweep } = require('./context-trim-sweep.js');
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
