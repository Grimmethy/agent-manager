'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildForensicBundle, findTaskRecordById, readModelCallsForTasks,
  collectSubjectTasks, selectWinners, assembleText, summarizeDiffStat,
} = require('./forensic-bundle.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forensic-bundle-test-'));
  for (const s of ['pending', 'blocked', 'needs-clarification', 'done', 'done/_archived_no_action', 'done/_archived/2026-08', 'worklogs']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}

function writeTask(pipelineDir, state, task) {
  fs.writeFileSync(path.join(pipelineDir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function failingTask(id, over) {
  return {
    id, source: 'adhoc', domain: 'adhoc',
    promptContext: { rawText: 'do a thing', decomposedFrom: 'parent-1' },
    blockedReason: 'Agentic implement pass exhausted its turn budget without making any edits',
    history: [
      { stage: 'created', at: '2026-08-30T00:00:00Z' },
      { stage: 'blocked', at: '2026-08-30T01:00:00Z', detail: 'turn budget' },
      { stage: 'needs-clarification', at: '2026-08-30T02:00:00Z', detail: 'escalated' },
    ],
    draftAttempts: [{
      attemptNo: 1, outcome: 'blocked', blockedReason: 'no edits',
      tiers: [
        { tier: 'harness-search', applied: false, reason: 'no hits' },
        { tier: 'local-agentic-write', blocked: true, turnsUsed: 35, resolution: null,
          response: 'I explored the code but never made the edit. The route belongs in app.py near line 3600.',
          toolCalls: { byTool: { grep_codebase: 20, read_file: 3 }, errors: 0 } },
      ],
    }],
    ...over,
  };
}

function winnerTask(id, over) {
  return {
    id, source: 'adhoc', domain: 'adhoc',
    promptContext: { rawText: 'do a smaller thing', decomposedFrom: 'parent-1' },
    mergedAt: '2026-08-31T00:00:00Z',
    adhocResolution: 'implemented',
    history: [
      { stage: 'created', at: '2026-08-31T00:00:00Z' },
      { stage: 'applied', at: '2026-08-31T01:00:00Z' },
    ],
    draftAttempts: [{
      attemptNo: 1, outcome: 'succeeded',
      tiers: [{ tier: 'local-agentic-write', resolution: 'implemented', turnsUsed: 8,
        toolCalls: { byTool: { read_file: 2, edit_file: 2 }, errors: 0 } }],
    }],
    ...over,
  };
}

test('findTaskRecordById locates a task in each queue state, including archived buckets', () => {
  const dir = makePipeline();
  writeTask(dir, 'blocked', { id: 'in-blocked' });
  writeTask(dir, 'done', { id: 'in-done' });
  writeTask(dir, 'done/_archived_no_action', { id: 'in-na' });
  writeTask(dir, 'done/_archived/2026-08', { id: 'in-month' });

  assert.equal(findTaskRecordById(dir, 'in-blocked').state, 'blocked');
  assert.equal(findTaskRecordById(dir, 'in-done').state, 'done');
  assert.equal(findTaskRecordById(dir, 'in-na').state, 'archived_no_action');
  assert.equal(findTaskRecordById(dir, 'in-month').state, 'archived');
  assert.equal(findTaskRecordById(dir, 'nope'), null);
});

test('readModelCallsForTasks returns an empty Map (not a throw) for a missing DB', () => {
  const r = readModelCallsForTasks('/no/such/model-stats.db', ['a', 'b']);
  assert.ok(r instanceof Map);
  assert.equal(r.size, 0);
});

test('readModelCallsForTasks tolerates a DB missing the newer columns', (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return t.skip('node:sqlite unavailable'); }
  const dir = makePipeline();
  const dbPath = path.join(dir, 'model-stats.db');
  const db = new DatabaseSync(dbPath);
  // deliberately only the core columns -- no hypothetical_cost_usd / turns_used / etc.
  db.exec(`CREATE TABLE model_calls (call_id TEXT, task_id TEXT, stage TEXT, model TEXT, started_at TEXT)`);
  db.prepare(`INSERT INTO model_calls VALUES (?,?,?,?,?)`).run('c1', 'task-x', 'implement', 'qwen', '2026-08-30T00:00:00Z');
  db.close();

  const r = readModelCallsForTasks(dbPath, ['task-x']);
  assert.equal(r.get('task-x').length, 1);
  assert.equal(r.get('task-x')[0].model, 'qwen');
});

test('selectWinners prefers a decomposition sibling over a bare same-source match', () => {
  const dir = makePipeline();
  const subject = failingTask('subj-1');
  writeTask(dir, 'needs-clarification', subject);
  writeTask(dir, 'done', winnerTask('sibling-merged', { promptContext: { decomposedFrom: 'parent-1' } }));
  writeTask(dir, 'done', winnerTask('same-source-only', {
    promptContext: { decomposedFrom: 'other-parent' }, mergedAt: '2026-08-31T05:00:00Z',
  }));
  // a done task that shipped nothing -> not a "winner"
  writeTask(dir, 'done', {
    id: 'done-but-empty', source: 'adhoc', promptContext: { decomposedFrom: 'parent-1' },
    history: [{ stage: 'created', at: '2026-08-31T00:00:00Z' }],
  });

  const winners = selectWinners(dir, [{ task: subject, state: 'needs-clarification' }]);
  assert.equal(winners[0].task.id, 'sibling-merged', 'the parent-1 sibling ranks first');
  assert.ok(winners.map((w) => w.task.id).includes('same-source-only'));
  assert.ok(!winners.map((w) => w.task.id).includes('done-but-empty'));
});

test('collectSubjectTasks: signature mode uses the injected signatureFn', () => {
  const dir = makePipeline();
  writeTask(dir, 'needs-clarification', failingTask('a', { needsClarification: { reason: 'stuck' } }));
  writeTask(dir, 'needs-clarification', failingTask('b', { needsClarification: { reason: 'stuck' } }));
  writeTask(dir, 'needs-clarification', failingTask('c', { needsClarification: { reason: 'different' } }));

  const fn = (task) => `x::${task.needsClarification?.reason}`;
  const got = collectSubjectTasks(dir, { kind: 'signature', key: 'x::stuck' }, { signatureFn: fn });
  assert.deepEqual(got.map((r) => r.task.id).sort(), ['a', 'b']);
});

test('assembleText drops the cheapest evidence first and records what fell', () => {
  const sections = [
    { text: 'A'.repeat(50) },
    { text: 'B'.repeat(400), dropTag: 'winnerCalls' },
    { text: 'C'.repeat(400), dropTag: 'subjectOldAttempts' },
  ];
  const { text, dropped } = assembleText(sections, 200);
  assert.ok(text.length <= 200 + 60);
  assert.equal(dropped[0], 'subjectOldAttempts', 'subjectOldAttempts is dropped before winnerCalls');
});

test('buildForensicBundle end-to-end: ranked-method framing + tier map + a per-tier response + contrast', () => {
  const dir = makePipeline();
  writeTask(dir, 'needs-clarification', failingTask('subj-1'));
  writeTask(dir, 'done', winnerTask('win-1'));

  const b = buildForensicBundle({ pipelineDir: dir, dbPath: '/no/db', subject: { kind: 'task', key: 'subj-1' } });
  assert.equal(b.stats.subjectCount, 1);
  assert.equal(b.stats.winnerCount, 1);
  assert.deepEqual(b.subjectIds, ['subj-1']);
  assert.deepEqual(b.winnerIds, ['win-1']);
  assert.match(b.evidenceText, /COUNTERFACTUAL impact/);
  assert.match(b.evidenceText, /TIER → SOURCE FILE/);
  assert.match(b.evidenceText, /src\/local-agentic-write-draft\.js/);
  assert.match(b.evidenceText, /never made the edit/);          // the failing tier's own response
  assert.match(b.evidenceText, /HISTORY-STAGE TRACE/);
  assert.match(b.evidenceText, /"edit_file":2/);                 // the winner's tool-call counts
  assert.ok(b.evidenceText.length <= b.stats.chars + 1);
});

test('buildForensicBundle: budgetChars is respected', () => {
  const dir = makePipeline();
  for (let i = 0; i < 4; i++) writeTask(dir, 'needs-clarification', failingTask(`s${i}`, {
    draftAttempts: [{ attemptNo: 1, outcome: 'blocked', tiers: [{ tier: 'local-agentic-write', blocked: true, response: 'x'.repeat(4000) }] }],
  }));
  for (let i = 0; i < 3; i++) writeTask(dir, 'done', winnerTask(`w${i}`));
  const b = buildForensicBundle({ pipelineDir: dir, dbPath: '/no/db', subject: { kind: 'source', key: 'adhoc' }, budgetChars: 6000 });
  assert.ok(b.evidenceText.length <= 6200, `got ${b.evidenceText.length}`);
  assert.ok(b.stats.droppedForBudget.length > 0);
});


// --- winner digest survives budget trimming (2026-09-18) ---------------------------------
// Real incident: pipeline-forensics-3-needs-clarification-tasks-same-signature-manual-
// retryable-draft-block. Four large failing subjects pushed the bundle over budget, and
// assembleText dropped EVERY winner section (winnerCalls, then winnerAttempts) before it
// touched subject 1's -- leaving only a stage-name trace. The ranked-report contract (and its
// reviewer) still demands a contrast against the winners' actual content, so the model
// honestly said "the winners' diff contents are not provided", was REJECTed for it, and the
// task could never pass no matter how often it was redrafted.

const WINNER_DIFF = [
  'diff --git a/src/reject-retry-check.js b/src/reject-retry-check.js',
  'index 111..222 100644',
  '--- a/src/reject-retry-check.js',
  '+++ b/src/reject-retry-check.js',
  '@@ -1,2 +1,4 @@',
  ' keep',
  '+added one',
  '+added two',
  '-removed one',
  'diff --git a/src/new-file.js b/src/new-file.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new-file.js',
  '@@ -0,0 +1,2 @@',
  '+a',
  '+b',
].join('\n');

test('summarizeDiffStat lists each touched file with added/removed line counts', () => {
  assert.deepEqual(summarizeDiffStat(WINNER_DIFF), [
    { path: 'src/reject-retry-check.js', added: 2, removed: 1 },
    { path: 'src/new-file.js', added: 2, removed: 0 },
  ]);
  assert.deepEqual(summarizeDiffStat(''), []);
  assert.deepEqual(summarizeDiffStat(undefined), []);
});

test('buildForensicBundle: a winner digest with the winner\'s touched files is present even at a tiny budget', () => {
  const dir = makePipeline();
  for (let i = 0; i < 4; i++) writeTask(dir, 'needs-clarification', failingTask(`s${i}`, {
    draftAttempts: [{ attemptNo: 1, outcome: 'blocked', tiers: [{ tier: 'local-agentic-write', blocked: true, response: 'x'.repeat(4000) }] }],
  }));
  writeTask(dir, 'done', winnerTask('w0', { rawDiff: WINNER_DIFF, title: 'Add the retry guard' }));

  const b = buildForensicBundle({ pipelineDir: dir, dbPath: '/no/db', subject: { kind: 'source', key: 'adhoc' }, budgetChars: 5000 });

  assert.match(b.evidenceText, /WINNER DIGEST/);
  assert.match(b.evidenceText, /w0/);
  assert.match(b.evidenceText, /src\/reject-retry-check\.js \(\+2\/-1\)/);
  assert.match(b.evidenceText, /src\/new-file\.js \(\+2\/-0\)/);
  assert.ok(b.stats.droppedForBudget.length > 0, 'the budget really did force drops');
});

test('buildForensicBundle: no winners -> no digest section', () => {
  const dir = makePipeline();
  writeTask(dir, 'needs-clarification', failingTask('subj-1'));
  const b = buildForensicBundle({ pipelineDir: dir, dbPath: '/no/db', subject: { kind: 'task', key: 'subj-1' } });
  assert.doesNotMatch(b.evidenceText, /WINNER DIGEST/);
});

// --- winner-contrast regression: MAX_WINNERS = 5, winnerTasks / winnerContrastAvailable ---
(function () {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { buildForensicBundle } = require('./forensic-bundle.js');

  function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forensic-bundle-winners-'));
    fs.mkdirSync(path.join(dir, 'queue', 'needs-clarification'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue', 'needs-clarification', 'fail-1.json'), JSON.stringify({
      id: 'fail-1',
      source: 'manual',
      title: 'failing task',
      needsClarification: { reason: 'retryable-draft-block' },
      history: [{ stage: 'needs-clarification', at: '2026-09-01T00:00:00Z', detail: 'failed after 3 attempts' }],
    }));
    return dir;
  }
  function writeWinner(dir, n) {
    fs.writeFileSync(path.join(dir, 'queue', 'done', `win-${n}.json`), JSON.stringify({
      id: `win-${n}`,
      source: 'manual',
      title: `winner ${n}`,
      mergedAt: '2026-09-01T00:00:00Z',
      history: [{ stage: 'applied', at: '2026-09-01T00:00:00Z' }],
    }));
  }

  test('bundle includes at least one winner when a successful task shares the failing task source', () => {
    const dir = freshDir();
    writeWinner(dir, 1);
    const bundle = buildForensicBundle({ pipelineDir: dir, dbPath: undefined, subject: { kind: 'source', key: 'manual' } });
    assert.ok(Array.isArray(bundle.winnerTasks), 'winnerTasks must be an array');
    assert.ok(bundle.winnerTasks.length >= 1, 'winner set must not be empty when a shipped same-source sibling exists');
    assert.equal(bundle.winnerContrastAvailable, true);
    assert.ok(bundle.winnerTasks.some((w) => w.id === 'win-1'), 'seeded winner must be in winnerTasks');
  });

  test('bundle degrades gracefully (empty winnerTasks, winnerContrastAvailable=false) when no successful task exists', () => {
    const dir = freshDir();
    const bundle = buildForensicBundle({ pipelineDir: dir, dbPath: undefined, subject: { kind: 'source', key: 'manual' } });
    assert.deepStrictEqual(bundle.winnerTasks, []);
    assert.equal(bundle.winnerContrastAvailable, false);
    assert.equal(typeof bundle.evidenceText, 'string');
    assert.ok(Array.isArray(bundle.subjectIds) && bundle.subjectIds.includes('fail-1'));
  });

  test('winner set is capped at MAX_WINNERS (5)', () => {
    const dir = freshDir();
    for (let n = 1; n <= 10; n += 1) writeWinner(dir, n);
    const bundle = buildForensicBundle({ pipelineDir: dir, dbPath: undefined, subject: { kind: 'source', key: 'manual' } });
    assert.ok(bundle.winnerTasks.length >= 1);
    assert.ok(bundle.winnerTasks.length <= 5, `winnerTasks.length ${bundle.winnerTasks.length} exceeds MAX_WINNERS=5`);
    assert.equal(bundle.winnerContrastAvailable, true);
  });
})();

