'use strict';

// Single source of truth for every env-var-driven setting this package reads. A consumer
// project sets these in its own environment/launcher before invoking any
// script in this package -- there is no per-project config FILE the package loads itself,
// matching the env-var style already established by ornith-client.js's OLLAMA_URL/
// ORNITH_MODEL and review-runner.ps1's SECOND_BRAIN_DIR, rather than inventing a second
// config mechanism alongside it.
//
// REPO_ROOT is the one REQUIRED setting -- there is no sensible package-relative default
// once this code no longer lives inside the consumer's own repo.

// The dashboard's own "Build Graph" button (Project tab) and arch_discovery/
// path-prefetch.js's graph consumers used to point at two entirely different files --
// confirmed live 2026-08-16: a user built a graph via the dashboard, expecting it to
// feed both, and neither arch_discovery nor the new path-prefetch feature ever saw it,
// since the dashboard writes to <repoRoot>/.agent-manager-cache/<grepDirsSlug>/graph.json
// (python/dashboard/app.py's project_cache_paths/_grepdirs_slug) while the Node-side
// default here pointed at <repoRoot>/graphify-out/graph.json -- a path nothing in this
// package ever actually writes to on its own (only ever populated by someone manually
// running python/build_graph.py's CLI directly, which is how this went unnoticed).
//
// Resolution order: (1) .agent-manager-cache/default/graph.json -- the common case, no
// grepDirs configured, a predictable non-hashed path per _grepdirs_slug's own "'default'
// for the common no-grepDirs case" comment; (2) if that's missing, the most recently
// modified graph.json across any .agent-manager-cache/<hash>/ subdirectory (a grepDirs-
// scoped build) -- picking freshest rather than replicating Python's exact hash algorithm
// here, which would just be two implementations to keep in sync for no real benefit;
// (3) the old graphify-out/graph.json location, kept as a last-resort fallback for
// anyone who already has one from manually running build_graph.py's CLI -- not
// regressing that existing (if rare) usage just because the dashboard button now has
// its own, preferred path.
function resolveGraphPath(repoRoot) {
  const fs = require('fs');
  const path = require('path');
  const cacheDir = path.join(repoRoot, '.agent-manager-cache');

  const defaultCacheGraph = path.join(cacheDir, 'default', 'graph.json');
  if (fs.existsSync(defaultCacheGraph)) return defaultCacheGraph;

  try {
    const candidates = fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(cacheDir, e.name, 'graph.json'))
      .filter((p) => fs.existsSync(p))
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 0) return candidates[0].p;
  } catch {
    // cacheDir itself doesn't exist -- fall through to the legacy default below.
  }

  return path.join(repoRoot, 'graphify-out', 'graph.json');
}

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
  const archImportCandidatesPath = process.env.AGENT_MANAGER_ARCH_IMPORT_CANDIDATES_PATH || path.join(repoRoot, 'Docs', 'ARCH_IMPORT_CANDIDATES.md');
  const communityCoveragePath = process.env.AGENT_MANAGER_COMMUNITY_COVERAGE_PATH || path.join(pipelineDir, 'community-coverage.json');
  const graphPath = process.env.AGENT_MANAGER_GRAPH_PATH || resolveGraphPath(repoRoot);
  const domainsPath = process.env.AGENT_MANAGER_DOMAINS_PATH || path.join(pipelineDir, 'task-domains.json');
  // project_search's apply target lives OUTSIDE any single project's repo root by design
  // (see ADR-0018) -- a cross-project lead ledger, not something scoped to repoRoot the way
  // every other path above is. No repoRoot-relative default makes sense here; the fallback
  // below matches this operator's actual UsefulProjectIndex location as of 2026-07-19.
  const projectSearchIndexPath = process.env.AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH
    || path.join(path.dirname(repoRoot), 'UsefulProjectIndex', 'INDEX.md');
  // deep_dive (ADR-0019) is project_search's consumer -- its clones, per-project analysis
  // docs, and coverage tracker all live alongside INDEX.md by default (same
  // UsefulProjectIndex directory), derived from projectSearchIndexPath rather than a
  // separate repoRoot-relative default, since none of this is scoped to any one project's
  // repo any more than INDEX.md itself is.
  const deepDiveCoveragePath = process.env.AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH
    || path.join(pipelineDir, 'deep-dive-coverage.json');
  // observability_review (project idea "OpenTelemetry-Observability-Idea", 2026-07-26)
  // rides on deep_dive's already-cloned projects (deepDiveCoveragePath) rather than
  // cloning its own copies -- this just tracks which of THOSE projects have already been
  // scanned by observability-scan.js, so a project is scanned exactly once, not every tick.
  const observabilityCoveragePath = process.env.AGENT_MANAGER_OBSERVABILITY_COVERAGE_PATH
    || path.join(pipelineDir, 'observability-coverage.json');
  // performance_review (Brain Dump #94, 2026-08-18) -- same "ride on deep_dive's already-
  // cloned projects, track which ones this scanner has covered" shape as
  // observability_review immediately above.
  const performanceCoveragePath = process.env.AGENT_MANAGER_PERFORMANCE_COVERAGE_PATH
    || path.join(pipelineDir, 'performance-coverage.json');
  const importCoveragePath = process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH
    || path.join(pipelineDir, 'import-coverage.json');
  // pipeline_self_audit (2026-08-19: "how can we turn this into a self improving
  // process?") -- tracks which failure signatures (see pipeline-self-audit.js) have
  // already had an audit task filed, so the same blocked-task cluster doesn't generate a
  // new audit task every tick once it's been reported once.
  const selfAuditCoveragePath = process.env.AGENT_MANAGER_SELF_AUDIT_COVERAGE_PATH
    || path.join(pipelineDir, 'self-audit-coverage.json');
  // brain_dump_sort's queue -- same file the dashboard's Brain Dump tab reads/writes
  // (python/dashboard/app.py's brain_dump_path()). Env var name kept byte-identical across
  // both languages on purpose; there is no other link between them.
  const brainDumpPath = process.env.AGENT_MANAGER_BRAIN_DUMP_PATH
    || path.join(pipelineDir, 'brain-dump.json');
  const deepDiveClonesDir = process.env.AGENT_MANAGER_DEEP_DIVE_CLONES_DIR
    || path.join(path.dirname(projectSearchIndexPath), 'clones');
  const deepDiveAnalysisDir = process.env.AGENT_MANAGER_DEEP_DIVE_ANALYSIS_DIR
    || path.join(path.dirname(projectSearchIndexPath), 'analysis');
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
  // hardcoding a sibling file name -- the old single-consumer-only pattern this replaces.
  const registerPath = process.env.AGENT_MANAGER_REGISTER_PATH;

  // Optional allowlist restricting getNextTask() (task-sources.js) to specific source
  // names -- e.g. the dashboard's "Project Search" run mode sets this to just
  // ["project_search"] so that source (priority 85, the lowest of the 10 built-ins) is
  // guaranteed to actually get picked, rather than starving behind arch_discovery/
  // arch_review/etc whenever they have pending work. Empty/unset means no restriction,
  // matching every existing consumer's behavior unchanged.
  const rawSourceAllowlist = process.env.AGENT_MANAGER_TASK_SOURCES || '';
  const taskSourceAllowlist = rawSourceAllowlist.split(',').map((s) => s.trim()).filter(Boolean);

  // Optional per-source priority overrides -- lets the dashboard's Job List tab make a
  // source's claim-order priority live-editable without a code change. Format:
  // "name:number,name:number", e.g. "deep_dive:60,project_search:65". A source not listed
  // here keeps whatever default its own registerTaskSource(name, {priority}) call passes.
  // Read fresh by every `node task-sources.js` invocation (a new process each worker
  // tick), so an edit here takes effect on the very next tick -- no pipeline restart.
  const rawPriorities = process.env.AGENT_MANAGER_TASK_PRIORITIES || '';
  const taskPriorityOverrides = {};
  rawPriorities.split(',').forEach((pair) => {
    const [name, num] = pair.split(':').map((s) => s.trim());
    if (name && num && !Number.isNaN(Number(num))) taskPriorityOverrides[name] = Number(num);
  });

  // Three-tier approval mode (harnss's per-tool approval_mode pattern, adapted
  // 2026-07-26): 'auto' (apply-runner.ps1 applies automatically once Ornith approves),
  // 'approve' (waits in queue/approved/ for a human to manually apply via the dashboard's
  // per-task Apply button), 'prompt' (same as 'approve' -- still requires an explicit
  // human click, never auto-applies on a timeout -- but the dashboard actively badges it
  // rather than leaving it as a plain count, so it doesn't just sit unnoticed). Same
  // sparse-override format/semantics as AGENT_MANAGER_TASK_PRIORITIES. A source with no
  // override falls back to defaultApprovalMode below, derived from the existing
  // AGENT_MANAGER_INCLUDE_APPLY global toggle -- so nothing changes for an existing setup
  // until a source is explicitly configured here.
  const rawApprovalModes = process.env.AGENT_MANAGER_APPROVAL_MODES || '';
  const approvalModeOverrides = {};
  const VALID_APPROVAL_MODES = ['auto', 'prompt', 'approve'];
  rawApprovalModes.split(',').forEach((pair) => {
    const [name, mode] = pair.split(':').map((s) => (s || '').trim());
    if (name && VALID_APPROVAL_MODES.includes(mode)) approvalModeOverrides[name] = mode;
  });
  const defaultApprovalMode = process.env.AGENT_MANAGER_INCLUDE_APPLY === 'true' ? 'auto' : 'approve';

  return {
    repoRoot, pipelineDir, secondBrainDir, grepAllowedDirs, unusedScanDirs, unusedSearchDirs, registerPath,
    troubleLogPath, archReviewCandidatesPath, archImportCandidatesPath, communityCoveragePath, graphPath, domainsPath,
    projectSearchIndexPath,
    deepDiveCoveragePath, deepDiveClonesDir, deepDiveAnalysisDir, importCoveragePath, observabilityCoveragePath,
    selfAuditCoveragePath,
    performanceCoveragePath,
    brainDumpPath,
    defaultDomain, taskSourceAllowlist, taskPriorityOverrides,
    approvalModeOverrides, defaultApprovalMode,
  };
}

let registered = false;
function ensureRegistered() {
  if (registered) return;
  registered = true;
  const { registerPath } = getConfig();
  if (registerPath) require(registerPath);
}

module.exports = { getConfig, ensureRegistered, resolveGraphPath };
