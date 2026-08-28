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
  './maintenance/observability-scan.js': { functions: ['scanProject', 'findSilentCatchBlocks', 'findUnguardedLoops', 'findOtelNamingViolations', 'hasOtelDependency', 'findMissingReservedAttributes'] },
  './maintenance/performance-scan.js': { functions: ['scanProject', 'findLoopBodyIssues', 'findJsonDeepCloneAntipattern'] },
  './maintenance/function-length-scan.js': { functions: ['scanProject', 'findLongFunctions', 'maxFunctionLines'] },
  './maintenance/scan-utils.js': { functions: ['listSourceFiles', 'isLikelyMinified', 'lineOfIndex', 'extractBraceBody'] },
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

test('plugin API: DIRECT_TO_MAIN literals in task-sources.js and apply-task.js agree', () => {
  const fs = require('fs');
  const path = require('path');
  const grab = (file) => {
    const m = fs.readFileSync(path.join(__dirname, file), 'utf8').match(/DIRECT_TO_MAIN_SOURCES\s*=\s*new Set\(\[([^\]]+)\]\)/);
    return m ? new Set(m[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1))) : null;
  };
  const a = grab('task-sources.js');
  const b = grab('apply-task.js');
  assert.ok(a && b, 'both files must still declare a DIRECT_TO_MAIN_SOURCES literal');
  assert.deepEqual([...a].sort(), [...b].sort(), 'task-sources.js and apply-task.js DIRECT_TO_MAIN_SOURCES must match (see docs/PLUGIN_API.md "Known warts")');
});