// --- pinning tests: each one must FAIL when the behaviour it names is reverted ---------

test('winner fallback: a shipped task with a DIFFERENT source and parent yields >= 1 winner when no matched sibling exists', () => {
  const dir = makePipeline();
  // subject: source AND decomposition parent are both different from every shipped task
  writeTask(dir, 'needs-clarification', {
    id: 'fail-spec',
    source: 'wiki_page_promote',
    domain: 'wiki',
    promptContext: { rawText: 'promote the spec page', decomposedFrom: 'product_spec_outline' },
    needsClarification: { reason: 'retryable-draft-block' },
    history: [{ stage: 'needs-clarification', at: '2026-09-01T00:00:00Z', detail: 'failed after 3 attempts' }],
  });
  // the ONLY shipped task: different source AND different parent -> score 0, fallback tier
  writeTask(dir, 'done', {
    id: 'win-unrelated',
    source: 'manual',
    promptContext: { rawText: 'unrelated shipped task', decomposedFrom: 'some-legacy-project' },
    mergedAt: '2026-09-01T00:00:00Z',
    history: [{ stage: 'applied', at: '2026-09-01T00:00:00Z' }],
  });

  const b = buildForensicBundle({ pipelineDir: dir, dbPath: undefined, subject: { kind: 'task', key: 'fail-spec' } });
  assert.equal(b.winnerContrastAvailable, true, 'a score-0 shipped fallback winner must be available (hard-skip revert -> 0 winners)');
  assert.ok(b.winnerTasks.length >= 1, 'winner set must not be empty when a shipped (unmatched) sibling exists');
  assert.equal(b.winnerTasks[0].id, 'win-unrelated', 'the fallback winner must be selected');
  assert.equal(b.winnerTasks[0].source, 'manual');
});

