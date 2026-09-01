'use strict';

// Auto-drain: once a fix for a specific failure signature is confirmed AND actually
// applied (a real diff landed on a real branch, not an earlier unconfirmed pass and not a
// "nothing groundable" no-op), automatically requeue every currently-stuck task sharing
// that exact signature -- closing the loop detect -> fix -> drain end to end instead of
// relying on a human to notice the fix landed and manually requeue the affected tasks by
// hand (as this session's own maintainer had to do for the grep-codebase-tool.js fix,
// 2026-08-19 -- 31 tasks, one-by-one, via the dashboard's requeue endpoint).
//
// Two callers (apply-task.js):
//   - pipeline_self_audit    -> dirs: ['blocked']
//   - pipeline_forensics_fix -> dirs: ['blocked', 'needs-clarification'] (a forensic study
//     clusters tasks that landed in EITHER state, and matches them with the widened
//     signatureForClarificationTask, so its fix has to sweep both to actually drain them)
//
// Grimmethy, 2026-08-20: "What kind of mechanism can we use to change the reasoning
// models approach to blocked tasks that allow them to drain?"
// Grimmethy, 2026-09-01: "close the auto-requeue gap" -- forensics filed a fix candidate
// and a human confirmed it, but nothing then pulled the studied tasks back once the fix
// landed; that final hop was still manual.

const fs = require('fs');
const path = require('path');
const { signatureForTask } = require('./pipeline-self-audit.js');
const { signatureForClarificationTask } = require('./pipeline-forensics.js');

// Re-derives each stuck task's signature fresh (not by matching on a stored field -- none
// exists on the tasks that predate the fix that found them) using the SAME categorization
// the detectors use, so "which tasks does this fix cover" is always answered consistently
// with "which tasks were counted into the cluster in the first place." A task matches if
// EITHER derivation lands on the signature -- signatureForTask covers the pipeline_self_
// audit clusters, signatureForClarificationTask the (widened) forensic ones.
function taskMatchesSignature(data, signature) {
  return signatureForTask(data) === signature || signatureForClarificationTask(data) === signature;
}

// pipelineDir, signature, { dirs } -- dirs defaults to ['blocked'] (pipeline_self_audit's
// original behaviour); pipeline_forensics_fix passes ['blocked', 'needs-clarification'].
function requeueBlockedTasksForSignature(pipelineDir, signature, { dirs = ['blocked'] } = {}) {
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  const requeuedIds = [];
  const nowIso = new Date().toISOString();

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
      } catch {
        continue; // an unreadable/malformed file is not this drain's problem to fix
      }
      if (!taskMatchesSignature(data, signature)) continue;

      // reason:'design-decision' covers two very different holds:
      //  (a) a GENUINE human question -- the agentic pass emitted RESOLUTION:
      //      needs-human-decision (local-draft.js), or a duplicate / staleness escalation.
      //      No pipeline fix answers "do you want this?" -- leave it for the human.
      //  (b) an AUTO-escalation after the blind-redraft retries were exhausted
      //      (reject-retry-check.js stamps reason:'design-decision' AND an 'exhausted'
      //      history event). That's a DRAFTING failure, not a question -- exactly what a
      //      signature-scoped fix exists to unblock -- so let it requeue (once per
      //      signature, guarded just below, so a wrong bet can't thrash it).
      const isDesignDecision = data.needsClarification && data.needsClarification.reason === 'design-decision';
      const fromRetryExhaustion = Array.isArray(data.history)
        && data.history.some((h) => (h.stage || h.status) === 'exhausted');
      if (isDesignDecision && !fromRetryExhaustion) continue;

      // Requeue a given task at most once per distinct signature: if it re-fails with the
      // SAME signature and a second fix for it lands, don't thrash it; a fix for a
      // genuinely DIFFERENT signature can still pull it back later.
      const already = Array.isArray(data.requeuedForSignatures) ? data.requeuedForSignatures : [];
      if (already.includes(signature)) continue;

      // Same "strip to a fresh pending shape" reset the dashboard's own manual requeue
      // endpoint uses (python/dashboard/app.py's api_task_requeue) -- every drafting/review
      // artifact dropped, localRejectCount implicitly reset to 0 (field simply absent), a
      // deliberate do-over rather than a continuation of whatever retry cycle stuck it
      // before this fix existed.
      const fresh = {
        id: data.id,
        domain: data.domain,
        source: data.source,
        title: data.title,
        promptContext: data.promptContext,
        requeuedForSignatures: [...already, signature],
        status: 'pending',
        createdAt: nowIso,
        history: [{
          status: 'pending', at: nowIso,
          note: `auto-requeued from ${dir}/: the fix for "${signature}" was confirmed and applied`,
        }],
      };

      const destPath = path.join(pendingDir, name);
      if (fs.existsSync(destPath)) continue; // already has a pending entry -- don't clobber it

      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(destPath, JSON.stringify(fresh, null, 2));
      fs.unlinkSync(filePath);
      requeuedIds.push(data.id);
    }
  }

  return { requeuedIds };
}

module.exports = { requeueBlockedTasksForSignature };
