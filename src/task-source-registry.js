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
 *
 * Three outcomes:
 * - recorded: the history event is written to the pipeline directory.
 * - skipped: pipelineDirForHistory() returned null (no pipelineDir, no AGENT_MANAGER_PIPELINE_DIR, no repoRoot),
 *   so there is nowhere to write; a warning is written to stderr.
 * - failed: the directory resolved but the write failed (logPipelineEvent returned false or threw); a warning is
 *   written to stderr.
 * In the last two cases the per-source counter still increments, and the error is never rethrown, so the gate
 * still returns null for the caller.
 */
function recordOwnerMismatch(sourceName, runningRoot, owners) {
  ownerMismatchCounts[sourceName] = (ownerMismatchCounts[sourceName] || 0) + 1;
  const entry = {
    source: sourceName,
    taskId: null,
    runningRoot,
    owners,
    reason: 'owner-mismatch',
  };
  try {
    const dir = pipelineDirForHistory();
    if (!dir) {
      process.stderr.write(`[owner-mismatch] source "${sourceName}": no pipeline directory resolved (pipelineDir, AGENT_MANAGER_PIPELINE_DIR and repoRoot all unset); owner-mismatch event NOT recorded\n`);
      return;
    }
    if (!logPipelineEvent(dir, 'owner-mismatch', entry)) {
      process.stderr.write(`[owner-mismatch] source "${sourceName}": failed to write owner-mismatch event to "${dir}"; event NOT recorded\n`);
    }
  } catch (err) {
    process.stderr.write(`[owner-mismatch] source "${sourceName}": error recording owner-mismatch event (${err && err.message}); event NOT recorded\n`);
  }
}

/**
 * Internal storage: plain object keyed by source name.
 */
const registry = {};

/**
 * task.source string -> registry name, for sources whose generated tasks carry a `source`
 * field that differs from the name they registered under (e.g. unused_export stamps
 * source: 'deadcode_triage'). A plugin declares its own quirk via registerSourceAlias()
 * instead of this file needing to know every consumer's naming. This package's own built-ins
 * ('manual' -> adhoc) are seeded through the same call by seedBuiltinAliases() at module load.
 */
const sourceAliases = {};

/** task.domain string -> registry name (e.g. 'adhoc' -> 'adhoc'). Filled via registerDomainAlias(). */
const domainAliases = Object.create(null);

/** Unresolved-task drops, keyed by task id + raw source + raw domain. */
const unresolvedDrops = new Map();

/** Markers for gated next() wrappers, so a function is never double-wrapped. */
const gatedNextFns = new WeakSet();

/**
 * Generic eligibility gate. Wraps a source's next() so EVERY caller -- retrieval
 * (getRegisteredSource / getRegisteredSources) or direct invocation -- gets null whenever the
 * source's `gate` returns falsy. The gate is evaluated on each call, never cached at registration time.
 * @param {Function} gate - predicate; falsy means next() returns null without calling the source
 * @param {Function} next - the source's next() implementation
 * @returns {Function} the gated next()
 */
function gateNext(gate, next) {
  if (gatedNextFns.has(next)) return next;
  const gated = (...args) => (gate() ? next(...args) : null);
  gatedNextFns.add(gated);
  return gated;
}

/** Throws unless `config.gate` is absent or a function. */
function validateGate(name, config) {
  if (config && config.gate !== undefined && config.gate !== null && typeof config.gate !== 'function') {
    throw new Error(`Task source "${name}": gate must be a function`);
  }
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
  // `gate` (optional function): evaluated on every next() call; a falsy result makes next() return null without
  // calling the source. Wrapped here so EVERY caller -- getNextTask, the always-run watchdog sweeps that call a
  // source directly -- sees the gate, not just the priority ladder.
  validateGate(name, config);
  if (config && typeof config.gate === 'function' && typeof config.next === 'function') {
    config = { ...config, next: gateNext(config.gate, config.next) };
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
 * Declare that tasks carrying `task.domain === domain` belong to the registry entry `toName`.
 * Looked up at call time (never cached), so registration order between plugins does not matter.
 * @param {string} domain - the value a task stamps on its `domain` field
 * @param {string} toName - the registry key that source registered under
 */
function registerDomainAlias(domain, toName) {
  domainAliases[domain] = toName;
}

/** Register this package's own built-in domain/source quirks through the public alias calls. */
function seedBuiltinAliases() {
  registerDomainAlias('adhoc', 'adhoc');
  registerDomainAlias('secondbrain', 'secondbrain');
  // See resolveSourceName(): source:'manual' is adhoc-shaped whatever domain landed on the task.
  registerSourceAlias('manual', 'adhoc');
}

/**
 * Clear all registered sources, source aliases, domain aliases and unresolved-drop records, then
 * re-seed this package's own built-in aliases (they are not plugin-owned). Useful for testing.
 */
function clearRegistry() {
  Object.keys(registry).forEach(key => delete registry[key]);
  Object.keys(sourceAliases).forEach(key => delete sourceAliases[key]);
  Object.keys(domainAliases).forEach(key => delete domainAliases[key]);
  unresolvedDrops.clear();
  seedBuiltinAliases();
}

/** Total number of recorded unresolved-task drops (sum over all id/source/domain keys). */
function getUnresolvedSourceCount() {
  let n = 0;
  for (const d of unresolvedDrops.values()) n += d.count;
  return n;
}

/** Recorded unresolved drops: [{ taskId, source, domain, count }]. */
function getUnresolvedSources() {
  return [...unresolvedDrops.values()].map(d => ({ ...d }));
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
 *
 * Precedence: domain alias (registerDomainAlias), then source alias (registerSourceAlias),
 * then task.source unchanged.
 *
 * REQUIRES AN INITIALIZED REGISTRY: it only resolves against what has been registered so far.
 * Built-in aliases are seeded at module load; sources and plugin aliases register in their own
 * registration files. Called earlier, it returns the unresolved result (task.source unchanged) --
 * not an error, and the miss is never cached. When the registry has entries but the result is
 * not one of them, one drop is recorded (see getUnresolvedSources()), keyed by task id, raw
 * source and raw domain. With an empty registry nothing is recorded.
 * @param {object} task - The task record.
 * @returns {string} The registry name to look up.
 */
function resolveSourceName(task) {
  const resolved = (task.domain !== undefined && domainAliases[task.domain]) || sourceAliases[task.source] || task.source;
  if (registry[resolved] === undefined && Object.keys(registry).length > 0) {
    const key = JSON.stringify([task.id ?? null, task.source ?? null, task.domain ?? null]);
    const rec = unresolvedDrops.get(key);
    if (rec) rec.count += 1;
    else unresolvedDrops.set(key, { taskId: task.id ?? null, source: task.source ?? null, domain: task.domain ?? null, count: 1 });
  }
  return resolved;
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
  // Same gate as registration: a gated source's next() must stay gated even when it is attached
  // or replaced after registration, or when a gate is attached later.
  validateGate(name, partialConfig);
  const merged = { ...registry[name], ...partialConfig };
  if (typeof merged.gate === 'function' && typeof merged.next === 'function' && !gatedNextFns.has(merged.next)) {
    partialConfig = { ...partialConfig, next: gateNext(merged.gate, merged.next) };
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

seedBuiltinAliases();

module.exports = { variantParentOf, getVariantsOf, registerTaskSource, getRegisteredSources, getRegisteredSource, clearRegistry, updateTaskSource, resolveSourceName, registerSourceAlias, registerDomainAlias, getUnresolvedSourceCount, getUnresolvedSources };