test('matched winner outranks the fallback: score-0 tasks never join a non-empty matched pool', () => {
  const dir = makePipeline();
  writeTask(dir, 'needs-clarification', {
    id: 'fail-spec',
    source: 'wiki_page_promote',
    promptContext: { rawText: 'promote the spec page', decomposedFrom: 'product_spec_outline' },
    needsClarification: { reason: 'retryable-draft-block' },
    history: [{ stage: 'needs-clarification', at: '2026-09-01T00:00:00Z' }],
  });
  // score-1 matched winner (same source), OLDER mergedAt
  writeTask(dir, 'done', {
    id: 'win-matched',
    source: 'wiki_page_promote',
    promptContext: { rawText: 'smaller promote', decomposedFrom: 'other-parent' },
    mergedAt: '2026-01-01T00:00:00Z',
    history: [{ stage: 'applied', at: '2026-01-01T00:00:00Z' }],
  });
  // score-0 candidate (different source AND different parent), NEWER mergedAt
  writeTask(dir, 'done', {
    id: 'win-fallback',
    source: 'manual',
    promptContext: { rawText: 'unrelated shipped task', decomposedFrom: 'some-legacy-project' },
    mergedAt: '2026-06-01T00:00:00Z',
    history: [{ stage: 'applied', at: '2026-06-01T00:00:00Z' }],
  });

  const b = buildForensicBundle({ pipelineDir: dir, dbPath: undefined, subject: { kind: 'task', key: 'fail-spec' } });
  assert.equal(b.winnerContrastAvailable, true);
  assert.equal(b.winnerTasks[0].id, 'win-matched', 'the matched winner must outrank the (newer) fallback candidate');
  assert.equal(b.winnerTasks.length, 1, 'the score-0 fallback must not join a non-empty matched pool');
  assert.ok(b.winnerTasks.every((w) => w.id !== 'win-fallback'), 'fallback candidate excluded when a matched winner exists');
});

