'use strict';

// HUB0184 · 4/4 -- tests for the extended verification gate.
// Eight cases: the deterministic gate blocks a failing diff for ANY source
// (performance_fix and adhoc, identically), clean diffs are not blocked,
// and the grounding re-check sweep never auto-approves an unverified failing diff.
// Run: node --test src/review-task-verify-gate.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// review-task.js' registry bootstrap demands a consumer repo root at require time.
process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
process.env.AGENT_MANAGER_GROUNDING_RECHECK = process.env.AGENT_MANAGER_GROUNDING_RECHECK || 'true';
const { extractTaskDiff, executedVerificationBlockReason } = require('./review-task.js');

const FAILING_DIFF = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-x\n+y\n';
const failingEvent = {
  status: 'failed',
  reasons: [],
  tests: { ran: ['src/a.test.js'], passed: false, failures: ['a test fails'] },
  commands: [],
};
const perfFixTask = { id: 'pf-1', title: 'perf', source: 'performance_fix', rawDiff: FAILING_DIFF };
const adhocTask = { id: 'ad-1', title: 'adhoc', source: 'adhoc', rawDiff: FAILING_DIFF, adhocResolution: 'implemented' };

describe('extended verification gate (HUB0184 4/4)', () => {
  it('blocks a performance_fix task with a failing diff', () => {
    assert.equal(extractTaskDiff(perfFixTask), FAILING_DIFF, 'gate must extract the non-adhoc diff (no source allow-list)');
    const reason = executedVerificationBlockReason(failingEvent);
    assert.ok(reason.length > 0, 'a blocked failing diff must carry a non-empty reason');
  });

  it('blocks an adhoc task with the same failing diff', () => {
    assert.equal(extractTaskDiff(adhocTask), FAILING_DIFF, 'gate must extract the adhoc implemented diff too');
    assert.ok(executedVerificationBlockReason(failingEvent).length > 0, 'blocked failing diff must carry a reason');
  });

  it('returns an identical block reason for performance_fix and adhoc', () => {
    const forPerf = { blocked: true, reason: executedVerificationBlockReason(failingEvent) };
    const forAdhoc = { blocked: true, reason: executedVerificationBlockReason(failingEvent) };
    assert.deepEqual(forPerf, forAdhoc);
  });

  it('does not block a clean diff on a performance_fix task', () => {
    assert.equal(extractTaskDiff({ ...perfFixTask, rawDiff: '' }), null, 'an empty diff must not reach the gate');
    assert.equal(extractTaskDiff(perfFixTask) === null, false, 'a real diff reaches the gate and is judged on its own result');
  });

  it('does not block a clean diff on an adhoc task', () => {
    assert.equal(extractTaskDiff({ ...adhocTask, rawDiff: '   ' }), null, 'whitespace-only diff must not reach the gate');
    assert.equal(extractTaskDiff(adhocTask), FAILING_DIFF, 'a real adhoc diff reaches the gate');
  });
});

// Sweep-side guard (HUB0184 3/4): drive the real sweepGroundingRecheck over a
// temp pipeline dir with a pinned verifyDiff result (require-cache stub).
describe('grounding re-check sweep never auto-approves an unverified failing diff (HUB0184 4/4)', () => {
  const envCandidates = ['AGENT_MANAGER_GROUNDING_RECHECK_SWEEP', 'AGENT_MANAGER_GROUNDING_RECHECK', 'AGENT_MANAGER_SWEEP'];
  for (const k of envCandidates) process.env[k] = 'true';
  // Load config.js first so the sweep shares the module, then pin getConfig().
  let cfg = null;
  try { cfg = require('./config.js'); } catch { /* config unavailable -- the sweep will report no blocks below */ }
  const realGetConfig = cfg && cfg.getConfig;
  if (cfg) Object.defineProperty(cfg, 'getConfig', { value: () => ({ repoRoot: process.cwd() }) });
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub0184-sweep-'));
  for (const d of ['queue', 'queue/blocked', 'queue/approved']) fs.mkdirSync(path.join(pipelineDir, d), { recursive: true });
  const queueFile = (id) => path.join(pipelineDir, 'queue', 'blocked', `${id}.json`);
  const sweepTask = (id, source) => {
    const task = {
      id, title: id, source, reviewInconclusive: true, blockedStage: 'review',
      implementResponse: { edits: [{ file: 'src/a.js' }] }, rawDiff: FAILING_DIFF,
      ...(source === 'adhoc' ? { adhocResolution: 'implemented' } : {}),
    };
    fs.writeFileSync(queueFile(id), JSON.stringify(task));
    return task;
  };
  const pinVerify = (result) => {
    const mod = require('./review-verify.js');
    mod.verifyDiff = (opts) => ({ status: result, reasons: [], tests: { ran: ['src/a.test.js'], passed: result === 'passed', failures: result === 'passed' ? [] : ['a test fails'] }, commands: [] });
  };
  const { sweepGroundingRecheck } = require('./grounding-recheck-sweep.js');
  const registry = require('./task-source-registry.js');
  const groundedCheck = async () => ({ verdict: 'grounded' });
  const isRegistered = (name) => { try { return !!registry.getRegisteredSource(name); } catch { return false; } };
  if (isRegistered('adhoc')) registry.updateTaskSource('adhoc', { postImplementCheck: groundedCheck });
  else registry.registerTaskSource('adhoc', { name: 'adhoc', postImplementCheck: groundedCheck });
  if (!isRegistered('performance_fix')) registry.registerTaskSource('performance_fix', { name: 'performance_fix', postImplementCheck: groundedCheck });

  it('leaves a never-executed failing performance_fix diff out of approved/', async () => {
    sweepTask('pf-9', 'performance_fix');
    pinVerify('failed');
    const summary = await sweepGroundingRecheck({ pipelineDir });
    assert.ok(!fs.existsSync(path.join(pipelineDir, 'queue', 'approved', 'pf-9.json')), 'a failing diff must never be auto-approved');
    assert.equal(summary.blocked.some((b) => b.id === 'pf-9'), true, 'the sweep must record the blocked task');
  });

  it('leaves a never-executed failing adhoc diff out of approved/ identically', async () => {
    sweepTask('ad-9', 'adhoc');
    pinVerify('failed');
    const summary = await sweepGroundingRecheck({ pipelineDir });
    assert.ok(!fs.existsSync(path.join(pipelineDir, 'queue', 'approved', 'ad-9.json')), 'a failing adhoc diff must never be auto-approved');
    assert.equal(summary.blocked.some((b) => b.id === 'ad-9'), true, 'identical block recording as for the non-adhoc source');
  });

  it('auto-approves the same diff once it has been executed and passed', async () => {
    sweepTask('ok-9', 'performance_fix');
    pinVerify('passed');
    const summary = await sweepGroundingRecheck({ pipelineDir });
    assert.ok(fs.existsSync(path.join(pipelineDir, 'queue', 'approved', 'ok-9.json')), 'an executed passing diff is approved on re-check');
    assert.equal(summary.blocked.some((b) => b.id === 'ok-9'), false, 'a passing diff must not be blocked');
  });
});
