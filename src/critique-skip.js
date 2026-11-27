'use strict';

// Critique-skip predicate (HUB0656 1/3).
//
// shouldSkipCritique(task, worklog, writeSet) returns true only when every check below passes.
// It is pure: no file I/O, no network, no timers. The caller (HUB0656 3/3) supplies all inputs.
//
// Sources actually read for this module: src/work-log.js.
//   - worklog document: { taskId, updatedAt, tiers: [{ tier, at, turnsUsed, callCount, calls, finalMessage? }] }
//   - call entry: { n, tool, args, resultBytes, resultPreview?, error? }; args values are strings.
//   - a tier slimmed by slimTier() carries truncated: true and no args/resultPreview, so it is unverifiable.
//
// GAPS (not verified against any producer; the predicate fails closed on them):
//   - Where the task-side tier is stored is unconfirmed. If task.tier is present it must equal
//     'local-agentic-write', or the predicate returns false.
//   - The implement outcome object is not confirmed. This module reads task.implementOutcome and
//     requires blocked, degenerate, and truncated to be falsy. Whether a real outcome carries
//     these field names is unverified. If implementOutcome is absent, the predicate returns false.
//   - No forbidden-path or scope-violation record shape is known. The predicate therefore requires
//     the caller to supply task.implementOutcome.forbiddenPathCheck === 'passed' and
//     task.implementOutcome.scopeCheck === 'passed'. This is a contract for the caller, not a
//     verified field.
//   - node --check pass status is read from the JSON in resultPreview (exitCode === 0). The producer
//     of resultPreview is not re-read here. Commands containing '||' or ';' are rejected, because a
//     chained exit status cannot prove every node --check passed.
//   - writeSet is supplied by the caller.

const TIER = 'local-agentic-write';

function normPath(p) {
  if (typeof p !== 'string' || p.trim() === '') return null;
  return p.trim().replace(/^\.\//, '');
}

// Paths that have a passing `node --check` in a non-slimmed tier.
function passingNodeChecks(tier) {
  const passed = new Set();
  for (const call of tier.calls || []) {
    if (!call || call.tool !== 'run_bash' || call.error) continue;
    const command = call.args && typeof call.args.command === 'string' ? call.args.command : '';
    if (!command || (!command.includes('node --check'))) continue;
    if (command.includes('||') || command.includes(';')) continue;
    let exitCode;
    try {
      const parsed = JSON.parse(call.resultPreview);
      exitCode = parsed && parsed.exitCode;
    } catch {
      continue;
    }
    if (exitCode !== 0) continue;
    const re = /(?:^|\s)node\s+--check\s+(\S+)/g;
    let m;
    while ((m = re.exec(command)) !== null) {
      const p = normPath(m[1]);
      if (p) passed.add(p);
    }
  }
  return passed;
}

function shouldSkipCritique(task, worklog, writeSet) {
  try {
    if (!task || typeof task !== 'object') return false;
    if (task.tier !== undefined && task.tier !== TIER) return false;

    if (!Array.isArray(writeSet) || writeSet.length === 0) return false;
    const files = writeSet.map(normPath);
    if (files.some((f) => f === null)) return false;

    if (!worklog || typeof worklog !== 'object' || !Array.isArray(worklog.tiers)) return false;
    const tiers = worklog.tiers.filter((t) => t && t.tier === TIER);
    if (tiers.length === 0) return false;
    const tier = tiers[tiers.length - 1];
    if (tier.truncated === true) return false;

    const outcome = task.implementOutcome;
    if (!outcome || typeof outcome !== 'object') return false;
    if (outcome.blocked || outcome.degenerate || outcome.truncated) return false;
    if (outcome.forbiddenPathCheck !== 'passed' || outcome.scopeCheck !== 'passed') return false;

    const checked = passingNodeChecks(tier);
    return files.every((f) => checked.has(f));
  } catch {
    return false;
  }
}

module.exports = { shouldSkipCritique };
