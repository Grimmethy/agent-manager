'use strict';

// Project scoping for task sources (2026-09-19, PF-Client-Portal).
//
// Most sources examine the ACTIVE PROJECT's code (hygiene reviews, change_review, arch_*, ...). A few
// examine agent-manager ITSELF -- its own daemons, queue health, failure classes, README, dashboard UI.
// Those are marked `scope: 'core'` at registration and only make sense when agent-manager is the active
// project. Run against another project they audit the wrong thing: on PF-Client-Portal a
// pipeline_health_audit outranked every hygiene review (priority 22 vs 25-28), a PF function-length
// review filed an agent-manager "ghost debt" finding into PF's brain dump, and doc_drift_fix failed with
// "could not read README.md". Enforced at generation (getNextTask) AND claim (next-claimable-task), so a
// task already sitting in another project's pending/ is not run either.
//
// AGENT_MANAGER_CORE_SOURCES_ANYWHERE=true disables the gate (run them on any project, as before).

const { isCoreRepo } = require('../accessible-roots.js');

const CORE_SCOPE = 'core';

function gateDisabled() {
  return String(process.env.AGENT_MANAGER_CORE_SOURCES_ANYWHERE || '').trim().toLowerCase() === 'true';
}

// True when the pipeline's active repo is agent-manager itself. Fails OPEN (true) if the active repo cannot
// be read, so a config problem degrades to the old behavior instead of silencing the sources.
function activeRepoIsCore() {
  try {
    return isCoreRepo(require('../config.js').getConfig().repoRoot);
  } catch {
    return true;
  }
}

// entry: a registry entry ({ name, scope, ... }) or undefined. `coreActive` may be passed to avoid
// re-reading config in a loop.
function sourceEligibleHere(entry, coreActive = activeRepoIsCore()) {
  if (!entry || entry.scope !== CORE_SCOPE) return true;
  return gateDisabled() || coreActive;
}

module.exports = { CORE_SCOPE, activeRepoIsCore, sourceEligibleHere, gateDisabled };
