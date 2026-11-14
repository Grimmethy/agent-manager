'use strict';

// HUB0274-04: plan and implement prompts for the brain_dump_resolution_check source, registered next to brain_dump_sort in src/prompts.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolutionCheckPlanPrompt, resolutionCheckImplementPrompt } = require('../src/lib/prompt-resolution-check.js');

const TASK = {
  promptContext: {
    rawText: 'the `computeTotal` helper in `src/foo.js` is wrong',
    masterSha: 'abc1234def5678',
    evidencePack: {
      entryText: 'the `computeTotal` helper in `src/foo.js` is wrong',
      citedPaths: [{ path: 'src/foo.js', exists: true, commits: ['4e8054e add "foo" with computeTotal'] }],
      citedIdentifiers: [{ identifier: 'computeTotal', hits: ['abc1234:src/foo.js:1:function computeTotal() {}'] }],
      recentCommits: [],
    },
  },
};

test('the plan prompt contains the note, the master sha and the pack JSON', () => {
  const p = resolutionCheckPlanPrompt(TASK);
  assert.ok(p.includes('NOTE: the `computeTotal` helper in `src/foo.js` is wrong'));
  assert.ok(p.includes('master abc1234def5678'));
  assert.ok(p.includes(JSON.stringify(TASK.promptContext.evidencePack, null, 2)));
  assert.match(p, /ALREADY fixed, or simply untrue/);
  assert.match(p, /"unclear"/);
});

test('the implement prompt carries the plan, the note and the exact JSON instruction with the three allowed values', () => {
  const p = resolutionCheckImplementPrompt(TASK, '1. src/foo.js exists on master');
  assert.ok(p.includes('1. src/foo.js exists on master'));
  assert.ok(p.includes('NOTE: the `computeTotal` helper in `src/foo.js` is wrong'));
  assert.ok(p.includes('{"resolved": "yes" | "no" | "unclear", "evidence": "<a commit hash, a file:line or a quoted commit subject copied exactly from the evidence pack>"}'));
  assert.match(p, /ONLY one JSON object/);
  assert.match(p, /copied exactly from the evidence pack above/);
  assert.match(p, /answer "yes" only when/);
});

test('a pack with quotes and newlines is embedded without breaking the instruction block', () => {
  const task = { promptContext: { rawText: 'x', masterSha: 'm', evidencePack: { recentCommits: ['1a2b3c4 fix "the \\ thing"\nsecond line'] } } };
  const p = resolutionCheckPlanPrompt(task);
  assert.ok(p.includes(JSON.stringify(task.promptContext.evidencePack, null, 2)));
  const impl = resolutionCheckImplementPrompt(task, 'plan');
  assert.ok(impl.includes('ONLY one JSON object'));
  assert.ok(!impl.includes('1a2b3c4'), 'the implement prompt repeats the plan and the note, not the whole pack');
});

test('a task without an evidence pack still produces prompts (empty pack) and never throws', () => {
  assert.doesNotThrow(() => resolutionCheckPlanPrompt({ promptContext: { rawText: 'x' } }));
  assert.doesNotThrow(() => resolutionCheckImplementPrompt({}, 'plan'));
  assert.ok(resolutionCheckPlanPrompt({ promptContext: { rawText: 'x' } }).includes('{}'));
});

test('after requiring src/prompts.js the registered source has both builders attached', () => {
  require('../src/prompts.js');
  const { getRegisteredSource } = require('../src/task-source-registry.js');
  const source = getRegisteredSource('brain_dump_resolution_check');
  assert.strictEqual(typeof source.buildPlanPrompt, 'function');
  assert.strictEqual(typeof source.buildImplementPrompt, 'function');
  assert.strictEqual(source.buildPlanPrompt, resolutionCheckPlanPrompt);
  assert.strictEqual(source.buildImplementPrompt, resolutionCheckImplementPrompt);
});
