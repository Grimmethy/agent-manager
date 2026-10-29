'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deterministicPlanSplit, repairEnabled, planStepsOf } = require('./plan-step-split.js');

const PLAN = `PLAN
1. Create src/a.js with the helper. It reads the file.
2. Wire the helper into src/b.js before the existing call.
3. Add tests in src/a.test.js covering the empty case.

CRITERIA:
- the helper exists
- the tests pass`;

test('deterministicPlanSplit: numbered steps become ordered pieces, each waiting for the previous one', () => {
  const task = { id: 't1', title: 'Add helper', planResponse: PLAN, promptContext: { rawText: 'Please add the helper.' } };
  const { subTasks } = deterministicPlanSplit(task);
  assert.equal(subTasks.length, 3);
  assert.equal(subTasks[0].title, 'Create src/a.js with the helper.');
  assert.equal(subTasks[0].after, undefined);
  assert.equal(subTasks[1].after, 0);
  assert.equal(subTasks[2].after, 1);
  assert.match(subTasks[1].rawText, /Part 2 of 3 of the parent task "Add helper"/);
  assert.match(subTasks[1].rawText, /Wire the helper into src\/b\.js/);
  assert.match(subTasks[1].rawText, /Please add the helper\./);
  assert.doesNotMatch(subTasks[2].rawText, /the helper exists/, 'the CRITERIA block is not a step');
});

test('deterministicPlanSplit: bold numbering, "1)" numbering and wrapped continuation lines', () => {
  const plan = '**1.** First thing\n   continues here\n**2.** Second thing\n3) Third thing';
  assert.deepEqual(planStepsOf(plan), ['First thing\ncontinues here', 'Second thing', 'Third thing']);
});

test('deterministicPlanSplit: more than five steps are merged into five balanced pieces', () => {
  const plan = Array.from({ length: 8 }, (_, i) => `${i + 1}. Step number ${i + 1}.`).join('\n');
  const { subTasks } = deterministicPlanSplit({ id: 'big', planResponse: plan });
  assert.equal(subTasks.length, 5);
  const sizes = subTasks.map((s) => (s.rawText.match(/^\d+\. Step number/gm) || []).length);
  assert.deepEqual(sizes, [2, 2, 2, 1, 1]);
});

test('deterministicPlanSplit: null when there is no usable plan or only one step', () => {
  assert.equal(deterministicPlanSplit({ id: 'none' }), null);
  assert.equal(deterministicPlanSplit({ id: 'one', planResponse: '1. Only step' }), null);
  assert.equal(deterministicPlanSplit({ id: 'prose', planResponse: 'just some prose, no numbering' }), null);
});

test('deterministicPlanSplit: falls back to lastGoodPlan and clips a huge parent request', () => {
  const task = { id: 'lg', title: 'T', lastGoodPlan: PLAN, promptContext: { rawText: 'x'.repeat(5000) } };
  const { subTasks } = deterministicPlanSplit(task);
  assert.equal(subTasks.length, 3);
  assert.ok(subTasks[0].rawText.length < 2200, 'the parent request is clipped to 1500 chars');
});

test('repairEnabled: only AGENT_MANAGER_DECOMPOSE_REPAIR=off disables it', () => {
  const prev = process.env.AGENT_MANAGER_DECOMPOSE_REPAIR;
  try {
    delete process.env.AGENT_MANAGER_DECOMPOSE_REPAIR;
    assert.equal(repairEnabled(), true);
    process.env.AGENT_MANAGER_DECOMPOSE_REPAIR = 'off';
    assert.equal(repairEnabled(), false);
    process.env.AGENT_MANAGER_DECOMPOSE_REPAIR = 'on';
    assert.equal(repairEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_DECOMPOSE_REPAIR; else process.env.AGENT_MANAGER_DECOMPOSE_REPAIR = prev;
  }
});
