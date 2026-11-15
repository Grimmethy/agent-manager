'use strict';

// Hub stickiness (HUB0402 subtask 3): isHubBlocked() says whether a candidate task's hub (its stacked.branch) is currently held by another node.
// It returns true when a live lease (state 'lent', expiresAt after now) held by a node other than the claimant sits on a task whose record has the same stacked.branch as the candidate.
// Read-only: it writes no records and stamps no owner field on any record (that belongs to the stamping subtask).
// Per lease row, the claimant's own leases are skipped; if another node holds a same-branch lease, the result is true even when the claimant also holds one (literal per-row reading of the contract).

const fs = require('fs');
const { listLeases } = require('./lease-ledger.js');

// Same liveness rule as lease-ledger.js isLive (not exported there).
function isLive(lease, nowMs) {
  return Boolean(lease) && lease.state === 'lent' && Date.parse(lease.expiresAt) > nowMs;
}

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

// Default record reader: the queue file of a task under AGENT_MANAGER_PIPELINE_DIR, or null when it cannot be found or parsed.
function defaultReadRecord(taskId, env) {
  const pipelineDir = String((env || process.env).AGENT_MANAGER_PIPELINE_DIR || '').trim();
  if (!pipelineDir) return null;
  const { findRecordFile } = require('./lend-task.js');
  const file = findRecordFile(pipelineDir, taskId);
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function isHubBlocked(candidateRecord, claimant, now, options = {}) {
  const candidateBranch = candidateRecord && candidateRecord.stacked ? candidateRecord.stacked.branch : undefined;
  if (!candidateBranch) return false; // a record without a branch cannot be blocked by branch
  const nowMs = toMs(now);
  const leases = Array.isArray(options.leases) ? options.leases : listLeases(options.env);
  const readRecord = options.readRecord || ((taskId) => defaultReadRecord(taskId, options.env));
  for (const lease of leases) {
    if (!isLive(lease, nowMs)) continue;
    if (lease.nodeId === claimant) continue;
    const rec = readRecord(lease.taskId); // caller's reader errors propagate
    if (!rec) continue; // branch unknown for this lease
    if (rec.stacked && rec.stacked.branch === candidateBranch) return true;
  }
  return false;
}

module.exports = { isHubBlocked };
