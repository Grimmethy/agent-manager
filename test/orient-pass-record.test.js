'use strict';

// HUB0280-03: runOrientPass records its model call in model_calls (it runs through runPlanWithTools, which local-client.js call() never sees).
// runPlan and recordModelCall are injected stubs; nothing here touches a model or a real model-stats.db.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runOrientPass } = require('../src/orient-pass.js');

process.env.LOCAL_MODEL = process.env.LOCAL_MODEL || 'test-model'; // labelFor() returns it; recordCall needs a non-empty model

const task = (extra = {}) => ({ id: 'T-orient-1', source: 'manual', domain: 'default', title: 't', promptContext: { rawText: 'orient this' }, ...extra });
const weak = { text: '', anchorPaths: [], grepHits: [] };
const covering = { text: 'GREP HITS:\nsrc/foo.js:1: function updateFooCache() {}', anchorPaths: [], grepHits: [{ file: 'src/foo.js', line: 1, text: 'function updateFooCache() {}' }] };
const planResult = { response: 'CURRENT STATE: x', toolCallLog: [], turnsUsed: 3, prompt_eval_count: 900, eval_count: 120, eval_duration: 4e9 };

test('a run records exactly one orient row with the summed tokens, task id, source and a latency', async () => {
  const rows = [];
  const r = await runOrientPass(task(), { grounding: weak, runPlan: async () => planResult, recordModelCall: (row) => rows.push(row) });
  assert.equal(r.skipped, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskId, 'T-orient-1');
  assert.equal(rows[0].stage, 'orient');
  assert.equal(rows[0].source, 'manual');
  assert.equal(rows[0].result.prompt_eval_count, 900);
  assert.equal(rows[0].result.eval_count, 120);
  assert.ok(rows[0].latencyMs >= 0);
  assert.equal(rows[0].model, process.env.LOCAL_MODEL);
  assert.ok(!Number.isNaN(Date.parse(rows[0].startedAt)));
});

test('the skip path (grounding already covers the task) records nothing', async () => {
  const rows = [];
  const r = await runOrientPass(task({ promptContext: { rawText: 'fix updateFooCache in src/foo.js' } }), { grounding: covering, runPlan: async () => planResult, recordModelCall: (row) => rows.push(row) });
  assert.equal(r.skipped, true);
  assert.equal(rows.length, 0);
});

test('a throwing runPlan records nothing and still returns the grounding fallback', async () => {
  const rows = [];
  const r = await runOrientPass(task(), { grounding: weak, runPlan: async () => { throw new Error('model down'); }, recordModelCall: (row) => rows.push(row) });
  assert.equal(r.skipped, true);
  assert.match(r.error, /model down/);
  assert.equal(rows.length, 0);
});

test('a task without an id records nothing', async () => {
  const rows = [];
  await runOrientPass(task({ id: undefined }), { grounding: weak, runPlan: async () => planResult, recordModelCall: (row) => rows.push(row) });
  assert.equal(rows.length, 0);
});

test('a throwing recordModelCall does not change the returned notes', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const ok = await runOrientPass(task(), { grounding: weak, runPlan: async () => planResult, recordModelCall: () => {} });
    const bad = await runOrientPass(task(), { grounding: weak, runPlan: async () => planResult, recordModelCall: () => { throw new Error('db locked'); } });
    assert.deepEqual(bad, ok);
    assert.equal(bad.turnsUsed, 3);
  } finally { console.warn = warn; }
});
