'use strict';

// infra-recovery.js: requeues tasks held for an infrastructure outage once the local model is back.
//
//   registerInfraRecovery({ subscribe, requeue, waiting })
//     subscribe(eventName, handler) -> registers handler; may return an unsubscribe function
//     requeue(id)                   -> puts one held task back in its queue
//     waiting()                     -> array of { id, holdReason, blockKind } for held tasks
//
// Rules:
//   * A task is requeued only when holdReason === 'infra-outage' AND blockKind is not
//     'content' and not 'design-question'. Those two block kinds stay blocked regardless.
//   * Registration runs one catch-up sweep, then reacts only to the 'local-model-ready' event.
//   * Interpretation of the catch-up: it runs the same filter, so it requeues only tasks that
//     are already waiting at registration. A task that becomes held later is recovered only
//     when the event fires.
//   * No timers, no polling. The only triggers are registration and the event.
//   * Registration is idempotent per module instance: a second call is a no-op.
//
// This module has no I/O of its own; every side effect goes through the injected functions.

const EVENT = 'local-model-ready';
const INFRA_HOLD = 'infra-outage';
const NEVER_REQUEUE_KINDS = new Set(['content', 'design-question']);

let registered = false;

function isRecoverable(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.holdReason !== INFRA_HOLD) return false;
  if (NEVER_REQUEUE_KINDS.has(entry.blockKind)) return false;
  return true;
}

function sweep({ requeue, waiting }) {
  const list = waiting() || [];
  for (const entry of list) {
    if (isRecoverable(entry)) requeue(entry.id);
  }
}

function registerInfraRecovery({ subscribe, requeue, waiting }) {
  if (registered) return undefined;
  registered = true;

  const onReady = () => sweep({ requeue, waiting });
  const unsubscribe = subscribe(EVENT, onReady);

  // Catch-up check at registration.
  sweep({ requeue, waiting });

  return typeof unsubscribe === 'function' ? unsubscribe : undefined;
}

module.exports = { registerInfraRecovery, isRecoverable, EVENT, INFRA_HOLD };
