'use strict';

// Generic swap point for "where does a plugin-owned NON-GIT domain's real output get
// written." apply-task.js hardcodes each core-owned non-git domain (research, deep_dive,
// wiki_content, ...) because the write helpers live in core. A plugin whose tasks never
// touch a git branch (its output is a result file, a database row, ...) used to need a
// bespoke `<name>-apply-route.js` seam per domain -- wiki-content-apply-route.js is the
// first such copy. This module is the reusable version: a plugin calls
// registerDomainApply('my_domain', fn) at register.js load time, and apply-task.js
// dispatches any task whose `domain` matches BEFORE the git-branch-diff flow (which would
// otherwise fetch/reset/branch the tracked repo for a task that never touches it).
//
//   fn({ task }) -> { skipped?: true, reason?: string, file?: string, doneMarker?: string }
//
// A `skipped` result closes the task with `reason` as its doneMarker (nothing written, not
// a failure); otherwise doneMarker falls back to `<domain> applied -> <file>`. Throwing
// blocks the task for a human, same as any apply failure.
//
// A registry (one fn per domain), not a single slot: several plugins can each own a domain.
// Re-registering a domain replaces it (plugin reload / tests). wiki_content keeps its own
// dedicated seam for now; new domains should use this one.

const registry = new Map();

function registerDomainApply(domain, fn) {
  if (!domain || typeof domain !== 'string') throw new Error('registerDomainApply: domain must be a non-empty string');
  if (typeof fn !== 'function') throw new Error(`registerDomainApply(${domain}): fn must be a function`);
  registry.set(domain, fn);
}

function getDomainApply(domain) {
  return registry.get(domain) || null;
}

function clearDomainApplyRegistry() {
  registry.clear();
}

module.exports = { registerDomainApply, getDomainApply, clearDomainApplyRegistry };
