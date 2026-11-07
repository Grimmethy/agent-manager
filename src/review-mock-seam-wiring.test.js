'use strict';

// HUB0321: the mock-seam check as wired into review-task.js (the inline block in runReview, gated by AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK = false | advisory | block, default advisory).
// The detector itself is tested in src/review-mock-seam.test.js; this file drives the whole review with the detector's own fixture diffs.
// Run: node --test src/review-mock-seam-wiring.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same load-time setup as review-content-overlap.test.js (review-task.js reads these at require time).
process.env.AGENT_MANAGER_REPO_ROOT = os.tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false';
process.env.AGENT_MANAGER_REVIEW_INERT_CHECK = 'false';
process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE = 'false';
process.env.AGENT_MANAGER_REVIEW_UNDEFINED_CHECK = 'false';
process.env.AGENT_MANAGER_REVIEW_OVERLAP_CHECK = 'false';
require('./task-sources.js');
const { reviewTask } = require('./review-task.js');

const FIXTURES = path.join(__dirname, '..', 'tests', 'fixtures', 'mock-seam');
const flaggedDiff = fs.readFileSync(path.join(FIXTURES, 'fixture_flagged.diff'), 'utf8');
const cleanDiff = fs.readFileSync(path.join(FIXTURES, 'fixture_not_flagged.diff'), 'utf8');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-seam-review-test-'));
  const repoRoot = path.join(dir, 'repo'); fs.mkdirSync(repoRoot, { recursive: true });
  const domainsPath = path.join(dir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  return { repoRoot, domainsPath };
}
function adhocTask(overrides = {}) {
  return {
    id: 'mock-seam-task', domain: 'default', source: 'manual', title: 'Change processMessage', planResponse: '1. Change it.',
    implementResponse: '{"mode":"edit","file":"foo.js","find":"doThing()","replace":"doOther()"}',
    acceptanceCriteria: ['it works'], acceptanceResults: [{ criterion: 'it works', check: '`node --test src/a.test.js`', result: 'PASS', pass: true }],
    rawDiff: flaggedDiff, ...overrides,
  };
}
const approve = (captured) => async ({ prompt }) => { captured.push(prompt); return { confident: true, verdict: 'APPROVE', votes: [{ verdict: 'APPROVE', reasoning: 'looks correct and complete' }] }; };
async function withMode(mode, fn) {
  const prev = process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK;
  if (mode === undefined) delete process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK; else process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK = mode;
  try { await fn(); } finally { if (prev === undefined) delete process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK; else process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK = prev; }
}
const run = (task) => { const { repoRoot, domainsPath } = fixture(); const captured = []; return reviewTask(task, { repoRoot, domainsPath, localMajorityVote: approve(captured), recordModelOutcome: () => {} }).then((result) => ({ result, captured })); };

test('advisory (the default): the seam is recorded on the task and noted in the history, and the vote still happens', async () => {
  await withMode(undefined, async () => {
    const task = adhocTask();
    const { result, captured } = await run(task);
    assert.equal(result.verdict, 'approved');
    assert.equal(captured.length, 1, 'the vote ran');
    assert.ok(task.mockSeams && task.mockSeams.count > 0);
    assert.ok(task.mockSeams.seams.some((s) => s.changedFn === 'processMessage'));
    const note = task.history.find((h) => h.stage === 'advisory' && /mock-seam check/.test(h.detail));
    assert.ok(note, 'an advisory history event names the check');
    assert.match(note.detail, /processMessage/);
    assert.equal(task.history.some((h) => h.stage === 'blocked'), false);
  });
});

test("an explicit 'advisory' behaves like the default", async () => {
  await withMode('advisory', async () => {
    const task = adhocTask({ id: 'mock-seam-explicit' });
    const { result } = await run(task);
    assert.equal(result.verdict, 'approved');
    assert.ok(task.mockSeams.count > 0);
  });
});

test('block mode: a deterministic blocked verdict names the changed function, the reason is recorded and no vote is spent', async () => {
  await withMode('block', async () => {
    const task = adhocTask({ id: 'mock-seam-block' });
    const { result, captured } = await run(task);
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.blockedStage, 'review');
    assert.match(result.blockedReason, /Mock seam detected: \d+ function\(s\) changed in production but mocked in tests \(.*processMessage/);
    assert.equal(captured.length, 0, 'no vote');
    assert.equal(task.reviewProvider, 'deterministic-mock-seam');
    assert.ok(task.history.some((h) => h.stage === 'blocked' && /Mock seam detected/.test(h.detail)));
    assert.ok(task.mockSeams.count > 0);
  });
});

test('block mode with several seams: the reason names every changed function, comma separated', async () => {
  await withMode('block', async () => {
    const partialDiff = fs.readFileSync(path.join(FIXTURES, 'fixture_partial.diff'), 'utf8');
    const task = adhocTask({ id: 'mock-seam-two', rawDiff: `${flaggedDiff}\n${partialDiff}` });
    const { result } = await run(task);
    assert.equal(result.verdict, 'blocked');
    assert.equal(task.mockSeams.count, 2);
    assert.match(result.blockedReason, /Mock seam detected: 2 function\(s\) changed in production but mocked in tests \(processMessage, calculateScore\)\. Review requires/);
  });
});

test("'false' never looks at the diff: nothing is recorded and the vote runs", async () => {
  await withMode('false', async () => {
    const task = adhocTask({ id: 'mock-seam-off' });
    const { result, captured } = await run(task);
    assert.equal(result.verdict, 'approved');
    assert.equal(captured.length, 1);
    assert.equal(task.mockSeams, undefined);
    assert.equal(task.history.some((h) => /mock-seam check/.test(h.detail)), false);
  });
});

test('a diff the detector does not flag, an empty diff and a diff that is not a string leave no trace in any mode', async () => {
  for (const mode of [undefined, 'advisory', 'block']) {
    await withMode(mode, async () => {
      for (const [name, diff] of [['clean', cleanDiff], ['empty', ''], ['whitespace', '  \n'], ['not a string', null]]) {
        const task = adhocTask({ id: `mock-seam-none-${name}`, rawDiff: diff });
        const { result } = await run(task);
        assert.equal(result.verdict, 'approved', `${name} / ${mode}`);
        assert.equal(task.mockSeams, undefined, `${name} / ${mode}`);
      }
    });
  }
});

test('the detector is not registered as a deterministic review kind (nothing ever selects that kind, so it could never run)', () => {
  const registry = require('./decompose-review-registry.js');
  assert.equal(registry.verifyDeterministicDraft({ promptContext: { deterministicApply: 'mock-seam-check' }, rawDiff: flaggedDiff }, os.tmpdir()), null);
});

test('the setting is read from the config: default advisory, any other value passes through', () => {
  const { getConfig } = require('./config.js');
  const prev = process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK;
  try {
    delete process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK;
    assert.equal(getConfig().reviewMockSeamCheck, 'advisory');
    process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK = 'block';
    assert.equal(getConfig().reviewMockSeamCheck, 'block');
    process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK = 'false';
    assert.equal(getConfig().reviewMockSeamCheck, 'false');
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK; else process.env.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK = prev;
  }
});
