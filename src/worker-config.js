'use strict';

// Worker configuration merge utility. Provides two primitives used by the
// agent-manager voter and reviewer pipelines:
//
//   * resolveWorkerConfig(...layers) - merges plain objects left-to-right
//     (later layers override earlier), returns a new object, never mutates
//     inputs, and refuses any layer that contains forbidden keys (num_ctx,
//     numCtx, keep_alive, keepAlive, or unload/reload flags).
//
//   * withPatch(base, patch) - returns a new object equal to `base` with
//     `patch` shallow-merged on top. Never mutates `base` or `patch`.
//
// This module is intentionally a pure data-merge layer: no HTTP calls, no
// timers, no model-selection logic. It is wired into the voter/reviewer
// construction by a sibling task.

const FORBIDDEN_KEYS = new Set([
  'num_ctx',
  'numCtx',
  'keep_alive',
  'keepAlive',
]);

// Keys that indicate an unload/reload flag. Matches any key containing
// 'unload' or 'reload' (case-sensitive) so that future flag names like
// 'forceUnload' or 'workerReload' are also caught without listing every
// variant by name.
function isUnloadReloadFlag(key) {
  const lower = key.toLowerCase();
  return lower.includes('unload') || lower.includes('reload');
}

function checkForbiddenKeys(layer, layerIndex) {
  if (layer === null || typeof layer !== 'object') return;
  for (const key of Object.keys(layer)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(
        `resolveWorkerConfig: forbidden key "${key}" found in layer ${layerIndex}`
      );
    }
    if (isUnloadReloadFlag(key)) {
      throw new Error(
        `resolveWorkerConfig: forbidden unload/reload flag "${key}" found in layer ${layerIndex}`
      );
    }
  }
}

/**
 * Merge one or more plain-object layers left-to-right. Later layers win on
 * key collision. Returns a new object; never mutates any input.
 *
 * Throws Error if any layer contains a forbidden key (num_ctx, numCtx,
 * keep_alive, keepAlive, or any unload/reload flag).
 *
 * @param  {...object} layers
 * @returns {object}
 */
function resolveWorkerConfig(...layers) {
  // Validate every layer first so a forbidden key is caught even if a later
  // layer would have overwritten it -- the contract forbids the key
  // regardless of resolution order.
  for (let i = 0; i < layers.length; i++) {
    checkForbiddenKeys(layers[i], i);
  }

  // Object.assign with an empty target returns a new object and shallow-
  // copies all arguments left-to-right (later args win). None of the
  // arguments are mutated.
  return Object.assign({}, ...layers);
}

/**
 * Return a new object equal to `base` with `patch` shallow-merged on top.
 * Later keys win on collision. Never mutates `base` or `patch`.
 *
 * @param {object} base
 * @param {object} patch
 * @returns {object}
 */
function withPatch(base, patch) {
  return Object.assign({}, base, patch);
}

module.exports = {
  resolveWorkerConfig,
  withPatch,
};
