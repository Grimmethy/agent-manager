const { ownerAllows } = require('./source-owner-guard.js');
const { logPipelineEvent } = require('./pipeline-history.js');

/** Per-source count of owner-mismatch suppressions, keyed by source name. */
const ownerMismatchCounts = {};

/** The running repo root for the owner guard, or null if it cannot be read (fails closed). */
function runningRootForOwnerGuard() {
  try {
    return require('./config.js').getConfig().repoRoot || null;
  } catch {
    return null;
  }
}

/** Where the owner-mismatch history event is written (same directory the pipeline already logs to). */
function pipelineDirForHistory() {
  try {
    const c = require('./config.js').getConfig();
    return c.pipelineDir || process.env.AGENT_MANAGER_PIPELINE_DIR || c.repoRoot || null;
  } catch {
    return process.env.AGENT_MANAGER_PIPELINE_DIR || null;
  }
}

/**
 * Record one owner-mismatch suppression for a single source: a history event and a per-source counter.
 * taskId is not known at the gate (the source has not produced a task yet), so it is logged as null.
 */
function recordOwnerMismatch(sourceName, runningRoot, owners) {
  ownerMismatchCounts[sourceName] = (ownerMismatchCounts[sourceName] || 0) + 1;
  logPipelineEvent(pipelineDirForHistory(), 'owner-mismatch', {
    source: sourceName,
    taskId: null,
    runningRoot,
    owners,
    reason: 'owner-mismatch',
  });
}

/**
 * Internal storage: plain object keyed by source name.
 */
const registry = {};

/**
 * task.source string -> registry name, for sources whose generated tasks carry a `source`
 * field that differs from the name they registered under (e.g. unused_export stamps
 * source: 'deadcode_triage'). A plugin declares its own quirk via registerSourceAlias()
 * instead of this file needing to know every consumer's naming; resolveSourceName() below
 * still has hardcoded fallbacks for this package's own built-in quirks + a legacy one.
 */
const sourceAliases = {};

/** Markers for gated next() wrappers, so a function is never double-wrapped. */
const gatedNextFns = new WeakSet();

/**
 * The single scope:'core' eligibility gate. Wraps a source's next() so EVERY caller -- retrieval
 * (getRegisteredSource / getRegisteredSources) or direct invocation -- gets null on any other
 * project. The predicate is read on each call, never cached at registration time.
 * @param {Function} next - the source's next() implementation
 * @returns {Function} the gated next()
 */
function gateCoreNext(next) {
  if (gatedNextFns.has(next)) return next;
  const gated = (...args) => {
    const { sourceEligibleHere } = require('./lib/source-scope.js');
    return sourceEligibleHere({ scope: 'core' }) ? next(...args) : null;
  };
  gatedNextFns.add(gated);
  return gated;
}

/**
 * Register a task source.
 * @param {string} name - Unique identifier for the source.
 * @param {object} config - Configuration to store (no validation).
 * @returns {object} The stored entry, or undefined if already registered.
 */
function registerTaskSource(name, config) {
  if (registry[name] !== undefined) {
    throw new Error(`Task source "${name}" is already registered`);
  }
  // scope:'core' sources audit agent-manager ITSELF (src/lib/source-scope.js). Wrap next() so that EVERY
  // caller -- getNextTask, the always-run watchdog sweeps that call a source directly -- gets null on any
  // other project, not just the priority ladder.
  if (config && config.scope === 'core' && typeof config.next === 'function') {
    config = { ...config, next: gateCoreNext(config.next) };
  }
  // Owner guard (per source, no shared state): when this source declares owners, each generation call checks whether the
  // running root is one of them via ownerAllows() from source-owner-guard.js. A mismatch returns null for this source only,
  // records one owner-mismatch history event, and increments this source's own counter. Other sources are unaffected.
  if (config && config.owners !== undefined && typeof config.next === 'function') {
    const ownedNext = config.next;
    const owners = config.owners;
    config = {
      ...config,
      next: (...args) => {
        const runningRoot = runningRootForOwnerGuard();
        if (ownerAllows(runningRoot, owners)) return ownedNext(...args);
        recordOwnerMismatch(name, runningRoot, owners);
        return null;
      },
    };
  }
  // `variantOf` (task-atomization plugin, docs/design-notes/task-atomization-plugin.md): this source is a smaller-scoped VARIANT of another source -- the
  // same kind of work shaped for a smaller model. Metadata only: the scorecard / dashboards group a variant with its parent. Validated shape-wise here;
  // the parent need not be registered yet (plugins load in any order).
  if (config && config.variantOf !== undefined && config.variantOf !== null) {
    if (typeof config.variantOf !== 'string' || !config.variantOf.trim() || config.variantOf === name) {
      throw new Error(`Task source "${name}": variantOf must name a different source (got ${JSON.stringify(config.variantOf)})`);
    }
  }
  registry[name] = { name, ...config };
}

