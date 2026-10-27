'use strict';

// Tripwire for the out-of-tree plugin API surface (docs/PLUGIN_API.md). An
// AGENT_MANAGER_REGISTER_PATH plugin (agent-manager-hygiene) reaches into agent-manager/src/*
// for these exports; there is no package.json `exports` map stopping a refactor from
// quietly removing one. This test fails HERE, in this repo's CI, instead of silently at the
// plugin's load time. If the surface must change, update it AND docs/PLUGIN_API.md together.

const test = require('node:test');
const assert = require('node:assert/strict');

// module path -> { functions: [...], other: [name -> typeof] }. `other` covers the two
// prompt FRAGMENTS (plain strings the plugin splices into its own templates).
const CONTRACT = {
  './task-source-registry.js': { functions: ['registerTaskSource', 'updateTaskSource', 'getRegisteredSource', 'getRegisteredSources', 'clearRegistry', 'variantParentOf', 'getVariantsOf'] },
  './dry-run.js': { functions: ['dryRunDraft', 'freshTaskForReplay'] },
  './capability-ledger.js': { functions: ['readScorecard', 'buildScorecard', 'annotateVariants'] },
  './lanes.js': { functions: ['getLanes', 'laneById'] },
  './config.js': { functions: ['getConfig', 'resolveGraphPath'] },
  './task-sources.js': { functions: ['nextCandidateFulfillmentTask', 'taskIdExistsInQueue', 'taskPriority', 'windowFetchedFileContent'] },
  './sdk/candidate-fulfillment.js': { functions: ['nextCandidateFulfillmentTask', 'windowFetchedFileContent', 'applyArchDiscoveryCandidates', 'parseArchDiscoveryCandidates', 'nextAvailableCandidateId', 'isEffectivelyEmptyResponse'] },
  './candidate-docs.js': { functions: ['applyArchDiscoveryCandidates', 'parseArchDiscoveryCandidates', 'nextAvailableCandidateId', 'isEffectivelyEmptyResponse'] },
  './apply-group-a.js': { functions: ['applyVerdictOnly'] },
  './prompts.js': {
    functions: [
      'formatFileContents',
      'archReviewPlanPrompt', 'archReviewImplementPrompt',
      'archDiscoveryPlanPrompt', 'archDiscoveryImplementPrompt',
      'archImportPlanPrompt', 'archImportImplementPrompt',
      'unusedExportPlanPrompt',
    ],
    other: { groupBJsonInstructions: 'string', candidateSplitInstructions: 'string' },
  },
  './atomic-write.js': { functions: ['writeAtomicSync', 'writeJsonAtomicSync'] },
  './git-runner.js': { functions: ['detectDefaultBranch'] },
  './deterministic-recheck-registry.js': { functions: ['registerDeterministicRecheck', 'getDeterministicRecheck', 'getRecheckSources', 'clearDeterministicRecheckRegistry'] },
  './model-profile-registry.js': { functions: ['clearModelProfileRegistry'] },
  './apply-adhoc-diff.js': { functions: ['queueSubTasks', 'applyAdhocDiff'] },
  './candidate-split-hub-route.js': { functions: ['setCandidateSplitHubFiler', 'getCandidateSplitHubFiler'] },
  './wiki-content-apply-route.js': { functions: ['setWikiContentApply', 'getWikiContentApply'] },
  './domain-apply-route.js': { functions: ['registerDomainApply', 'getDomainApply', 'clearDomainApplyRegistry'] },
  './decompose-pass-route.js': { functions: ['setDecomposePassRunner', 'getDecomposePassRunner', 'runDecomposePassIfAvailable'] },
  './apply-branch-prep-route.js': { functions: ['setApplyBranchPrep', 'getApplyBranchPrep', 'prepareApplyBranch'] },
  './split-coverage-judging-route.js': { functions: ['setSplitCoverageJudging', 'getSplitCoverageJudging', 'originalAskInjectionLines', 'coverageGuidanceOverride', 'completenessQuestionOverride'] },
  './agentic-draft-common.js': { functions: ['parseSubTaskProposals'] },
  './local-client.js': { functions: ['call'] },
  './claude-client.js': { functions: ['call'] },
  './gpu-guard.js': { functions: ['leaseHeldFor', 'leaseCovers', 'normalizeEndpoint'] },
};

