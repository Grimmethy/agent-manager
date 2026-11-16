'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { deepDivePlanPrompt, archImportPlanPrompt, archImportImplementPrompt, consumerLabel } = require('../src/prompts.js');
const { deepDiveImplementPrompt } = require('../src/lib/prompt-implementation.js');

function deepDiveTask(consumerProject) {
  return { promptContext: {
    projectName: 'science-of-imagination',
    communityName: 'Procedural quests',
    communityId: 7,
    consumerProject,
    files: [{ path: 'src/quest.py', degree: 3, content: 'def quest(): pass' }],
  } };
}

function archImportTask(consumerProject) {
  return { promptContext: {
    sourceProject: 'science-of-imagination',
    rating: 'Adapt',
    itemTitle: 'Quest graph pruning',
    itemFiles: 'src/quest.py',
    itemRationale: 'Prunes unreachable quest nodes.',
    consumerProject,
    harnessHits: [{ file: 'src/quests.py', line: 4, text: 'def build()', query: 'quest build' }],
    harnessFiles: [{ path: 'src/quests.py', content: 'def build(): pass' }],
  } };
}

test('deep_dive plan prompt names questforge and not agent-manager', () => {
  const out = deepDivePlanPrompt(deepDiveTask('questforge'));
  assert.ok(out.includes('questforge'));
  assert.ok(!out.includes('agent-manager'));
});

test('deep_dive implement prompt names questforge and not agent-manager', () => {
  const out = deepDiveImplementPrompt(deepDiveTask('questforge'), 'PLAN');
  assert.ok(out.includes('questforge'));
  assert.ok(!out.includes('agent-manager'));
});

test('arch_import plan prompt names questforge and not agent-manager', () => {
  const out = archImportPlanPrompt(archImportTask('questforge'));
  assert.ok(out.includes('questforge'));
  assert.ok(!out.includes('agent-manager'));
});

test('arch_import implement prompt names questforge and not agent-manager', () => {
  const out = archImportImplementPrompt(archImportTask('questforge'), 'PLAN');
  assert.ok(out.includes('questforge'));
  assert.ok(!out.includes('agent-manager'));
});

test('default consumer keeps the agent-manager wording', () => {
  const plan = deepDivePlanPrompt(deepDiveTask('agent-manager'));
  assert.ok(plan.includes('"agent-manager"'));
  assert.ok(plan.includes('local-LLM-driven task pipeline'));
  const arch = archImportPlanPrompt(archImportTask('agent-manager'));
  assert.ok(arch.includes('agent-manager'));
});

test('consumerLabel prefers promptContext.consumerProject, trimmed', () => {
  assert.strictEqual(consumerLabel(deepDiveTask('  questforge ')), 'questforge');
});
