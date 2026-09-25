'use strict';

// task-selection.js -- extracted from src/task-sources.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
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

// premiumPriority generation preemption (2026-09-25, live incident: a premium adhoc task and
// its decomposed sub-tasks sat in queue/adhoc/ untouched for 30-90+ minutes each while the
// hygiene family (priority 1-29) kept generating, because AGENT_MANAGER_TASK_PRIORITIES had
// adhoc:40 -- the source-level priority walk below never gave adhoc a turn to GENERATE, and
// premiumPriority only mattered at claim time (next-claimable-task.js's effectivePriority,
// which never sees a task that was never generated). nextAdhocLikeTask() already sorts
// premiumPriority to the front of adhoc's OWN candidates, but that helps nothing if adhoc
// itself is starved at this step. So: a peek (readdirSync + parse only, no generation side
// effects) for the operator-set premium flag, and an immediate, priority-order-independent
// generation -- the same override every other premium-priority mechanism in this codebase
// already provides. Deliberately before the loop and independent of the allowlist
// restriction below: a mode-scoped allowlist must not be able to swallow an explicitly
// operator-pinned task any more than it can a plain adhoc one. Lazy require: task-sources.js
// requires THIS module (line 47), so a top-level require back would be circular.
function hasPremiumPriorityInQueue(queueDir) {
  let entries;
  try {
    entries = fs.readdirSync(queueDir, { withFileTypes: true });
  } catch {
    return false; // no such dir -- nothing queued there
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(queueDir, e.name), 'utf8'));
    } catch {
      continue; // corrupt/partial write -- not a premium flag, the normal walk still sees it
    }
    if (parsed && parsed.premiumPriority === true) return true;
  }
  return false;
}

function premiumPreemptedTask() {
  const { pipelineDir } = getConfig();
  const queueDir = path.join(pipelineDir, 'queue');
  if (hasPremiumPriorityInQueue(path.join(queueDir, 'adhoc'))) {
    const task = require('../task-sources.js').nextAdhocTask();
    if (task) return task; // if the generator declined it (e.g. dependsOn unmet) fall through below
  }
  if (hasPremiumPriorityInQueue(path.join(queueDir, 'derived'))) {
    const task = require('../task-sources.js').nextDerivedTask();
    if (task) return task;
  }
  return null;
}

function getNextTask({ blocked } = {}) {
  try {
    const preempted = premiumPreemptedTask();
    if (preempted) return preempted;
  } catch (_) { /* best-effort -- a config/IO problem here must not stop generation; fall through to the normal walk */ }
  const { taskSourceAllowlist } = getConfig();
  const restricted = taskSourceAllowlist && taskSourceAllowlist.length > 0;
  const coreActive = activeRepoIsCore();
  for (const source of getRegisteredSources()) {
    // scope:'core' sources audit agent-manager itself -- skip them on any other project (source-scope.js).
    if (!sourceEligibleHere(source, coreActive)) continue;
    // The generation throttle's per-source veto (generation-throttle.js makeSourceThrottle): a source is blocked only
    // by in-flight work at least as important as itself, so lower-priority queued tasks can't starve it.
    if (blocked && blocked(source)) continue;
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
