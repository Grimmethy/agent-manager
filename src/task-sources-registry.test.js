'use strict';

// Registry snapshot (roadmap step 1, piece P7.0): the task sources src/task-sources.js registers at load time. P7 moves the source families into
// src/sources/*.js one piece at a time; every move must leave this list unchanged: the same 26 names, in the same order (priority, then registration order),
// with the same priority, scope, next/apply kinds and the same set of config keys (so a flag such as reasoningTier or harnessSearch is not dropped on the move).
// Frozen from the registry as it stood on origin/master b5ac9069. A deliberate new source or flag changes this file in the same commit.

process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR || require('node:os').tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');
require('./task-sources.js');
const { getRegisteredSources } = require('./task-source-registry.js');
const { taskPriority } = require('./lib/task-priority.js');

// [name, default priority, scope, typeof next, typeof apply, sorted config keys]
const FROZEN = [
  ["adhoc", 10, null, "function", "function", "apply,dependencyRelease,hubOrder,name,next,priority,reasoningTier,reportClass,reviewCompletenessQuestion,reviewGuidance"],
  ["research_task", 10, null, "function", "undefined", "name,next,priority,reasoningTier"],
  ["product_spec_section", 13, null, "function", "undefined", "candidateDocTitle,candidateFulfillment,candidatesPath,harnessSearch,name,next,priority"],
  ["product_spec_outline", 14, null, "function", "function", "apply,emptyApproval,harnessSearch,name,next,priority"],
  ["product_spec", 15, null, "function", "undefined", "name,next,priority"],
  ["backlog_fulfillment", 16, null, "function", "undefined", "candidateDocTitle,candidateFulfillment,candidatesPath,emptyApproval,name,next,priority"],
  ["backlog_decomposition", 17, null, "function", "function", "apply,name,next,priority"],
  ["trouble_log", 20, null, "function", "undefined", "name,next,priority"],
  ["secondbrain", 40, null, "function", "undefined", "name,next,priority"],
  ["brain_dump_sort", 42, null, "function", "undefined", "deterministicReview,deterministicReviewValidate,modelProfile,name,next,priority,reportClass,strictOutputOnly"],
  ["brain_dump_disposition", 43, null, "function", "undefined", "deterministicReview,deterministicReviewValidate,modelProfile,name,next,priority,reportClass,requiresWorktree,strictOutputOnly"],
  ["pipeline_forensics_fix", 43, "core", "function", "undefined", "candidateDocTitle,candidateFulfillment,candidatesPath,harnessSearch,name,next,noCandidateSplit,postImplementCheck,priority,reportClass,reviewGuidance,scope"],
  ["brain_dump_resolution_check", 44, null, "function", "function", "apply,deterministicReview,deterministicReviewValidate,modelProfile,name,next,priority,reportClass,strictOutputOnly"],
  ["pipeline_forensics", 44, "core", "function", "function", "advisoryProse,apply,directToMain,harnessSearch,name,next,priority,reasoningTier,reportClass,reviewCompletenessQuestion,reviewGuidance,scope"],
  ["path_prefetch_resolve", 45, null, "function", "undefined", "name,next,priority,reportClass,strictOutputOnly"],
  ["derived_task", 48, null, "function", "function", "apply,dependencyRelease,hubOrder,name,next,priority,reasoningTier,reportClass,reviewCompletenessQuestion,reviewGuidance"],
  ["ui_visibility_audit", 63, "core", "function", "undefined", "emptyApproval,harnessSearch,name,next,priority,scope"],
  ["pipeline_self_audit", 65, "core", "function", "undefined", "emptyApproval,harnessSearch,name,next,priority,scope"],
  ["doc_drift_fix", 68, "core", "function", "undefined", "harnessSearch,name,next,priority,reasoningTier,reportClass,reviewCompletenessQuestion,reviewGuidance,scope"],
  ["deep_dive", 82, null, "function", "undefined", "emptyApproval,name,next,postImplementCheck,priority,reportClass,reviewGuidance,skipImplementWhenNoRealFiles"],
  ["project_search", 85, null, "function", "undefined", "emptyApproval,expiry,harnessSearch,name,next,preValidateCitedPaths,priority,reportClass,reviewGuidance"],
  ["pipeline_health_audit", 90, "core", "function", "undefined", "emptyApproval,harnessSearch,name,next,priority,scope"],
  ["staleness_audit", 91, null, "function", "function", "advisoryProse,apply,harnessSearch,name,next,priority,reviewCompletenessQuestion,reviewGuidance"],
  ["second_brain_opportunities", 93, null, "function", "function", "advisoryProse,apply,name,next,priority,reportClass"],
  ["pipeline_debrief", 95, "core", "function", "function", "advisoryProse,apply,harnessSearch,name,next,postImplementCheck,priority,reasoningTier,reportClass,reviewCompletenessQuestion,reviewGuidance,scope"],
  ["capability_debrief", 96, "core", "function", "function", "advisoryProse,apply,harnessSearch,name,next,priority,probe,reasoningTier,reportClass,reviewCompletenessQuestion,reviewGuidance,scope"],
];

function snapshot() {
  return getRegisteredSources().map((c) => [c.name, c.priority, c.scope || null, typeof c.next, typeof c.apply, Object.keys(c).sort().join(',')]);
}

test('the registry holds the same sources in the same order with the same priority, scope, next/apply kinds and config keys', () => {
  const frozen = FROZEN.map(([name, def, scope, next, apply, keys]) => [name, taskPriority(name, def), scope, next, apply, keys]);
  assert.deepEqual(snapshot(), frozen);
});

test('the registry has exactly the 26 frozen source names, each once', () => {
  const names = getRegisteredSources().map((c) => c.name);
  assert.equal(names.length, 26);
  assert.equal(new Set(names).size, 26);
  assert.deepEqual([...names].sort(), FROZEN.map((r) => r[0]).sort());
});

test('the core-scope sources are the eight that audit agent-manager itself, and their next() is still a function after the scope wrapper', () => {
  const core = getRegisteredSources().filter((c) => c.scope === 'core').map((c) => c.name).sort();
  assert.deepEqual(core, ['capability_debrief', 'doc_drift_fix', 'pipeline_debrief', 'pipeline_forensics', 'pipeline_forensics_fix', 'pipeline_health_audit', 'pipeline_self_audit', 'ui_visibility_audit']);
  for (const c of getRegisteredSources().filter((s) => s.scope === 'core')) assert.equal(typeof c.next, 'function');
});