/**
 * Get all registered sources sorted by priority.
 * @returns {object[]} Array of stored entries.
 */
function getRegisteredSources() {
  return Object.values(registry).sort((a, b) => {
    const pa = a.priority ?? Infinity;
    const pb = b.priority ?? Infinity;
    return pa - pb;
  });
}

/**
 * Get a single registered source by name.
 * @param {string} name - The source name to look up.
 * @returns {object|undefined} The stored entry or undefined.
 */
function getRegisteredSource(name) {
  return registry[name] ?? undefined;
}

/**
 * Declare that tasks carrying `task.source === fromField` belong to the registry entry
 * `toName`. Called by a plugin's registration file (e.g.
 * registerSourceAlias('deadcode_triage', 'unused_export')) so resolveSourceName() doesn't
 * need a hardcoded `if` for every out-of-tree source's naming quirk.
 * @param {string} fromField - the value a generated task stamps on its `source` field
 * @param {string} toName - the registry key that source registered under
 */
function registerSourceAlias(fromField, toName) {
  sourceAliases[fromField] = toName;
}

/**
 * Clear all registered sources (and source aliases). Useful for testing.
 */
function clearRegistry() {
  Object.keys(registry).forEach(key => delete registry[key]);
  Object.keys(sourceAliases).forEach(key => delete sourceAliases[key]);
}

/**
 * Resolves which registry entry a task belongs to. Most sources register under the exact
 * same name as task.source, but two of this package's built-ins do not: adhoc tasks carry
 * domain: 'adhoc', source: 'manual'; secondbrain tasks carry domain: 'secondbrain', source:
 * 'inbox'. A consumer with its own non-matching source (e.g. this pipeline's own
 * unused_export, whose task.source is 'deadcode_triage') extends this by wrapping its own
 * call sites rather than this function needing to know every consumer's naming quirks.
 *
 * task.source === 'manual' also resolves to 'adhoc' regardless of domain -- confirmed
 * live 2026-08-17 (Brain Dump #67): app.py's api_brain_dump_prioritize ("Process now")
 * stamps domain via default_task_domain(), which prefers the literal key 'default' over
 * 'adhoc' whenever a project's task-domains.json has BOTH (this project's own does) --
 * so "adhoc tasks carry domain: 'adhoc'" is only true for a consumer whose
 * task-domains.json has no 'default' key, not for this package's own self-hosted use.
 * source:'manual' is otherwise only ever set by queue-adhoc-task.js's CLI and
 * api_brain_dump_prioritize -- both adhoc-shaped regardless of which domain string
 * landed on the task -- so this is a safe, unambiguous second identifier, not a guess.
 * @param {object} task - The task record.
 * @returns {string} The registry name to look up.
 */
function resolveSourceName(task) {
  if (task.domain === 'adhoc' || task.source === 'manual') return 'adhoc';
  if (task.domain === 'secondbrain') return 'secondbrain';
  if (sourceAliases[task.source]) return sourceAliases[task.source];
  return task.source;
}

/**
 * Merge additional fields into an ALREADY-registered source (e.g. attaching
 * buildPlanPrompt/buildImplementPrompt/apply/groundingFields after the initial
 * { priority, next } registration). Inverse safety check of registerTaskSource: that
 * throws if the name already exists, this throws if it does NOT.
 * @param {string} name - The source name to update.
 * @param {object} partialConfig - Fields to merge into the existing entry.
 */
function updateTaskSource(name, partialConfig) {
  if (registry[name] === undefined) {
    throw new Error(`Cannot update unregistered task source: "${name}"`);
  }
  // Same gate as registration: a core source's next() must stay gated even when it is attached
  // or replaced after registration, or when the entry is switched to scope:'core' later.
  const merged = { ...registry[name], ...partialConfig };
  if (merged.scope === 'core' && typeof merged.next === 'function' && !gatedNextFns.has(merged.next)) {
    partialConfig = { ...partialConfig, next: gateCoreNext(merged.next) };
  }
  Object.assign(registry[name], partialConfig);
}

/** The parent source `name` is a variant of, or null. Follows chains (a variant of a variant) to the root; cycle-safe. */
function variantParentOf(name) {
  let cur = name;
  const seen = new Set();
  while (registry[cur] && registry[cur].variantOf && !seen.has(cur)) {
    seen.add(cur);
    cur = registry[cur].variantOf;
  }
  return cur === name ? null : cur;
}

/** Names of the sources registered as (direct or indirect) variants of `parent`. */
function getVariantsOf(parent) {
  return Object.keys(registry).filter((n) => variantParentOf(n) === parent);
}

module.exports = { variantParentOf, getVariantsOf, registerTaskSource, getRegisteredSources, getRegisteredSource, clearRegistry, updateTaskSource, resolveSourceName, registerSourceAlias };