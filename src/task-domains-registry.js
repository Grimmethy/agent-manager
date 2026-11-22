/**
 * Single source of truth for the standard task-domain set every registered project's
 * task-domains.json should list.
 *
 * The set is derived from `task-source-registry.js` (every registered source name
 * becomes a domain) plus the two always-present domains 'default' and 'adhoc'. Each
 * domain's shape (workDirKind, successCheck) comes from the source's own config, with
 * a sensible default for sources that don't declare one.
 *
 * Consumers:
 *   - scripts/provision-plugin-repo.sh, scripts/adopt-existing-project.sh,
 *     scripts/register-project.sh, scripts/ensure-task-domains.sh: write or repair
 *     a pipeline's task-domains.json so it lists every standard domain.
 *   - scripts/sweep-task-domains.sh: one-time and recurring sweep that repairs every
 *     registered pipeline and requeues tasks blocked only because of a missing key.
 *   - src/review-task.js (getDomainConfig): when a domain is unknown but IS a standard
 *     one, self-heal the pipeline's task-domains.json and continue instead of blocking
 *     the task permanently.
 *
 * Adding a new source later adds its domain everywhere -- no per-pipeline edit, no
 * per-script edit, no per-sweep edit.
 */

const { getRegisteredSources, getRegisteredSource } = require('./task-source-registry.js');

/**
 * The two domains that are always valid regardless of what sources are registered.
 * 'default' is the generic catch-all; 'adhoc' is the manual/human/bot-injected entry
 * point (queue-adhoc-task.js, apply-adhoc-diff.js, api_brain_dump_prioritize all stamp
 * domain='adhoc' on the tasks they create).
 */
const ALWAYS_PRESENT = ['default', 'adhoc'];

/**
 * Default shape for domains that a source does not explicitly configure. Most sources
 * work against a consumer repo (repoRoot) and the standard branch-diff success check.
 * 'research' is the notable exception: it works against the Second Brain directory.
 */
const DEFAULT_SHAPE = {
  workDirKind: 'repoRoot',
  successCheck: 'git-branch-diff',
};

/**
 * Per-domain overrides for shape. Sources whose workDirKind is not 'repoRoot' declare
 * it here so the derived set is correct without requiring every source to carry its own
 * shape config.
 */
const DOMAIN_SHAPES = {
  research: {
    workDirKind: 'secondBrainDir',
    successCheck: 'git-branch-diff',
  },
};

/**
 * Derive the full standard domain set from the registered task sources plus the two
 * always-present domains. Each source's name becomes a domain key; the shape comes from
 * DOMAIN_SHAPES (override) or DEFAULT_SHAPE (fallback).
 *
 * @returns {object} Map of domain name -> shape config
 */
function getStandardDomains() {
  const domains = {};

  // Always-present domains first (deterministic ordering).
  for (const name of ALWAYS_PRESENT) {
    domains[name] = DOMAIN_SHAPES[name] || DEFAULT_SHAPE;
  }

  // Every registered source contributes its own domain.
  const sources = getRegisteredSources();
  for (const source of sources) {
    const name = source.name;
    if (domains[name]) continue; // already present (one of ALWAYS_PRESENT)
    // Use the source's own workDirKind if it declares one, else default.
    const shape = {
      workDirKind: source.workDirKind || DEFAULT_SHAPE.workDirKind,
      successCheck: source.successCheck || DEFAULT_SHAPE.successCheck,
    };
    // Apply any explicit override (e.g. research -> secondBrainDir).
    if (DOMAIN_SHAPES[name]) {
      Object.assign(shape, DOMAIN_SHAPES[name]);
    }
    domains[name] = shape;
  }

  return domains;
}

/**
 * Get the shape config for a single domain, or null if it's not a standard domain.
 * @param {string} domainName
 * @returns {object|null}
 */
function getDomainShape(domainName) {
  const domains = getStandardDomains();
  return domains[domainName] || null;
}

/**
 * Check if a domain is a standard domain (present in the derived set).
 * @param {string} domainName
 * @returns {boolean}
 */
function isStandardDomain(domainName) {
  return !!getDomainShape(domainName);
}

module.exports = {
  getStandardDomains,
  getDomainShape,
  isStandardDomain,
  ALWAYS_PRESENT,
  DEFAULT_SHAPE,
  DOMAIN_SHAPES,
};