test('MAX_WINNERS is exactly 5: 7 matched shipped winners -> exactly 5 in winnerTasks', () => {
  const dir = makePipeline();
  writeTask(dir, 'needs-clarification', {
    id: 'fail-spec',
    source: 'wiki_page_promote',
    promptContext: { rawText: 'promote the spec page', decomposedFrom: 'product_spec_outline' },
    needsClarification: { reason: 'retryable-draft-block' },
    history: [{ stage: 'needs-clarification', at: '2026-09-01T00:00:00Z' }],
  });
  for (let n = 1; n <= 7; n += 1) {
    writeTask(dir, 'done', {
      id: `win-${n}`,
      source: 'wiki_page_promote',
      promptContext: { rawText: `winner ${n}`, decomposedFrom: 'other-parent' },
      mergedAt: `2026-09-01T00:00:0${n}Z`,
      history: [{ stage: 'applied', at: `2026-09-01T00:00:0${n}Z` }],
    });
  }

  const b = buildForensicBundle({ pipelineDir: dir, dbPath: undefined, subject: { kind: 'task', key: 'fail-spec' } });
  assert.equal(b.winnerContrastAvailable, true);
  assert.equal(b.winnerTasks.length, 5, `expected exactly 5 winners (MAX_WINNERS), got ${b.winnerTasks.length} -- fails if MAX_WINNERS is reverted to 3`);
});
