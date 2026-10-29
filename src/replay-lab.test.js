'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./replay-lab.js');

const mkTask = (id, disposition, impl, source = 'change_review') => ({ id, source, promptContext: { rawText: id }, terminalDisposition: disposition, implementResponse: impl, planResponse: 'p', draftAttempts: [{ lane: 'worker-3090', outcome: 'succeeded' }], history: [{ stage: 'x' }] });

test('classifyRecorded splits recorded outcomes into positive / noop / dismissed / other', () => {
  assert.equal(L.classifyRecorded({ terminalDisposition: 'merged' }), 'positive');
  assert.equal(L.classifyRecorded({ terminalDisposition: 'pending-merge' }), 'positive');
  assert.equal(L.classifyRecorded({ terminalDisposition: 'filed' }), 'positive');
  assert.equal(L.classifyRecorded({ terminalDisposition: 'noop' }), 'noop');
  assert.equal(L.classifyRecorded({ terminalDisposition: 'dismissed' }), 'dismissed');
  assert.equal(L.classifyRecorded({}), 'other');
});

test('buildCorpus over-samples positives, is reproducible for a seed, scrubs run state and skips other sources', () => {
  const tasks = [];
  for (let i = 0; i < 6; i++) tasks.push(mkTask(`pos${i}`, 'merged', 'a real finding about the diff, with enough text to count'));
  for (let i = 0; i < 40; i++) tasks.push(mkTask(`noop${i}`, 'noop', 'No concerns.'));
  tasks.push(mkTask('other-src', 'merged', 'x'.repeat(100), 'arch_review'));
  const a = L.buildCorpus({ source: 'change_review', limit: 10, positiveShare: 0.5, tasks });
  const b = L.buildCorpus({ source: 'change_review', limit: 10, positiveShare: 0.5, tasks });
  assert.deepEqual(a.entries.map((e) => e.id), b.entries.map((e) => e.id), 'same seed, same corpus');
  assert.equal(a.counts.selected, 10);
  assert.equal(a.entries.filter((e) => e.klass === 'positive').length, 5, 'half the corpus is positives even though they are 13% of the pool');
  assert.ok(!a.entries.some((e) => e.id === 'other-src'));
  assert.equal(a.entries[0].task.draftAttempts, undefined, 'run state scrubbed');
  assert.equal(a.entries[0].recorded.lane, 'worker-3090');
  assert.notDeepEqual(L.buildCorpus({ source: 'change_review', limit: 10, positiveShare: 0.5, seed: 'other', tasks }).entries.map((e) => e.id), a.entries.map((e) => e.id));
  assert.equal(L.buildCorpus({ source: 'change_review', limit: 10, tasks: [] }).entries.length, 0);
});

test('isNullish / compareOutputs: a nothing-to-flag answer is recognised; verdict shape and text similarity are reported', () => {
  assert.equal(L.isNullish('No concerns.'), true);
  assert.equal(L.isNullish(''), true);
  assert.equal(L.isNullish('FALSE POSITIVE -- the guard on line 12 already handles this'), true);
  assert.equal(L.isNullish('The diff drops the null check on line 40 of src/foo.js, so callers that pass undefined will now throw.'), false);
  const c = L.compareOutputs('change_review', 'No concerns.', 'The diff drops the null check on line 40 of src/foo.js, so callers will throw.');
  assert.equal(c.sameVerdictShape, false);
  assert.equal(c.recordedNullish, true);
  assert.equal(c.replayedNullish, false);
  assert.equal(L.compareOutputs('change_review', 'same text here ok', 'same text here ok').similarity, 1);
});

test('brain_dump_sort comparer scores the decision fields and notes an unparseable replay', () => {
  const rec = JSON.stringify({ secondBrainPath: 'agent-manager/x.md', actionable: true, belongsToProject: 'agent-manager', requiresResearch: false });
  const rep = JSON.stringify({ secondBrainPath: 'Projects/agent-manager/x.md', actionable: true, belongsToProject: 'agent-manager', requiresResearch: false });
  assert.deepEqual(L.compareOutputs('brain_dump_sort', rec, rep).fields, { parseable: true, actionable: true, belongsToProject: true, topFolder: false, requiresResearch: true });
  assert.deepEqual(L.compareOutputs('brain_dump_sort', rec, 'not json').fields, { parseable: false });
});

