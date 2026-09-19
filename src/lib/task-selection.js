'use strict';

// task-selection.js -- extracted from src/task-sources.js ([[hub-task-integration]] node-module decompose).

const path = require('path');
const { registerTaskSource, getRegisteredSources, resolveSourceName } = require('../task-source-registry.js');
const { getConfig } = require('../config.js');
const { activeRepoIsCore, sourceEligibleHere } = require('./source-scope.js');
const { nextCandidateFulfillmentTask, windowFetchedFileContent } = require('../sdk/candidate-fulfillment.js');

function nextProductSpecSectionTask() {
  const { productSpecOutlineCandidatesPath, productSpecPath, repoRoot } = getConfig();
  const task = nextCandidateFulfillmentTask(productSpecOutlineCandidatesPath, 'product_spec_section');
  // nextCandidateFulfillmentTask is generic and doesn't know the spec doc path the edit
  // must target -- add it here so productSpecSectionImplementPrompt can name `file`.
  if (task) task.promptContext.specRelPath = path.relative(repoRoot, productSpecPath);
  return task;
}

function getNextTask() {
  const { taskSourceAllowlist } = getConfig();
  const restricted = taskSourceAllowlist && taskSourceAllowlist.length > 0;
  const coreActive = activeRepoIsCore();
  for (const source of getRegisteredSources()) {
    // scope:'core' sources audit agent-manager itself -- skip them on any other project (source-scope.js).
    if (!sourceEligibleHere(source, coreActive)) continue;
    // 'adhoc' is a fixed contract (README: "preempts every deterministic source") --
    // an allowlist restricting this run to e.g. just project_search should still let an
    // explicitly human-queued adhoc task through, not silently swallow it. 'brain_dump_sort'
    // is documented (see app.py's _ALWAYS_ENSURE_DOMAINS) as an always-on background source,
    // independent of whichever project's pipeline mode is active -- a mode-scoped allowlist
    // like Project Search's [project_search, deep_dive] should never be able to silently
    // pause it, since Brain Dump is meant to sit above any single active project.
    const alwaysAllowed = source.name === 'adhoc' || source.name === 'brain_dump_sort';
    if (restricted && !alwaysAllowed && !taskSourceAllowlist.includes(source.name)) continue;
    if (typeof source.next !== 'function') continue;
    const task = source.next();
    if (!task) continue;
    return task;
  }
  return null;
}

module.exports = { nextProductSpecSectionTask, getNextTask };
