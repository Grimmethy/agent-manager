'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// config.js throws at load unless a repo root is set; the test has no real consumer repo, so point it at this checkout.
process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
const { isDeterministicChecklist, runPlanPass } = require('./local-draft.js');

const CHECKLIST = [
  'src/foo.js exports bar and `node -e "require(\'./src/foo.js\')"` exits 0',
  'src/foo.test.js contains a case for bar returning 42',
  'src/foo.js contains the string "bar"',
];

function makeTask(overrides = {}) {
  return {
    id: 'test-plan-skip',
    source: 'adhoc',
    title: 'test',
    promptContext: { acceptanceCriteria: CHECKLIST, rawText: 'In src/foo.js add bar. In src/foo.test.js add a test.' },
    history: [],
    ...overrides,
  };
}

test('a 3-item deterministic checklist is recognised', () => {
  assert.equal(isDeterministicChecklist(makeTask()), true);
});

test('a checklist with only 2 items is not skipped', () => {
  assert.equal(isDeterministicChecklist(makeTask({ promptContext: { acceptanceCriteria: CHECKLIST.slice(0, 2) } })), false);
});

test('a checklist with one non-deterministic item is not skipped', () => {
  const criteria = [CHECKLIST[0], CHECKLIST[1], 'the code feels clean and well organised'];
  assert.equal(isDeterministicChecklist(makeTask({ promptContext: { acceptanceCriteria: criteria } })), false);
});

test('a _planCritiqueRevised task still runs the plan pass (not skipped)', () => {
  assert.equal(isDeterministicChecklist(makeTask({ _planCritiqueRevised: true })), false);
});

test('a skipped plan writes a plan-done history event with the skip prefix', async () => {
  const task = makeTask();
  const attempt = {};
  let modelCalls = 0;
  const result = await runPlanPass(task, {
    maybeLocked: (_l, fn) => fn(),
    resolvedCallIsLocal: false,
    resolvedLocalCall: async () => { modelCalls += 1; return { text: '' }; },
    profileSupportsThink: false,
    attempt,
    runOrientPassFn: async () => ({ skipped: true, turnsUsed: 0 }),
  });
  assert.equal(result.blocked, false);
  assert.equal(modelCalls, 0);
  const ev = task.history.find((e) => e.stage === 'plan-done');
  assert.ok(ev, 'expected a plan-done history event');
  assert.match(JSON.stringify(ev), /skipped plan pass: deterministic checklist/);
});