const entry = (id, klass, rec) => ({ id, klass, task: { id, source: 'change_review', promptContext: {} }, recorded: { implementResponse: rec } });
const stub = (map) => async (task) => {
  const r = map[task.id] || {};
  if (r.fail) return { ok: false, result: { succeeded: false, reason: r.fail }, task: { draftAttempts: [{ outcome: 'error', reason: r.fail }] }, durationMs: 1000, lane: { id: 'worker-rx580', model: 'small:8b', tier: 8 } };
  return { ok: true, result: { succeeded: true, blocked: false }, task: { implementResponse: r.text, draftAttempts: [{ outcome: 'succeeded' }] }, durationMs: r.ms || 2000, lane: { id: 'worker-rx580', model: 'small:8b', tier: 8 } };
};

test('runReplay + summarize: recall on positives and false positives on noops are the headline, not overall agreement', async () => {
  const FINDING = 'The diff drops the null check on line 40 of src/foo.js, so callers passing undefined will now throw.';
  const corpus = {
    source: 'change_review', counts: {},
    entries: [
      entry('p1', 'positive', FINDING), entry('p2', 'positive', FINDING), entry('p3', 'positive', FINDING), entry('p4', 'positive', FINDING),
      entry('n1', 'noop', 'No concerns.'), entry('n2', 'noop', 'No concerns.'), entry('n3', 'noop', 'No concerns.'), entry('n4', 'noop', 'No concerns.'),
    ],
  };
  // The "lazy" model: says nothing to flag everywhere -> 100% agreement on noops, 0% recall.
  const lazy = await L.runReplay({ corpus, laneId: 'worker-rx580', dryRun: stub(Object.fromEntries(corpus.entries.map((e) => [e.id, { text: 'No concerns.' }]))) });
  assert.equal(lazy.summary.gatePassRate, 1);
  assert.equal(lazy.summary.recallOnPositives, 0);
  assert.equal(lazy.summary.falsePositiveRateOnNoops, 0);
  assert.equal(lazy.summary.verdictShapeAgreement, 0.5, 'looks half-right on overall agreement while useless');
  // A decent model: finds 3 of 4, one noop flagged, one timeout.
  const map = { p1: { text: FINDING }, p2: { text: FINDING }, p3: { text: FINDING }, p4: { text: 'No concerns.' }, n1: { text: 'No concerns.' }, n2: { text: 'No concerns.' }, n3: { text: FINDING }, n4: { fail: 'Ollama request timed out after 300000ms' } };
  const good = await L.runReplay({ corpus, laneId: 'worker-rx580', dryRun: stub(map) });
  assert.equal(good.summary.n, 8);
  assert.equal(good.summary.gatePass, 7);
  assert.equal(good.summary.recallOnPositives, 0.75);
  assert.equal(good.summary.falsePositiveRateOnNoops, 0.25);
  assert.deepEqual(good.summary.failures, { timeout: 1 });
  assert.equal(good.lane.id, 'worker-rx580');
});

test('runReplay survives a dry-run that throws and reports progress', async () => {
  const seen = [];
  const r = await L.runReplay({ corpus: { source: 's', counts: {}, entries: [entry('a', 'noop', 'x')] }, dryRun: async () => { throw new Error('boom'); }, onProgress: (s, i, n) => seen.push([s.id, i, n]) });
  assert.equal(r.summary.gatePass, 0);
  assert.deepEqual(seen, [['a', 1, 1]]);
});

