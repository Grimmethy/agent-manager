'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { searchTasksTool, queueReviewedTaskTool } = require('../src/local-tool-task-tools.js');
const { DUPLICATE_SCORE } = require('../src/task-similarity.js');

// Builds a throwaway pipeline dir with the given candidate task records in queue/pending.
function makePipeline(records = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'similar-gate-test-'));
  const pending = path.join(dir, 'queue', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  for (const rec of records) {
    fs.writeFileSync(path.join(pending, `${rec.id}.json`), JSON.stringify(rec));
  }
  const domains = path.join(dir, 'domains.json');
  fs.writeFileSync(domains, JSON.stringify({ default: {} }));
  return { dir, domains };
}

// Stub for the rankTasks seam: returns a fixed ranking for the candidate ids in `hits`.
// Each hit: { score, matchedOn, source, phrase }. `source` undefined means the ranker reports no source.
function stubRank(hits) {
  return (query, docs) => docs
    .filter((d) => hits[d.id])
    .map((d) => ({
      id: d.id,
      score: hits[d.id].score,
      matchedOn: hits[d.id].matchedOn,
      source: hits[d.id].source,
      sharesDistinctivePhrase: hits[d.id].phrase,
    }));
}

const HIGH = DUPLICATE_SCORE + 1;

function queue(dir, domains, rank, title = 'Fix the frobnicator retry loop') {
  return queueReviewedTaskTool(dir, { title, description: 'Retry loop never backs off.' }, {
    projects: [],
    rankTasks: rank,
    defaultDomainsPath: domains,
  });
}

function historyEvents(dir, id, stage) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'pending', `${id}.json`), 'utf8'));
  return (data.history || []).filter((h) => h.stage === stage).map((h) => (
    typeof h.detail === 'string' ? JSON.parse(h.detail) : h.detail
  ));
}

test('unknown-source near-duplicate queues', () => {
  const { dir, domains } = makePipeline([{ id: 'cand-unknown', title: 'Fix the frobnicator retry loop', status: 'pending' }]);
  const r = queue(dir, domains, stubRank({ 'cand-unknown': { score: HIGH, matchedOn: 'title', source: undefined, phrase: true } }));
  assert.ok(!r.error, r.error);
  assert.ok(r.queuedTaskId);
  assert.equal(r.dismissedAsDuplicateOf, undefined);
});

test('cross-source high score queues', () => {
  const { dir, domains } = makePipeline([{ id: 'cand-chat', title: 'Fix the frobnicator retry loop', status: 'pending', source: 'chat' }]);
  const r = queue(dir, domains, stubRank({ 'cand-chat': { score: HIGH, matchedOn: 'title', source: 'chat', phrase: true } }));
  assert.ok(!r.error, r.error);
  assert.ok(r.queuedTaskId);
  assert.equal(r.dismissedAsDuplicateOf, undefined);
});

test('id-only match queues even from the same source', () => {
  const { dir, domains } = makePipeline([{ id: 'cand-id', title: 'Unrelated wording', status: 'pending', source: 'manual' }]);
  const r = queue(dir, domains, stubRank({ 'cand-id': { score: HIGH, matchedOn: 'id', source: 'manual', phrase: true } }));
  assert.ok(!r.error, r.error);
  assert.ok(r.queuedTaskId);
  assert.equal(r.dismissedAsDuplicateOf, undefined);
});

test('same-source score at or above DUPLICATE_SCORE with distinctive phrase is dismissed and recorded', () => {
  const { dir, domains } = makePipeline([{ id: 'cand-dup', title: 'Fix the frobnicator retry loop', status: 'pending', source: 'manual' }]);
  const r = queue(dir, domains, stubRank({ 'cand-dup': { score: HIGH, matchedOn: 'title', source: 'manual', phrase: true } }));
  assert.equal(r.dismissedAsDuplicateOf, 'cand-dup');
  assert.equal(r.queuedTaskId, undefined);
  const events = historyEvents(dir, 'cand-dup', 'duplicate-dismissed');
  assert.equal(events.length, 1);
  assert.equal(events[0].candidateId, 'cand-dup');
  assert.equal(events[0].score, HIGH);
  assert.equal(events[0].sharesDistinctivePhrase, true);
  assert.equal(events[0].source, 'manual');
});

test('a near-miss is recorded as near-miss and still queues', () => {
  const { dir, domains } = makePipeline([{ id: 'cand-near', title: 'Fix the frobnicator retry loop', status: 'pending', source: 'manual' }]);
  const r = queue(dir, domains, stubRank({ 'cand-near': { score: HIGH, matchedOn: 'body', source: 'manual', phrase: false } }));
  assert.ok(!r.error, r.error);
  assert.ok(r.queuedTaskId);
  assert.equal(r.dismissedAsDuplicateOf, undefined);
  const events = historyEvents(dir, 'cand-near', 'near-miss');
  assert.equal(events.length, 1);
  assert.equal(events[0].candidateId, 'cand-near');
  assert.equal(historyEvents(dir, 'cand-near', 'duplicate-dismissed').length, 0);
});

test('same-source high score without distinctive phrase queues', () => {
  const { dir, domains } = makePipeline([{ id: 'cand-generic', title: 'Fix the frobnicator retry loop', status: 'pending', source: 'manual' }]);
  const r = queue(dir, domains, stubRank({ 'cand-generic': { score: HIGH, matchedOn: 'body', source: 'manual', phrase: false } }));
  assert.ok(!r.error, r.error);
  assert.ok(r.queuedTaskId);
  assert.equal(r.dismissedAsDuplicateOf, undefined);
});

test('searchTasksTool with similar omitted returns no score or matchedOn keys', () => {
  const { dir } = makePipeline([{ id: 'filler-a', title: 'Filler frobnicator task', status: 'pending', promptContext: { rawText: 'nothing' } }]);
  const r = searchTasksTool(dir, { query: 'frobnicator' });
  assert.ok(!r.error, r.error);
  assert.ok(r.results.length > 0);
  for (const hit of r.results) {
    assert.ok(!('score' in hit));
    assert.ok(!('matchedOn' in hit));
  }
});
