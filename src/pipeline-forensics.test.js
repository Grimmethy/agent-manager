'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  signatureForClarificationTask, coverageEntryActive,
  findClarificationClusters, findLowValueSource, VALUE_COOLDOWN_DAYS,
} = require('./pipeline-forensics.js');

// --- signatureForClarificationTask ------------------------------------------------

test('signatureForClarificationTask: zero-hit harness marker wins', () => {
  const task = {
    source: 'adhoc',
    history: [{ stage: 'harness-search', detail: '3 quer(y/ies), 0 hit(s), 0 file(s)' }],
  };
  assert.equal(signatureForClarificationTask(task), 'adhoc::harness-search-zero-results');
});

test('signatureForClarificationTask: keyword bucket over needsClarification.openQuestions', () => {
  const task = {
    source: 'adhoc',
    needsClarification: { reason: 'design-decision', openQuestions: 'the draft kept fabricating an ungrounded claim about app.py' },
    history: [],
  };
  assert.equal(signatureForClarificationTask(task), 'adhoc::fabricated-ungrounded-claim');
});

test('signatureForClarificationTask: botched-decompose from the terminal history detail', () => {
  const task = {
    source: 'manual',
    needsClarification: { reason: 'design-decision' },
    history: [
      { stage: 'exhausted', detail: '2/2 retries used' },
      { stage: 'needs-clarification', detail: 'chose RESOLUTION: decompose but the sub-task JSON was malformed' },
    ],
  };
  assert.equal(signatureForClarificationTask(task), 'manual::botched-decompose');
});

test('signatureForClarificationTask: turn-budget flag on the task', () => {
  assert.equal(
    signatureForClarificationTask({ source: 'adhoc', turnBudgetExhausted: true, history: [] }),
    'adhoc::turn-budget-exhausted',
  );
});

test('signatureForClarificationTask: a genuinely unique clarification -> null', () => {
  const task = {
    source: 'adhoc',
    needsClarification: { reason: 'ambiguous', openQuestions: 'should the widget be blue or green' },
    history: [{ stage: 'needs-clarification', detail: 'escalated' }],
  };
  assert.equal(signatureForClarificationTask(task), null);
});

// --- coverage --------------------------------------------------------------------

test('coverageEntryActive: no eligibleAgainAt -> active forever; past eligibleAgainAt -> inactive', () => {
  const now = Date.now();
  assert.equal(coverageEntryActive({ reportedAt: 'x' }, now), true);
  assert.equal(coverageEntryActive({ eligibleAgainAt: new Date(now + 1000).toISOString() }, now), true);
  assert.equal(coverageEntryActive({ eligibleAgainAt: new Date(now - 1000).toISOString() }, now), false);
  assert.equal(coverageEntryActive(undefined, now), false);
});

// --- findClarificationClusters --------------------------------------------------

test('findClarificationClusters: groups by signature, honours threshold and coverage', () => {
  const mk = (id, detail) => ({ task: { id, source: 'adhoc', needsClarification: { reason: 'design-decision' }, history: [{ stage: 'needs-clarification', detail }] } });
  const recs = [
    mk('a', 'chose RESOLUTION: decompose but the sub-task JSON was malformed'),
    mk('b', 'RESOLUTION: decompose did not follow with valid json'),
    mk('c', 'RESOLUTION: decompose json malformed'),
    mk('d', 'something totally unique and unrelated'),
  ];
  const clusters = findClarificationClusters(recs, {}, Date.now());
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].signature, 'adhoc::botched-decompose');
  assert.equal(clusters[0].tasks.length, 3);

  const covered = findClarificationClusters(recs, { 'adhoc::botched-decompose': { reportedAt: 'x' } }, Date.now());
  assert.equal(covered.length, 0);
});

// --- findLowValueSource -------------------------------------------------------