test('evaluatePromotion encodes the design-note gate: corpus size, pass lower bound, recall, false positives, new failure classes, human sample', () => {
  const baseline = { n: 40, gatePassLower: 0.85, recallOnPositives: 0.9, falsePositiveRateOnNoops: 0.05, positives: 20, failures: { timeout: 1 } };
  const good = { n: 40, gatePassLower: 0.82, recallOnPositives: 0.85, falsePositiveRateOnNoops: 0.1, positives: 20, failures: { timeout: 2 } };
  assert.deepEqual(L.evaluatePromotion({ candidate: good, baseline, humanSample: { reviewed: 10, passed: 10 } }), { promote: true, reasons: [] });
  const bad = L.evaluatePromotion({ candidate: { n: 12, gatePassLower: 0.5, recallOnPositives: 0.3, falsePositiveRateOnNoops: 0.4, positives: 5, failures: { degenerate: 3 } }, baseline, humanSample: null });
  assert.equal(bad.promote, false);
  for (const needle of ['insufficient corpus', 'gate pass lower bound', 'recall on positives', 'false-positive rate', 'failure classes', 'human sample not done']) {
    assert.ok(bad.reasons.some((r) => r.includes(needle)), `reasons should mention ${needle}: ${bad.reasons.join(' | ')}`);
  }
  assert.equal(L.evaluatePromotion({ candidate: good, baseline, humanSample: { reviewed: 10, passed: 7 } }).promote, false, 'human sample must pass 90%');
  assert.ok(L.evaluatePromotion({ candidate: { ...good, positives: 0, recallOnPositives: null }, baseline, humanSample: { reviewed: 10, passed: 10 } }).reasons.some((r) => r.includes('no positive examples')));
  assert.equal(L.evaluatePromotion({ candidate: { n: 40, gatePassLower: 0.9, recallOnPositives: 0.9, positives: 10, failures: {} }, humanSample: { reviewed: 10, passed: 10 } }).promote, true, 'absolute floors without a baseline');
});

test('writeReport writes json + markdown that name the lane, the headline numbers and the worrying cases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-report-'));
  const corpus = { source: 'change_review', counts: { pool: 2 }, entries: [entry('p1', 'positive', 'The diff drops the null check on line 40 of src/foo.js, so callers will throw.'), entry('n1', 'noop', 'No concerns.')] };
  const report = await L.runReplay({ corpus, laneId: 'worker-rx580', dryRun: stub({ p1: { text: 'No concerns.' }, n1: { fail: 'Ollama request timed out' } }) });
  const file = L.writeReport(dir, report);
  assert.ok(file.endsWith('.json'));
  const md = fs.readFileSync(file.replace(/\.json$/, '.md'), 'utf8');
  assert.match(md, /Replay: change_review on worker-rx580/);
  assert.match(md, /recall on recorded positives: \*\*0\*\*/);
  assert.match(md, /`p1` \(positive\): replay said nothing to flag/);
  assert.match(md, /`n1` \(noop\): timeout/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).summary.n, 2);
});


test('a field-scored source (brain_dump_sort) reports per-field agreement, not recall / false positives, and the gate judges the worst field', async () => {
  const rec = JSON.stringify({ secondBrainPath: 'agent-manager/x.md', actionable: true, belongsToProject: 'agent-manager', requiresResearch: false });
  const same = rec;
  const off = JSON.stringify({ secondBrainPath: 'Projects/x.md', actionable: false, belongsToProject: 'agent-manager', requiresResearch: false });
  const mk = (id, klass) => ({ id, klass, task: { id, source: 'brain_dump_sort', promptContext: {} }, recorded: { implementResponse: rec } });
  const corpus = { source: 'brain_dump_sort', counts: {}, entries: [mk('a', 'positive'), mk('b', 'positive'), mk('c', 'noop'), mk('d', 'noop')] };
  const r = await L.runReplay({ corpus, laneId: 'worker-rx580', dryRun: stub({ a: { text: same }, b: { text: same }, c: { text: same }, d: { text: off } }) });
  assert.equal(r.summary.fieldScored, true);
  assert.equal(r.summary.recallOnPositives, null);
  assert.equal(r.summary.falsePositiveRateOnNoops, null);
  assert.deepEqual(r.summary.fieldAgreement.actionable, { agree: 3, n: 4, rate: 0.75 });
  assert.match(L.renderMarkdown(r), /field-scored source/);
  const verdict = L.evaluatePromotion({ candidate: { ...r.summary, n: 40 }, humanSample: { reviewed: 10, passed: 10 } });
  assert.equal(verdict.promote, false);
  assert.ok(verdict.reasons.some((x) => x.includes('field "actionable" agrees only 0.75')), verdict.reasons.join(' | '));
});
