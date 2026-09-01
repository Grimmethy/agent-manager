'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildForensicBundle, findTaskRecordById, readModelCallsForTasks,
  collectSubjectTasks, selectWinners, assembleText,
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
