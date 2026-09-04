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
  './task-source-registry.js': { functions: ['registerTaskSource', 'updateTaskSource', 'getRegisteredSource', 'getRegisteredSources', 'clearRegistry'] },
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
