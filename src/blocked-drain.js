'use strict';

// Auto-drain: once a fix for a specific failure signature is confirmed AND actually
// applied (a real diff landed on a real branch), automatically requeue every currently-stuck
// task sharing that exact signature.
//
// Two callers (apply-task.js):
//   - pipeline_self_audit    -> dirs: ['blocked']
//   - pipeline_forensics_fix -> dirs: ['blocked', 'needs-clarification']
//
// Zero-hit cap: a task whose harness search returned 0 hits is a harness-side symptom that a
// blind requeue reproduces often. Only ZERO_HIT_REQUEUE_CAP such tasks are requeued per call;
// the rest stay in blocked/ and get a suppression attribution record. Non-zero-hit tasks are
// never capped.

const fs = require('fs');
const path = require('path');
const { signatureForTask } = require('./pipeline-self-audit.js');
const { signatureForClarificationTask } = require('./pipeline-forensics.js');
const { appendHistoryEvent } = require('./task-history.js');
const { classifyRequeue, recordSuppression } = require('./requeue-attribution.js');
const { hasZeroHitHarnessSearch } = require('./blocked-task-classifiers.js');

const ZERO_HIT_REQUEUE_CAP = 1;

// A task matches if EITHER derivation lands on the signature.
function taskMatchesSignature(data, signature) {
  return signatureForTask(data) === signature || signatureForClarificationTask(data) === signature;
}

// pipelineDir, signature, { dirs } -- dirs defaults to ['blocked'].
function requeueBlockedTasksForSignature(pipelineDir, signature, { dirs = ['blocked'] } = {}) {
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  const requeuedIds = [];
  const nowIso = new Date().toISOString();
  const nonZeroHit = [];
  const zeroHit = [];

  // Pass 1: collect and classify eligible tasks. Nothing is written here, so listing order
  // cannot change which tasks are eligible or how they are bucketed.
  for (const dir of dirs) {
    const stateDir = path.join(pipelineDir, 'queue', dir);
    let names;
    try {
      names = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue; // dir doesn't exist yet -- nothing to drain from it
    }

    for (const name of names) {
      const filePath = path.join(stateDir, name);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        console.warn(`[blocked-drain] skipping unreadable or malformed state file: ${filePath} -- ${err.message}`);
        continue;
      }
      if (!taskMatchesSignature(data, signature)) continue;

      // reviewInconclusive marks a re-roll-worthy gate flake, not a fixable rejection cluster.
      if (data.reviewInconclusive) continue;

      // reason:'design-decision' is a genuine human question unless it came from retry exhaustion.
      const isDesignDecision = data.needsClarification && data.needsClarification.reason === 'design-decision';
      const fromRetryExhaustion = Array.isArray(data.history)
        && data.history.some((h) => (h.stage || h.status) === 'exhausted');
      if (isDesignDecision && !fromRetryExhaustion) continue;

      // At most once per distinct signature.
      const already = Array.isArray(data.requeuedForSignatures) ? data.requeuedForSignatures : [];
      if (already.includes(signature)) continue;

      const candidate = { dir, name, filePath, data, already };
      if (hasZeroHitHarnessSearch(data)) zeroHit.push(candidate);
      else nonZeroHit.push(candidate);
    }
  }

  // Pass 2: act on the completed buckets.
  const requeue = (c) => {
    const { dir, name, filePath, data, already } = c;
    const destPath = path.join(pendingDir, name);
    // Re-checked here because an earlier requeue in this same call may have just written it.
    if (fs.existsSync(destPath)) return false;

    data.retryPromptContext = {
      blockedReason: data.blockedReason || null,
      mostRecentRejection: (Array.isArray(data.priorRejectionFeedback) && data.priorRejectionFeedback.length) ? data.priorRejectionFeedback[data.priorRejectionFeedback.length - 1] : null,
      allPriorRejections: Array.isArray(data.priorRejectionFeedback) ? data.priorRejectionFeedback : [],
      stampedAt: nowIso,
      stampedBy: 'blocked-drain',
    };

    const fresh = {
      id: data.id,
      domain: data.domain,
      source: data.source,
      title: data.title,
      promptContext: data.promptContext,
      retryPromptContext: data.retryPromptContext,
      requeuedForSignatures: [...already, signature],
      status: 'pending',
      createdAt: nowIso,
      history: [],
    };
    appendHistoryEvent(fresh, 'pending', `auto-requeued from ${dir}/: the fix for "${signature}" was confirmed and applied`);
    appendHistoryEvent(fresh, 'retry-context-stamped', data.retryPromptContext.mostRecentRejection || 'no prior rejections');

    classifyRequeue(data, { reasonHint: signature, requeueWriter: 'blocked-drain', repoRoot: pipelineDir })
      .catch(() => { /* non-fatal, see requeue-attribution.js's own header */ });

    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(destPath, JSON.stringify(fresh, null, 2));
    fs.unlinkSync(filePath);
    requeuedIds.push(data.id);
    return true;
  };

  const suppress = (c) => {
    // Best-effort attribution only. The task file is left untouched in blocked/ and its
    // signature is NOT recorded, so it stays eligible for a later drain.
    try {
      const r = recordSuppression(c.data, { reasonHint: signature, requeueWriter: 'blocked-drain', repoRoot: pipelineDir });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* non-fatal side write */
    }
  };

  for (const c of nonZeroHit) requeue(c);

  let zeroHitRequeued = 0;
  for (const c of zeroHit) {
    if (zeroHitRequeued >= ZERO_HIT_REQUEUE_CAP) {
      suppress(c);
      continue;
    }
    if (requeue(c)) zeroHitRequeued += 1;
  }

  return { requeuedIds };
}

module.exports = { requeueBlockedTasksForSignature };
