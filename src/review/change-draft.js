'use strict';

// Artifact keys a patch may touch. The schema could not be located by grep,
// so callers may pass changeSet.schemaKeys to override this default.
const DEFAULT_ARTIFACT_KEYS = ['id', 'title', 'file', 'files', 'body', 'status', 'confidenceSource'];

function deepCopy(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createChangeDraft(changeSet) {
  const input = changeSet && typeof changeSet === 'object' ? changeSet : {};
  const allowed = new Set(Array.isArray(input.schemaKeys) ? input.schemaKeys : DEFAULT_ARTIFACT_KEYS);
  const actor = typeof input.actor === 'string' ? input.actor : 'unknown';

  // Private state: never exposed directly.
  const store = new Map();
  const log = [];

  const artifacts = Array.isArray(input.artifacts) ? deepCopy(input.artifacts) : [];
  for (const artifact of artifacts) {
    store.set(artifact.id, artifact);
  }

  function list() {
    return deepCopy([...store.values()]);
  }

  function get(id) {
    if (!store.has(id)) return undefined;
    return deepCopy(store.get(id));
  }

  function update(id, patch) {
    if (!store.has(id)) {
      throw new Error('unknown artifact id: ' + id);
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('patch must be a plain object');
    }
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) {
        throw new Error('patch key outside artifact schema: ' + key);
      }
    }
    if (patch.id !== undefined && patch.id !== id) {
      throw new Error('patch may not change artifact id');
    }
    // Validate everything first, then mutate.
    const current = store.get(id);
    const before = deepCopy(current);
    const next = Object.assign({}, current, deepCopy(patch));
    store.set(id, next);
    const after = deepCopy(next);
    log.push({ op: 'update', id, before, after, actor });
    return deepCopy(next);
  }

  function remove(id) {
    if (!store.has(id)) {
      throw new Error('unknown artifact id: ' + id);
    }
    const before = deepCopy(store.get(id));
    store.delete(id);
    log.push({ op: 'remove', id, before, after: null, actor });
  }

  function history() {
    return deepCopy(log);
  }

  return Object.freeze({ list, get, update, remove, history });
}

module.exports = { createChangeDraft };
