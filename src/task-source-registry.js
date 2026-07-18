/**
 * Internal storage: plain object keyed by source name.
 */
const registry = {};

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
 * Clear all registered sources. Useful for testing.
 */
function clearRegistry() {
  Object.keys(registry).forEach(key => delete registry[key]);
}

/**
 * Resolves which registry entry a task belongs to. Most sources register under the exact
 * same name as task.source, but two of this package's built-ins do not: adhoc tasks carry
 * domain: 'adhoc', source: 'manual'; secondbrain tasks carry domain: 'secondbrain', source:
 * 'inbox'. A consumer with its own non-matching source (e.g. this pipeline's own
 * unused_export, whose task.source is 'deadcode_triage') extends this by wrapping its own
 * call sites rather than this function needing to know every consumer's naming quirks.
 * @param {object} task - The task record.
 * @returns {string} The registry name to look up.
 */
function resolveSourceName(task) {
  if (task.domain === 'adhoc') return 'adhoc';
  if (task.domain === 'secondbrain') return 'secondbrain';
  if (task.source === 'deadcode_triage') return 'unused_export';
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
  Object.assign(registry[name], partialConfig);
}

module.exports = { registerTaskSource, getRegisteredSources, getRegisteredSource, clearRegistry, updateTaskSource, resolveSourceName };