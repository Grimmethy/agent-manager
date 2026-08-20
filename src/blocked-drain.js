'use strict';

// Auto-drain: once a pipeline_self_audit fix for a specific failure signature is
// confirmed AND actually applied (a real diff landed on a real branch, not the earlier
// unconfirmed pass and not a "nothing groundable" no-op), automatically requeue every
// currently-blocked task sharing that exact signature -- closing the loop
// detect -> fix -> drain end to end instead of relying on a human to notice the fix
// landed and manually requeue the affected tasks by hand (as this session's own
// maintainer had to do for the grep-codebase-tool.js fix, 2026-08-19 -- 31 tasks,
// one-by-one, via the dashboard's requeue endpoint).
//
// Grimmethy, 2026-08-20: "What kind of mechanism can we use to change the reasoning
// models approach to blocked tasks that allow them to drain?"

const fs = require('fs');
const path = require('path');
const { signatureForTask } = require('./pipeline-self-audit.js');

// Re-derives each blocked task's signature fresh (not by matching on a stored field --
// none exists on these tasks, they predate the fix that found them) using the SAME
// categorization pipeline_self_audit's own detector uses, so "which tasks does this fix
// cover" is always answered consistently with "which tasks were counted into the cluster
// in the first place."
function requeueBlockedTasksForSignature(pipelineDir, signature) {
  const blockedDir = path.join(pipelineDir, 'queue', 'blocked');
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');

  let names;
  try {
    names = fs.readdirSync(blockedDir).filter((f) => f.endsWith('.json'));
  } catch {
    return { requeuedIds: [] };
  }

  const requeuedIds = [];
  const nowIso = new Date().toISOString();
  for (const name of names) {
    const filePath = path.join(blockedDir, name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue; // an unreadable/malformed blocked file is not this drain's problem to fix
    }
    if (signatureForTask(data) !== signature) continue;

    // Same "strip to a fresh pending shape" reset the dashboard's own manual requeue
    // endpoint uses (python/dashboard/app.py's api_task_requeue) -- every drafting/review
    // artifact dropped, ornithRejectCount implicitly reset to 0 (field simply absent), a
    // deliberate do-over rather than a continuation of whatever retry cycle blocked it
    // before this fix existed.
    const fresh = {
      id: data.id,
      domain: data.domain,
      source: data.source,
      title: data.title,
      promptContext: data.promptContext,
      status: 'pending',
      createdAt: nowIso,
      history: [{
        status: 'pending', at: nowIso,
        note: `auto-requeued: pipeline_self_audit's fix for "${signature}" was confirmed and applied`,
      }],
    };

    const destPath = path.join(pendingDir, name);
    if (fs.existsSync(destPath)) continue; // already has a pending entry -- don't clobber it

    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(destPath, JSON.stringify(fresh, null, 2));
    fs.unlinkSync(filePath);
    requeuedIds.push(data.id);
  }

  return { requeuedIds };
}

module.exports = { requeueBlockedTasksForSignature };
