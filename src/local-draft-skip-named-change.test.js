'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// config.js throws at load unless a repo root is set; point it at this checkout.
process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
const { skipPlanForNamedChange, applyNamedChangePlanSkip, runPlanPass } = require('./local-draft.js');

const exists = (p) => p === 'src/a.js' || p === 'src/a.test.js';

function makeTask(criteria) {
  return { id: 'test-named-skip', source: 'adhoc', title: 't', promptContext: { acceptanceCriteria: criteria, rawText: 'x' }, history: [] };
}

test('mixed criteria: one named file plus an unnamed README criterion does not skip', () => {
  const d = skipPlanForNamedChange(['src/a.js reads process.env.FOO', 'update the README usage section'], { fileExists: exists });
  assert.equal(d.skip, false);
  assert.equal(d.reason, 'unnamed-criterion');
  assert.deepEqual(d.unmatched, ['update the README usage section']);
});

test('"File X updated" + "Merged into main" does not skip', () => {
  const d = skipPlanForNamedChange(['File X updated', 'Merged into main'], { fileExists: exists });
  assert.equal(d.skip, false);
});

test('single criterion naming an existing file and env var skips', () => {
  const d = skipPlanForNamedChange(['src/a.js reads process.env.FOO'], { fileExists: exists });
  assert.equal(d.skip, true);
  assert.ok(d.targets.includes('src/a.js'));
  assert.ok(d.targets.includes('process.env.FOO'));
});

test('an existing named test file skips', () => {
  assert.equal(skipPlanForNamedChange(['src/a.test.js passes'], { fileExists: exists }).skip, true);
});

test('a path failing the lookup does not skip', () => {
  assert.equal(skipPlanForNamedChange(['src/missing.js is changed'], { fileExists: exists }).skip, false);
});

test('empty criteria does not skip', () => {
  assert.equal(skipPlanForNamedChange([], { fileExists: exists }).skip, false);
});

test('skip: no model call, plan seeded from criteria, skip event recorded', async () => {
  const task = makeTask(['src/a.js reads process.env.FOO']);
  let modelCalls = 0;
  const result = await runPlanPass(task, {
    maybeLocked: (_l, fn) => fn(),
    resolvedCallIsLocal: false,
    resolvedLocalCall: async () => { modelCalls += 1; return { text: '' }; },
    profileSupportsThink: false,
    attempt: {},
    fileExistsFn: exists,
    runOrientPassFn: async () => ({ skipped: true, turnsUsed: 0 }),
  });
  assert.equal(result.blocked, false);
  assert.equal(modelCalls, 0);
  assert.match(task.planResponse, /CRITERIA:\n- src\/a\.js reads process\.env\.FOO/);
  const ev = task.history.find((e) => e.stage === 'plan-skip-named-change');
  assert.ok(ev);
  const s = JSON.stringify(ev);
  assert.match(s, /plan-skipped-named-change/);
  assert.match(s, /reason=all-criteria-named/);
  assert.match(s, /targets=/);
  assert.match(s, /unmatched=/);
});

test('not-skip: returns false and records event with reason and unmatched', () => {
  const task = makeTask(['src/a.js reads process.env.FOO', 'update the README usage section']);
  assert.equal(applyNamedChangePlanSkip(task, {}, exists), false);
  const ev = task.history.find((e) => e.stage === 'plan-skip-named-change');
  assert.ok(ev);
  const s = JSON.stringify(ev);
  assert.match(s, /plan-not-skipped-named-change/);
  assert.match(s, /reason=unnamed-criterion/);
  assert.match(s, /README usage section/);
  assert.equal(task.planResponse, undefined);
});
