'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractFinalAnswer, gradeExact, gradeNumeric, gradeRegex, extractMetrics, summarize, slugify } = require('./reasoning-bench.js');

test('extractFinalAnswer pulls the answer after a rambling chain-of-thought', () => {
  const text = 'Let me think step by step... 1.10 - 1.00 = 0.10, divided by 2...\nFINAL ANSWER: 0.05';
  assert.equal(extractFinalAnswer(text), '0.05');
});

test('extractFinalAnswer uses the LAST occurrence if the model repeats the line', () => {
  const text = 'FINAL ANSWER: wrong draft\nActually wait, let me redo this.\nFINAL ANSWER: correct';
  assert.equal(extractFinalAnswer(text), 'correct');
});

test('extractFinalAnswer returns null when the model never emits the marker', () => {
  assert.equal(extractFinalAnswer('I think the answer is five cents.'), null);
});

test('gradeExact is case/punctuation-insensitive', () => {
  assert.equal(gradeExact('Ada.', 'ada').pass, true);
  assert.equal(gradeExact('bo', 'ada').pass, false);
  assert.equal(gradeExact(null, 'ada').pass, false);
});

test('gradeNumeric parses plain numbers within tolerance', () => {
  assert.equal(gradeNumeric('35', 35, 0).pass, true);
  assert.equal(gradeNumeric('34.999', 35, 0.01).pass, true);
  assert.equal(gradeNumeric('34.9', 35, 0.01).pass, false);
});

test('gradeNumeric parses fractions like "22/35"', () => {
  const g = gradeNumeric('22/35', 22 / 35, 0.0001);
  assert.equal(g.pass, true);
});

test('gradeNumeric fails cleanly on unparseable text', () => {
  const g = gradeNumeric('unclear', 35, 0);
  assert.equal(g.pass, false);
  assert.match(g.reason, /could not parse/);
});

test('gradeRegex ignores whitespace and case in the ordering answer', () => {
  const g = gradeRegex('A, B, C, D, E', '^A,(B,C,D,E|B,C,E,D|C,B,D,E|C,B,E,D|C,E,B,D)$');
  assert.equal(g.pass, true);
});

test('gradeRegex rejects an order that violates a prerequisite', () => {
  const g = gradeRegex('D,A,B,C,E', '^A,(B,C,D,E|B,C,E,D|C,B,D,E|C,B,E,D|C,E,B,D)$');
  assert.equal(g.pass, false);
});

function metricsFixture(tokensPerSecond) {
  return { tokensPerSecond, evalCount: null, evalDurationMs: null, loadDurationMs: null, promptEvalCount: null, promptEvalDurationMs: null, totalDurationMs: null, doneReason: null, thinkingChars: 0 };
}

test('summarize computes objective pass counts and judge averages per model', () => {
  const cases = [
    { id: 'a', category: 'math' },
    { id: 'b', category: 'causal-reasoning' },
  ];
  const results = [
    { model: 'm1', caseId: 'a', category: 'math', grader: 'numeric', latencyMs: 100, degenerate: null, grade: { pass: true }, metrics: metricsFixture(30) },
    { model: 'm1', caseId: 'b', category: 'causal-reasoning', grader: 'judge', latencyMs: 200, degenerate: null, grade: { pass: true, score: 0.8 }, metrics: metricsFixture(null) },
    { model: 'm2', caseId: 'a', category: 'math', grader: 'numeric', latencyMs: 150, degenerate: 'empty', grade: { pass: false }, metrics: metricsFixture(null) },
    { model: 'm2', caseId: 'b', category: 'causal-reasoning', grader: 'judge', latencyMs: 250, degenerate: null, grade: { pass: false, score: 0.2 }, metrics: metricsFixture(10) },
  ];
  const summary = summarize(results, ['m1', 'm2'], cases, {});

  assert.equal(summary.m1.objectivePassed, 1);
  assert.equal(summary.m1.objectiveTotal, 1);
  assert.equal(summary.m1.avgJudgeScore, 0.8);
  assert.equal(summary.m1.degenerateCount, 0);
  assert.equal(summary.m1.avgTokensPerSec, 30);

  assert.equal(summary.m2.objectivePassed, 0);
  assert.equal(summary.m2.avgJudgeScore, 0.2);
  assert.equal(summary.m2.degenerateCount, 1);
});

test('summarize handles a model with zero judge-graded cases without dividing by zero', () => {
  const cases = [{ id: 'a', category: 'math' }];
  const results = [
    { model: 'm1', caseId: 'a', category: 'math', grader: 'numeric', latencyMs: 100, degenerate: null, grade: { pass: true }, metrics: metricsFixture(null) },
  ];
  const summary = summarize(results, ['m1'], cases, {});
  assert.equal(summary.m1.avgJudgeScore, null);
  assert.equal(summary.m1.judgeTotal, 0);
  assert.equal(summary.m1.avgTokensPerSec, null);
});

test('summarize surfaces per-model load/unload timings from modelTimings', () => {
  const cases = [{ id: 'a', category: 'math' }];
  const results = [
    { model: 'm1', caseId: 'a', category: 'math', grader: 'numeric', latencyMs: 100, degenerate: null, grade: { pass: true }, metrics: metricsFixture(null) },
  ];
  const summary = summarize(results, ['m1'], cases, { m1: { loadDurationMs: 5000, unloadDurationMs: 200 } });
  assert.equal(summary.m1.loadDurationMs, 5000);
  assert.equal(summary.m1.unloadDurationMs, 200);
});

test('extractMetrics converts Ollama\'s nanosecond fields to ms and computes tokens/sec', () => {
  const m = extractMetrics({ total_duration: 12_000_000_000, load_duration: 500_000_000, prompt_eval_count: 70, prompt_eval_duration: 700_000_000, eval_count: 400, eval_duration: 10_000_000_000, done_reason: 'stop', thinking: 'abcde' });
  assert.equal(m.totalDurationMs, 12000);
  assert.equal(m.loadDurationMs, 500);
  assert.equal(m.promptEvalCount, 70);
  assert.equal(m.evalCount, 400);
  assert.equal(m.evalDurationMs, 10000);
  assert.equal(m.tokensPerSecond, 40);
  assert.equal(m.doneReason, 'stop');
  assert.equal(m.thinkingChars, 5);
});

test('extractMetrics tolerates a call result with no perf fields at all (e.g. a call-error fallback)', () => {
  const m = extractMetrics({ response: '', thinking: '' });
  assert.equal(m.tokensPerSecond, null);
  assert.equal(m.loadDurationMs, null);
});

test('slugify makes a model name safe for a filename', () => {
  assert.equal(slugify('qwen3.8:27b-q4_K_M'), 'qwen3.8-27b-q4_K_M');
  assert.equal(slugify('ornith:35b'), 'ornith-35b');
});
