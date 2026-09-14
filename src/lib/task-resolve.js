'use strict';

// task-resolve.js -- extracted from src/task-sources.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');

function listHeldTasksFifo(heldDir) {
  try {
    return fs.readdirSync(heldDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(heldDir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime)
      .map((entry) => entry.f);
  } catch {
    return null;
  }
}

function deriveResolveIdentity(held, fileName, { isHighReasoningRetry, isPeriodicReattempt }) {
  const heldId = held.id || fileName.replace(/\.json$/, '');
  const attempt = held.needsClarification.attempt || 1;
  const periodicRound = (held.needsClarification.periodicReattemptCount || 0) + 1;
  const resolveId = isPeriodicReattempt
    ? `path-prefetch-resolve-${heldId}-periodic${periodicRound}`
    : isHighReasoningRetry
      ? `path-prefetch-resolve-${heldId}-attempt${attempt}-highreasoning`
      : (attempt > 1 ? `path-prefetch-resolve-${heldId}-attempt${attempt}` : `path-prefetch-resolve-${heldId}`);
  return { heldId, periodicRound, resolveId };
}

function selfHealResolveDeadlock({
  pipelineDir, heldDir, fileName, held, resolveId,
  isHighReasoningRetry, isPeriodicReattempt, periodicRound,
}) {
  const resolveTerminalPath = ['blocked', 'done']
    .map((state) => path.join(pipelineDir, 'queue', state, `${resolveId}.json`))
    .find((p) => fs.existsSync(p));
  if (!resolveTerminalPath) return;

  const heldPath = path.join(heldDir, fileName);
  // Same deadlock class, applied to the periodic tier: a rejected periodic resolve task
  // must still advance lastPeriodicReattemptAt/periodicReattemptCount, or this exact
  // resolveId (round N) "exists" in queue/blocked/ forever and the interval check in
  // classifyReattemptTier() never gets a fresh anchor to count forward from -- an
  // indefinite stall identical to the pre-existing high-reasoning deadlock this block
  // already self-heals, just for a different tier.
  if (isPeriodicReattempt) {
    held.needsClarification.lastPeriodicReattemptAt = new Date().toISOString();
    held.needsClarification.periodicReattemptCount = periodicRound;
    try {
      fs.writeFileSync(heldPath, JSON.stringify(held, null, 2));
    } catch {
      // Non-fatal -- worst case this self-heal is retried next tick.
    }
    return;
  }

  const flagKey = isHighReasoningRetry ? 'highReasoningAttempted' : 'suggestionAttempted';
  if (!held.needsClarification[flagKey]) {
    held.needsClarification[flagKey] = true;
    try {
      fs.writeFileSync(heldPath, JSON.stringify(held, null, 2));
    } catch {
      // Non-fatal -- worst case this self-heal is retried next tick.
    }
  }
}

function buildResolveTask({
  resolveId, held, heldId,
  isHighReasoningRetry, isPeriodicReattempt, periodicRound, fileList,
}) {
  return {
    id: resolveId,
    domain: 'path_prefetch_resolve',
    source: 'path_prefetch_resolve',
    // Per-instance override (see model-provider.js's reasoningTierFor()) -- only the
    // retry attempt sets this; the first attempt stays on path_prefetch_resolve's
    // ordinary low-reasoning default (no static reasoningTier registered for that source).
    ...(isHighReasoningRetry ? { reasoningTier: 'high' } : {}),
    title: isPeriodicReattempt
      ? `Periodic re-check (round ${periodicRound}): suggest file path(s) for held task: ${(held.title || heldId).slice(0, 60)}`
      : `Suggest file path(s) for held task: ${(held.title || heldId).slice(0, 80)}`,
    promptContext: {
      heldTaskId: heldId,
      rawText: (held.promptContext && held.promptContext.rawText) || held.title || '',
      taskTitle: held.title || '',
      reason: held.needsClarification.reason,
      candidates: held.needsClarification.candidates || null,
      // Budget cap matching path-prefetch.js's own MAX_PREFETCHED_PATHS reasoning --
      // this is meant to give the model a real candidate list, not the whole repo's
      // worth of paths crammed into one prompt.
      fileList: fileList.slice(0, 400),
      // Read by applyPathPrefetchResolve() to know which flag/counter to advance on
      // completion -- see its own comment for why this can't just reuse
      // suggestionAttempted/highReasoningAttempted (both are already true by the time
      // this tier fires).
      periodicReattempt: isPeriodicReattempt,
    },
  };
}

module.exports = { listHeldTasksFifo, deriveResolveIdentity, selfHealResolveDeadlock, buildResolveTask };
