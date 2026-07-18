'use strict';

// Single source of truth for every env-var-driven setting this package reads. A consumer
// project (e.g. TaxHarvest) sets these in its own environment/launcher before invoking any
// script in this package -- there is no per-project config FILE the package loads itself,
// matching the env-var style already established by ornith-client.js's OLLAMA_URL/
// ORNITH_MODEL and review-runner.ps1's SECOND_BRAIN_DIR, rather than inventing a second
// config mechanism alongside it.
//
// REPO_ROOT is the one REQUIRED setting -- there is no sensible package-relative default
// once this code no longer lives inside the consumer's own repo.

function getConfig() {
  const path = require('path');
  const repoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  if (!repoRoot) {
    throw new Error('AGENT_MANAGER_REPO_ROOT env var is required (absolute path to the consumer repo this pipeline operates on).');
  }

  const pipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR || repoRoot;
  const secondBrainDir = process.env.SECOND_BRAIN_DIR || null;
  const grepAllowedDirs = (process.env.AGENT_MANAGER_GREP_DIRS || 'frontend/src,backend/src')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Where unused-export-scan.js looks. scanDirs = dirs whose files are scanned for
  // (CommonJS) export definitions; searchDirs = dirs walked for call sites of each export.
  // Both are repoRoot-relative and default to grepAllowedDirs (the same code roots the grep
  // tool is scoped to), so a consumer that already sets AGENT_MANAGER_GREP_DIRS gets sane
  // behavior for free; override independently only when scan- and search-scope must differ.
  const splitDirs = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const unusedScanDirs = splitDirs(process.env.AGENT_MANAGER_UNUSED_SCAN_DIRS || grepAllowedDirs.join(','));
  const unusedSearchDirs = splitDirs(process.env.AGENT_MANAGER_UNUSED_SEARCH_DIRS || grepAllowedDirs.join(','));

  // Sensible-default, overridable paths for the built-in task sources that read/write a
  // project doc file. Defaults match this pipeline's own original layout; a consumer with
  // a different docs-folder convention overrides via env var.
  const troubleLogPath = process.env.AGENT_MANAGER_TROUBLE_LOG_PATH || path.join(repoRoot, 'Docs', 'TROUBLE_LOG.md');
  const archReviewCandidatesPath = process.env.AGENT_MANAGER_ARCH_CANDIDATES_PATH || path.join(repoRoot, 'Docs', 'ARCH_REVIEW_CANDIDATES.md');
  const communityCoveragePath = process.env.AGENT_MANAGER_COMMUNITY_COVERAGE_PATH || path.join(pipelineDir, 'community-coverage.json');
  const graphPath = process.env.AGENT_MANAGER_GRAPH_PATH || path.join(repoRoot, 'graphify-out', 'graph.json');
  const domainsPath = process.env.AGENT_MANAGER_DOMAINS_PATH || path.join(pipelineDir, 'task-domains.json');
  // The domain this package's own code-repo-facing built-in sources (trouble_log,
  // arch_review, arch_discovery) stamp onto the tasks they generate -- must match a real
  // key in the consumer's domainsPath file. 'adhoc' and 'secondbrain' are NOT covered by
  // this: those two are a fixed contract (see resolveSourceName in task-source-registry.js),
  // not configurable, since their whole identity IS their domain.
  const defaultDomain = process.env.AGENT_MANAGER_DEFAULT_DOMAIN || 'default';

  // Side-effect require: the consumer's own file that calls registerTaskSource/
  // updateTaskSource for every task source it wants (both fully local ones and ones built
  // from this package's exported prompt-builder/apply helpers). Every CLI entry point in
  // this package that needs a populated registry (get-grounding-source.js, apply-task.js,
  // task-sources.js's getNextTask) requires it via this single hook instead of each
  // hardcoding a sibling file name -- the old TaxHarvest-only pattern this replaces.
  const registerPath = process.env.AGENT_MANAGER_REGISTER_PATH;

  return {
    repoRoot, pipelineDir, secondBrainDir, grepAllowedDirs, unusedScanDirs, unusedSearchDirs, registerPath,
    troubleLogPath, archReviewCandidatesPath, communityCoveragePath, graphPath, domainsPath,
    defaultDomain,
  };
}

let registered = false;
function ensureRegistered() {
  if (registered) return;
  registered = true;
  const { registerPath } = getConfig();
  if (registerPath) require(registerPath);
}

module.exports = { getConfig, ensureRegistered };
