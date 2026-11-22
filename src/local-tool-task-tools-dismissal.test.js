'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { queueReviewedTaskTool } = require('./local-tool-task-tools.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dismiss-'));
  const pipelineDir = path.join(root, 'pipeline');
  const adhoc = path.join(pipelineDir, 'queue', 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  const candPath = path.join(adhoc, 'cand-1.json');
  fs.writeFileSync(candPath, JSON.stringify({ id: 'cand-1', source: 'manual', title: 'Fix the widget', promptContext: { rawText: 'widget body' } }));
  const domainsPath = path.join(root, 'domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({ general: {} }));
  return { root, pipelineDir, candPath, domainsPath };
}

function run(s, ranked, extra = {}) {
  const opts = { projects: [], defaultDomainsPath: s.domainsPath, duplicateScore: 8, rankTasks: () => ranked, ...extra };
  return queueReviewedTaskTool(s.pipelineDir, { title: 'Fix the widget now', description: 'widget details' }, opts);
}

const hit = (over = {}) => ({ id: 'cand-1', score: 9, matchedOn: 'phrase', sharesDistinctivePhrase: true, source: 'manual', ...over });
const history = (s) => JSON.parse(fs.readFileSync(s.candPath, 'utf8')).history || [];
const adhocCount = (s) => fs.readdirSync(path.dirname(s.candPath)).length;

test('same source, high score, phrase: dismissed with event', () => {
  const s = setup();
  const r = run(s, [hit()]);
  assert.strictEqual(r.dismissedAsDuplicateOf, 'cand-1');
  assert.strictEqual(adhocCount(s), 1);
  const h = history(s);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].stage, 'duplicate-dismissed');
  const d = JSON.parse(h[0].detail);
  for (const k of ['newTitle', 'candidateId', 'score', 'matchedOn', 'sharesDistinctivePhrase', 'source']) assert.ok(k in d, k);
});

test('protected case: unknown source queues', () => {
  const s = setup();
  const r = run(s, [hit()], { source: null });
  assert.ok(r.queuedTaskId);
  assert.strictEqual(adhocCount(s), 2);
});

test('different source queues with near-miss', () => {
  const s = setup();
  const r = run(s, [hit({ source: 'bot' })]);
  assert.ok(r.queuedTaskId);
  assert.strictEqual(history(s)[0].stage, 'near-miss');
});

test('matchedOn id queues with near-miss', () => {
  const s = setup();
  assert.ok(run(s, [hit({ matchedOn: 'id' })]).queuedTaskId);
  assert.strictEqual(history(s)[0].stage, 'near-miss');
});

test('no distinctive phrase queues', () => {
  const s = setup();
  assert.ok(run(s, [hit({ sharesDistinctivePhrase: false })]).queuedTaskId);
  assert.strictEqual(history(s)[0].stage, 'near-miss');
});

test('score below threshold queues with no event', () => {
  const s = setup();
  assert.ok(run(s, [hit({ score: 7.9 })]).queuedTaskId);
  assert.strictEqual(history(s).length, 0);
});

test('rankTasks throwing queues', () => {
  const s = setup();
  const r = run(s, [], { rankTasks: () => { throw new Error('boom'); } });
  assert.ok(r.queuedTaskId);
});

test('history writer throwing does not change dismissal', () => {
  const s = setup();
  const r = run(s, [hit()], { appendHistoryEvent: () => { throw new Error('nope'); } });
  assert.strictEqual(r.dismissedAsDuplicateOf, 'cand-1');
  assert.strictEqual(adhocCount(s), 1);
});
