'use strict';

// One policy for "may the pipeline put anything on the remote's main branch by itself?".
//
// 2026-09-19, Grimmethy: "Nothing should ever go to github main like that without a gate
// step." An arch_discovery candidate-doc append (a reviewed-by-3-LLM-votes doc) had been
// committed and pushed straight to origin/main of a repo, unattended, ~30s after approval.
// The only sanctioned way onto main is now a HUMAN merge (the dashboard's merge button, or a
// PR): the pipeline pushes BRANCHES only.
//
//  - directToMain sources (candidate docs, *_review triage) no longer commit to main; they
//    append onto ONE rolling branch (TRIAGE_BRANCH) that a human merges. One shared branch,
//    not one per task, because every task appends to the same Docs/*_CANDIDATES.md and
//    independent branches would conflict at the end of that file.
//  - the coordinator no longer auto-merges "verified mechanical moves" into main.
//  - resetToMain never fast-forwards origin/main to a local-ahead main (it rescues those
//    commits to a branch instead); pushMain refuses outright.
//
// Opt-out (restores the old ungated behavior everywhere): AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true.
const TRIAGE_BRANCH = 'agent/triage-queue';

function ungatedMainPushAllowed() {
  return process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH === 'true';
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The gate itself (HUB0364 piece 2): a main write is allowed only when the exact commit being written has a READY record.
//
// READY record = the Unmerged Branches verdict store, <pipelineDir>/queue/branch-verdicts.json (python/dashboard/branch_verdicts.py), shaped
// { <branch>: { <headSha>: { verdict, reasons, source, verifiedAt } } }. Only a `merge` verdict from a human source (`chat` or `manual`) counts,
// because a deterministic or worker verdict is never a real review (branch_verdicts.py: "A deterministic check NEVER produces merge: green needs a
// real review"). The key is the full head sha, so a verdict for an older commit cannot vouch for a newer one.
//
// Every refusal appends one line to <pipelineDir>/queue/main-push-ledger.jsonl (same append-only, best-effort shape as branch-removals.jsonl).
// The only bypass is AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true, which warns on stderr and writes nothing.
// Optional: AGENT_MANAGER_MAIN_PUSH_READY_MAX_AGE_HOURS (a positive number) refuses a record older than that; unset means no age limit.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const HUMAN_VERDICT_SOURCES = ['chat', 'manual'];
const LEDGER_FILE = 'main-push-ledger.jsonl';

function pipelineDirOf(context) {
  if (context && context.pipelineDir) return context.pipelineDir;
  return require('../config.js').getConfig().pipelineDir; // lazy: this module stays importable without loading config
}

function appendLedger(pipelineDir, entry) {
  try {
    const file = path.join(pipelineDir, 'queue', LEDGER_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return true;
  } catch (err) {
    console.warn(`[main-push-policy] could not write the ledger row for ${entry.branch}: ${err.message}`);
    return false;
  }
}

// Why this (branch, headSha) is not READY, or null when it is.
function notReadyReason(store, branch, headSha, now) {
  const record = store && store[branch] && store[branch][headSha];
  if (!record) return `no verdict recorded for ${branch} at ${headSha}`;
  if (record.verdict !== 'merge') return `the verdict for ${branch} at ${headSha} is '${record.verdict}', not 'merge'`;
  if (!HUMAN_VERDICT_SOURCES.includes(record.source)) return `the merge verdict for ${branch} at ${headSha} comes from '${record.source}', not a human source (chat or manual)`;
  const at = Date.parse(record.verifiedAt);
  if (!Number.isFinite(at)) return `the merge verdict for ${branch} at ${headSha} has no valid verifiedAt timestamp`;
  const maxHours = Number(process.env.AGENT_MANAGER_MAIN_PUSH_READY_MAX_AGE_HOURS);
  if (Number.isFinite(maxHours) && maxHours > 0 && now.getTime() - at > maxHours * 3600 * 1000) {
    return `the merge verdict for ${branch} at ${headSha} is older than ${maxHours} hour(s)`;
  }
  return null;
}

// Throws (error.code 'MAIN_PUSH_NOT_READY') unless a READY record exists for exactly this branch and head sha. Returns { allowed: true, bypass } otherwise.
// context: { caller?, taskId?, pipelineDir?, now? } -- caller and taskId only label the ledger row.
function assertMainPushReady(branch, headSha, context = {}) {
  if (ungatedMainPushAllowed()) {
    console.warn(`[main-push-policy] AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true: allowing a main write for ${branch}@${headSha} without a READY record (caller: ${context.caller || 'unknown'})`);
    return { allowed: true, bypass: true };
  }
  const pipelineDir = pipelineDirOf(context);
  const now = context.now || new Date();
  let store = {};
  try { store = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'branch-verdicts.json'), 'utf8')); } catch { /* missing or unreadable store = no READY record */ }
  const reason = !branch || !headSha ? 'branch and headSha are both required' : notReadyReason(store, branch, headSha, now);
  if (!reason) return { allowed: true, bypass: false };
  appendLedger(pipelineDir, { at: now.toISOString(), outcome: 'refused', branch: branch || null, headSha: headSha || null, caller: context.caller || null, taskId: context.taskId || null, reason });
  const err = new Error(`main write refused: ${reason}. A main write needs a READY record (a chat or manual merge verdict) for the exact head sha; set AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true only to bypass on purpose.`);
  err.code = 'MAIN_PUSH_NOT_READY';
  throw err;
}

module.exports = { TRIAGE_BRANCH, ungatedMainPushAllowed, assertMainPushReady };
