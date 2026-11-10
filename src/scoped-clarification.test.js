// scoped-clarification.test.js -- verify the acceptance criteria for brain-dump task clarification
// Run: node --test src/scoped-clarification.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractStructuredInfo,
  generateQuestions,
  buildScopedTask,
  checkClarificationHistory,
  recordClarificationAttempt,
  clarificationHistoryPath,
  checkStaleClarification,
  processAmbiguousBrainDump
} = require('./scoped-clarification.js');

test('acceptance criterion 1: brain-dump with clear problem description produces scoped work item', () => {
  const rawText = `xpkinds validation silently accepts an empty schema. When a user submits a task with no xpkinds field, the validation passes silently instead of rejecting it. This means tasks can be queued without proper kind specification, leading to downstream failures in task processing.`;
  const title = 'xpkinds validation silently accepts an empty schema';
  const brainDumpEntryId = 'bd-test-001';
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-clar-test-'));

  const result = processAmbiguousBrainDump(rawText, title, brainDumpEntryId, taskDir, null);

  assert.equal(result.action, 'scope', 'should scope the task');
  assert.ok(result.scopedTask, 'should have a scoped task');
  assert.ok(result.scopedTask.hasEnoughInfo, 'should have enough info to scope');
  assert.ok(result.scopedTask.body.includes('Acceptance Criteria'), 'scoped body should include acceptance criteria');
});

test('acceptance criterion 2: every task in needs-clarification has at least one specific question', () => {
  const rawText = `quest orchestration hazard`;
  const title = 'quest orchestration hazard';
  const brainDumpEntryId = 'bd-test-002';
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-clar-test-'));

  const result = processAmbiguousBrainDump(rawText, title, brainDumpEntryId, taskDir, null);

  assert.equal(result.action, 'questions', 'should generate questions when scoping fails');
  assert.ok(Array.isArray(result.questions), 'should have questions array');
  assert.ok(result.questions.length > 0, 'should have at least one question');
  assert.ok(!result.questions.some(q => q.toLowerCase().includes('ambiguous')), 'questions should not contain generic "ambiguous"');
});

test('acceptance criterion 3: task that was clarified and answered leaves needs-clarification', () => {
  const rawText = `anchor change behavior lacks rollback mechanism. When an anchor is changed, the previous state is not preserved.`;
  const title = 'anchor change behavior lacks rollback mechanism';
  const brainDumpEntryId = 'bd-test-003';
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-clar-test-'));

  // First attempt: should generate questions
  const result1 = processAmbiguousBrainDump(rawText, title, brainDumpEntryId, taskDir, null);
  assert.equal(result1.action, 'questions');

  // Simulate user answering questions and re-filing
  const taskFile = path.join(taskDir, 'test-task.json');
  fs.writeFileSync(taskFile, JSON.stringify({
    id: 'test-task',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(), // 1 day ago
    needsClarification: {
      reason: 'clarification-required',
      questions: result1.questions,
      answeredAt: Date.now()
    }
  }));

  // Second attempt: should now scope the task (user provided context)
  const result2 = processAmbiguousBrainDump(rawText, title, brainDumpEntryId, taskDir, taskFile);
  // The task should not be escalated
  assert.notEqual(result2.action, 'escalate', 'should not escalate after user answered');
});

test('acceptance criterion 4: task in needs-clarification beyond 7 days is escalated', () => {
  const rawText = `quest system circular dependency risk`;
  const title = 'quest system circular dependency risk';
  const brainDumpEntryId = 'bd-test-004';
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-clar-test-'));

  // Create a stale task file (8 days old)
  const taskFile = path.join(taskDir, 'test-task.json');
  fs.writeFileSync(taskFile, JSON.stringify({
    id: 'test-task',
    createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
    needsClarification: {
      reason: 'clarification-required',
      questions: ['Question 1?']
    }
  }));

  const result = processAmbiguousBrainDump(rawText, title, brainDumpEntryId, taskDir, taskFile);

  assert.equal(result.action, 'escalate', 'should escalate stale task');
  assert.ok(result.reason.includes('8 days'), 'escalation reason should mention days');
});

test('acceptance criterion 5: previously ambiguous task with same signature is not re-flagged', () => {
  const rawText = `redundant quest generation leads to duplicate work`;
  const title = 'redundant quest generation leads to duplicate work';
  const brainDumpEntryId = 'bd-test-005';
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-clar-test-'));

  // First attempt: mark as ambiguous
  recordClarificationAttempt(taskDir, brainDumpEntryId, 'ambiguous', ['Question 1?']);

  // Second attempt: should escalate because same signature within 7 days
  const result = processAmbiguousBrainDump(rawText, title, brainDumpEntryId, taskDir, null);

  assert.equal(result.action, 'escalate', 'should escalate previously ambiguous task');
  assert.ok(result.reason.includes('previously marked ambiguous'), 'escalation reason should mention previous ambiguity');
});

test('extractStructuredInfo extracts affected component', () => {
  const info = extractStructuredInfo('The wallet module is broken', 'wallet issue');
  assert.ok(info.affectedComponent, 'should extract affected component');
  assert.ok(info.affectedComponent.toLowerCase().includes('wallet'), 'component should include wallet');
});