test('findLowValueSource: flags a source burning cost with little benefit and nothing shipped', () => {
  const tasks = [];
  for (let i = 0; i < 8; i++) tasks.push({ id: `obs-${i}`, source: 'observability_review', classification: 'filtering', queueState: 'done' });
  const merged = new Set(); // nothing shipped
  const acct = [{ source: 'observability_review', costUsd: 5.5 }, { source: 'adhoc', costUsd: 0.1 }];
  const offender = findLowValueSource(tasks, merged, acct, {}, Date.now());
  assert.equal(offender.source, 'observability_review');
  assert.equal(offender.shipped, 0);
});

test('findLowValueSource: a healthy source (benefit + shipped) is not flagged', () => {
  const tasks = [];
  for (let i = 0; i < 8; i++) tasks.push({ id: `x-${i}`, source: 'adhoc', classification: 'benefit', queueState: 'done' });
  const merged = new Set(['x-0', 'x-1', 'x-2']);
  const acct = [{ source: 'adhoc', costUsd: 9 }];
  assert.equal(findLowValueSource(tasks, merged, acct, {}, Date.now()), null);
});

test('findLowValueSource: respects the value:: cooldown', () => {
  const tasks = [];
  for (let i = 0; i < 8; i++) tasks.push({ id: `p-${i}`, source: 'performance_review', classification: 'filtering', queueState: 'done' });
  const acct = [{ source: 'performance_review', costUsd: 4 }];
  const now = Date.now();
  const coverage = { 'value::performance_review': { eligibleAgainAt: new Date(now + VALUE_COOLDOWN_DAYS * 86400000).toISOString() } };
  assert.equal(findLowValueSource(tasks, new Set(), acct, coverage, now), null);
});

test('findLowValueSource: below the minimum task count -> skipped', () => {
  const tasks = [{ id: 'a', source: 'rare_source', classification: 'filtering', queueState: 'done' }];
  assert.equal(findLowValueSource(tasks, new Set(), [{ source: 'rare_source', costUsd: 99 }], {}, Date.now()), null);
});

// --- nextPipelineForensicsTask (integration, fixture pipeline) ------------------

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-forensics-test-'));
  for (const s of ['pending', 'blocked', 'needs-clarification', 'done', 'forensics-requests', 'worklogs']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}
function write(dir, state, task) {
  fs.writeFileSync(path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task));
}
function freshTaskSources(pipelineDir) {
  const { clearRegistry } = require('./task-source-registry.js');
  const { clearModelProfileRegistry } = require('./model-profile-registry.js');
  const { clearDeterministicRecheckRegistry } = require('./deterministic-recheck-registry.js');
  clearRegistry();
  clearModelProfileRegistry();
  try { clearDeterministicRecheckRegistry(); } catch { /* optional */ }
  for (const m of ['./task-sources.js', './prompts.js', './forensic-bundle.js', './pipeline-forensics.js']) {
    delete require.cache[require.resolve(m)];
  }
  process.env.AGENT_MANAGER_REPO_ROOT = pipelineDir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = pipelineDir;
  const ts = require('./task-sources.js');
  require('./prompts.js');
  return ts;
}