// prompts.js/task-sources.js require AGENT_MANAGER_REPO_ROOT at load (getConfig()).
process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();

for (const [mod, spec] of Object.entries(CONTRACT)) {
  const fns = spec.functions || [];
  const other = spec.other || {};
  test(`plugin API: ${mod} still exports its ${fns.length + Object.keys(other).length} contract name(s)`, () => {
    const loaded = require(mod);
    for (const name of fns) {
      assert.equal(typeof loaded[name], 'function', `${mod} must export ${name} as a function (see docs/PLUGIN_API.md)`);
    }
    for (const [name, t] of Object.entries(other)) {
      assert.equal(typeof loaded[name], t, `${mod} must export ${name} as a ${t} (see docs/PLUGIN_API.md)`);
    }
  });
}

test('plugin API: candidate-docs.js exports are the same objects apply-group-a.js re-exports', () => {
  const cd = require('./candidate-docs.js');
  const ga = require('./apply-group-a.js');
  for (const name of ['applyArchDiscoveryCandidates', 'parseArchDiscoveryCandidates', 'isEffectivelyEmptyResponse']) {
    assert.equal(ga[name], cd[name], `apply-group-a.js's ${name} must be candidate-docs.js's exact function, not a fork`);
  }
});

test('plugin API: apply-task.js reads directToMain off the registry, not a source-name literal (ADR-0022 Stage G)', () => {
  const fs = require('fs');
  const path = require('path');
  const applySrc = fs.readFileSync(path.join(__dirname, 'apply-task.js'), 'utf8');
  assert.doesNotMatch(applySrc, /DIRECT_TO_MAIN_SOURCES\s*=\s*new Set/, 'the source-name literal must be gone');
  assert.match(applySrc, /registered\.directToMain === true/, 'must gate on the registry field');
});

// 2026-10-18 (brain-dump 1904): docs/PLUGIN_API.md's "Reserving a GPU" section is the contract a plugin in ANY language
// follows when it writes the lease file. Its JSON example is parsed here and fed to the pipeline's own reader, so the
// documented semantics and gpu-guard.js cannot drift apart unnoticed.
test('plugin API: the documented GPU lease example is honoured by gpu-guard.js leaseHeldFor', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { leaseHeldFor } = require('./gpu-guard.js');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PLUGIN_API.md'), 'utf8');
  const at = doc.indexOf('## Reserving a GPU and showing the job');
  assert.ok(at !== -1, 'PLUGIN_API.md must keep the "Reserving a GPU and showing the job" section');
  const m = /```json\n([\s\S]*?)\n```/.exec(doc.slice(at));
  assert.ok(m, 'the section must keep its JSON lease example');
  const lease = JSON.parse(m[1]);
  for (const k of ['holder', 'family', 'owner', 'endpoints', 'acquiredAt', 'refreshedAt']) assert.ok(k in lease, `example lease has ${k}`);
  assert.ok(Array.isArray(lease.endpoints) && lease.endpoints.length > 0, 'the example is a scoped lease');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-lease-'));
  const file = path.join(dir, 'lease.json');
  const now = new Date().toISOString();
  const write = (obj) => fs.writeFileSync(file, JSON.stringify({ ...obj, acquiredAt: now, refreshedAt: now }));

  write(lease);
  const listed = lease.endpoints[0];
  assert.equal(leaseHeldFor(listed, file), true, 'the listed card is held');
  assert.equal(leaseHeldFor(listed.replace(/\/\/[^:/]+/, '//10.255.255.1'), file), false, 'another card is not held');

  const { endpoints, ...unscoped } = lease;
  write(unscoped);
  assert.equal(leaseHeldFor('http://10.255.255.1:11434', file), true, 'without endpoints every card is held');

  fs.writeFileSync(file, JSON.stringify(lease)); // the example's own 2026 timestamps: long expired
  assert.equal(leaseHeldFor(listed, file), false, 'an expired lease holds nothing');
});