test('extractStructuredInfo extracts observed behavior', () => {
  const info = extractStructuredInfo('shows an error instead of success', 'observed behavior test');
  assert.ok(info.observedBehavior, 'should extract observed behavior');
});

test('extractStructuredInfo extracts expected behavior', () => {
  const info = extractStructuredInfo('should display the results but shows nothing', 'expected behavior test');
  assert.ok(info.expectedBehavior, 'should extract expected behavior');
});

test('generateQuestions avoids generic "ambiguous" question', () => {
  const questions = generateQuestions('vague text', 'vague title', {
    affectedComponent: null,
    observedBehavior: null,
    expectedBehavior: null,
    concreteExample: null,
    impact: null
  });

  assert.ok(questions.length > 0, 'should generate questions');
  assert.ok(!questions.some(q => q.toLowerCase().includes('ambiguous')), 'should not include generic "ambiguous" question');
});

test('checkClarificationHistory detects re-flagging', () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-clar-test-'));
  const brainDumpEntryId = 'bd-test-006';

  // Record an ambiguous attempt
  recordClarificationAttempt(taskDir, brainDumpEntryId, 'ambiguous', ['Q1?']);

  // Check should detect it
  const historyCheck = checkClarificationHistory(taskDir, brainDumpEntryId);
  assert.ok(historyCheck.shouldEscalate, 'should detect re-flagging');
});

test('checkStaleClarification detects stale tasks', () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-clar-test-'));
  const taskFile = path.join(taskDir, 'test-task.json');

  // Create a stale task (10 days old)
  fs.writeFileSync(taskFile, JSON.stringify({
    id: 'test-task',
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  }));

  const staleCheck = checkStaleClarification(taskFile, taskDir);
  assert.ok(staleCheck.isStale, 'should detect stale task');
  assert.ok(staleCheck.daysOld >= 10, 'should report correct days old');
});

// 2026-11-10: the history file is state, not a task record; inside the needs-clarification state directory it made GET /api/summary answer 500.
function queueWithNeedsClarification() {
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-clar-queue-'));
  const dir = path.join(queue, 'needs-clarification');
  fs.mkdirSync(dir);
  return { queue, dir };
}

test('history for the needs-clarification state directory is written one level up, never inside it', () => {
  const { queue, dir } = queueWithNeedsClarification();
  recordClarificationAttempt(dir, 'bd-h-1', 'ambiguous', ['Q?']);
  assert.equal(clarificationHistoryPath(dir), path.join(queue, 'clarification-history.json'));
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing but task records may live in the state directory');
  const saved = JSON.parse(fs.readFileSync(path.join(queue, 'clarification-history.json'), 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].brainDumpEntryId, 'bd-h-1');
});

test('a legacy history file inside the state directory is read, merged into the new file and removed on the next write', () => {
  const { queue, dir } = queueWithNeedsClarification();
  const legacy = path.join(dir, 'clarification-history.json');
  fs.writeFileSync(legacy, JSON.stringify([{ brainDumpEntryId: 'bd-old', timestamp: Date.now(), signature: 'ambiguous', questions: ['old?'], resolved: false }]));
  const before = checkClarificationHistory(dir, 'bd-old');
  assert.equal(before.shouldEscalate, true, 'the legacy attempt still counts');
  recordClarificationAttempt(dir, 'bd-new', 'ambiguous', ['new?']);
  assert.equal(fs.existsSync(legacy), false, 'the legacy file is gone');
  const saved = JSON.parse(fs.readFileSync(path.join(queue, 'clarification-history.json'), 'utf8'));
  assert.deepEqual(saved.map((h) => h.brainDumpEntryId), ['bd-old', 'bd-new']);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a directory with any other name keeps its own history file, and a corrupt or non-list file counts as empty', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-clar-other-'));
  assert.equal(clarificationHistoryPath(other), path.join(other, 'clarification-history.json'));
  fs.writeFileSync(path.join(other, 'clarification-history.json'), '{not json');
  assert.equal(checkClarificationHistory(other, 'bd-x').shouldEscalate, false);
  fs.writeFileSync(path.join(other, 'clarification-history.json'), '{"a":1}');
  recordClarificationAttempt(other, 'bd-y', 'ambiguous', ['Q?']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'clarification-history.json'), 'utf8')).length, 1);
});

test('history written for the needs-clarification directory is read back: the second attempt sees the first and the same signature escalates', () => {
  const { dir } = queueWithNeedsClarification();
  assert.equal(checkClarificationHistory(dir, 'bd-r-1').shouldEscalate, false);
  recordClarificationAttempt(dir, 'bd-r-1', 'ambiguous', ['first?']);
  assert.equal(checkClarificationHistory(dir, 'bd-r-1').shouldEscalate, true, 'the new location is read');
  recordClarificationAttempt(dir, 'bd-r-2', 'ambiguous', ['second?']);
  const saved = JSON.parse(fs.readFileSync(clarificationHistoryPath(dir), 'utf8'));
  assert.deepEqual(saved.map((h) => h.brainDumpEntryId), ['bd-r-1', 'bd-r-2'], 'the second record keeps the first');
});