test('nextPipelineForensicsTask: a needs-clarification cluster of 3 yields a well-formed task', () => {
  const dir = makePipeline();
  const loser = (id) => ({
    id, source: 'adhoc', domain: 'adhoc',
    promptContext: { rawText: 'x', decomposedFrom: 'parent-9' },
    needsClarification: { reason: 'design-decision' },
    history: [
      { stage: 'created', at: '2026-08-30T00:00:00Z' },
      { stage: 'needs-clarification', at: '2026-08-30T02:00:00Z', detail: 'chose RESOLUTION: decompose but the sub-task JSON was malformed' },
    ],
    draftAttempts: [{ attemptNo: 1, outcome: 'blocked', tiers: [{ tier: 'local-agentic-write', blocked: true, response: 'could not decompose cleanly' }] }],
  });
  write(dir, 'needs-clarification', loser('l1'));
  write(dir, 'needs-clarification', loser('l2'));
  write(dir, 'needs-clarification', loser('l3'));
  write(dir, 'done', {
    id: 'winner-1', source: 'adhoc', mergedAt: '2026-08-31T00:00:00Z', adhocResolution: 'implemented',
    promptContext: { decomposedFrom: 'parent-9' },
    history: [{ stage: 'applied', at: '2026-08-31T01:00:00Z' }],
    draftAttempts: [{ attemptNo: 1, outcome: 'succeeded', tiers: [{ tier: 'local-agentic-write', resolution: 'implemented', toolCalls: { byTool: { edit_file: 2 } } }] }],
  });

  const ts = freshTaskSources(dir);
  const task = ts.nextPipelineForensicsTask();
  assert.ok(task, 'a task was generated');
  assert.equal(task.source, 'pipeline_forensics');
  assert.equal(task.promptContext.triggerType, 'needs-clarification-cluster');
  assert.equal(task.promptContext.signature, 'adhoc::botched-decompose');
  assert.deepEqual(task.promptContext.winnerIds, ['winner-1']);
  assert.match(task.promptContext.evidenceText, /COUNTERFACTUAL/);
  assert.match(task.promptContext.evidenceText, /WINNER 1/);

  // coverage suppresses a second one
  ts.markPipelineForensicsReported(task);
  assert.equal(ts.nextPipelineForensicsTask(), null);
});

test('nextPipelineForensicsTask: an on-demand SIGNATURE request resolves needs-clarification members (clarification-aware signature)', () => {
  const dir = makePipeline();
  // two members whose generic blockedReason makes signatureForTask() return null, but
  // whose history detail is a botched decompose
  for (const id of ['nc1', 'nc2']) {
    write(dir, 'needs-clarification', {
      id, source: 'adhoc', domain: 'adhoc',
      blockedReason: 'could not get this past review after 3 attempts',
      needsClarification: { reason: 'design-decision' },
      history: [{ stage: 'needs-clarification', detail: 'chose RESOLUTION: decompose but the sub-task JSON was malformed' }],
      draftAttempts: [{ tiers: [{ tier: 'local-agentic-write', response: 'x' }] }],
    });
  }
  fs.writeFileSync(path.join(dir, 'queue', 'forensics-requests', 'sig.json'), JSON.stringify({ signature: 'adhoc::botched-decompose', note: 'study this pattern now' }));

  const ts = freshTaskSources(dir);
  const task = ts.nextPipelineForensicsTask();
  assert.ok(task, 'a task was generated from the signature request');
  assert.equal(task.promptContext.triggerType, 'on-demand');
  assert.equal(task.promptContext.subjectKind, 'signature');
  assert.deepEqual(task.promptContext.loserIds.sort(), ['nc1', 'nc2']);
});

test('nextPipelineForensicsTask: an on-demand request file beats a cluster and is consumed', () => {
  const dir = makePipeline();
  // a cluster exists...
  for (const id of ['c1', 'c2', 'c3']) {
    write(dir, 'needs-clarification', {
      id, source: 'adhoc', needsClarification: { reason: 'design-decision' },
      history: [{ stage: 'needs-clarification', detail: 'RESOLUTION: decompose malformed json' }],
      draftAttempts: [{ tiers: [{ tier: 'local-agentic-write', response: 'x' }] }],
    });
  }
  // ...but an explicit request should win
  write(dir, 'blocked', { id: 'target-task', source: 'adhoc', blockedReason: 'stuck', history: [], draftAttempts: [{ tiers: [{ tier: 'local-agentic-write', response: 'x' }] }] });
  fs.writeFileSync(path.join(dir, 'queue', 'forensics-requests', 'req1.json'), JSON.stringify({ taskId: 'target-task', note: 'look at this one' }));

  const ts = freshTaskSources(dir);
  const task = ts.nextPipelineForensicsTask();
  assert.ok(task);
  assert.equal(task.promptContext.triggerType, 'on-demand');
  assert.equal(task.promptContext.subjectKey, 'target-task');

  ts.markPipelineForensicsReported(task);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'forensics-requests', 'req1.json')), false, 'request file consumed');
});
