'use strict';

// Node-side claim (multi-node plan): picks the next task this node may take from the given pipelines, leases it
// (src/lease-ledger.js) and stamps leasedTo on wok's own record (same shape as lendTask in src/lend-task.js).
// Event-driven: each claimNext call is one claim attempt. Nothing here polls, sets timers or spawns processes.
//
// Defaults: nodeId = AGENT_MANAGER_NODE_ID; classes absent = no class filter; settle absent = no-op;
// readRemote is accepted for the shared contract and is not used by this claim path yet.

const fs = require('fs');
const path = require('path');
const { pickClaimableTasks } = require('./next-claimable-task.js');
const { isDependencySatisfied } = require('./task-sources.js');
const { findRecordFile } = require('./lend-task.js');
const { lendLease, cancelLease, expireLeases, listLeases } = require('./lease-ledger.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// The class of a task record. ASSUMPTION: the record carries taskClass or class; not yet verified against existing records.
function taskClassOf(task) {
  return task.taskClass || task.class || null;
}

function claimNext({ nodeId = process.env.AGENT_MANAGER_NODE_ID, classes, pipelineDirs = [], env = process.env, now = Date.now(), settle, readRemote } = {}) {
  void readRemote;
  if (!nodeId) return null;

  // Overdue leases go back to the pool through settle (expireLeases marks them expired and returns them).
  const expired = expireLeases({ now, env });
  if (typeof settle === 'function') for (const row of expired) settle(row);

  const live = listLeases(env).filter((l) => l && l.state === 'lent' && Date.parse(l.expiresAt) > now);
  const leasedIds = new Set(live.map((l) => l.taskId));
  // Hub stickiness: branches of tasks this node already holds, so a stacked branch keeps going to the same node.
  // Lease rows hold only taskId/nodeId/expiresAt (lendLease does not store the task), so the branch is read from the held task's record.
  const stickyBranches = new Set();
  for (const l of live) {
    if (l.nodeId !== nodeId) continue;
    for (const pipelineDir of pipelineDirs) {
      const file = findRecordFile(pipelineDir, l.taskId);
      const held = file ? readJson(file) : null;
      if (held && held.stacked && held.stacked.branch) { stickyBranches.add(held.stacked.branch); break; }
    }
  }

  const candidates = [];
  const seen = new Set();
  for (const pipelineDir of pipelineDirs) {
    for (const sub of ['pending', 'adhoc']) {
      const dir = path.join(pipelineDir, 'queue', sub);
      // Ranked by pickClaimableTasks with this node as the claimer (pinned-to-node first, then priority and age).
      const names = pickClaimableTasks(dir, nodeId, { nodeId });
      for (const name of names) {
        const task = readJson(path.join(dir, name));
        if (!task || typeof task !== 'object') continue;
        const taskId = name.replace(/\.json$/, '');
        if (seen.has(taskId)) continue;
        seen.add(taskId);
        if (leasedIds.has(taskId)) continue; // leased (unexpired)
        if (task.pinnedWorker && task.pinnedWorker !== nodeId) continue; // pinned to another worker
        if (Array.isArray(task.dependsOn) && task.dependsOn.some((dep) => !isDependencySatisfied(pipelineDir, dep))) continue;
        if (Array.isArray(classes) && !classes.includes(taskClassOf(task))) continue;
        const sticky = Boolean(task.stacked && task.stacked.branch && stickyBranches.has(task.stacked.branch));
        candidates.push({ taskId, pipelineDir, task, sticky });
      }
    }
  }

  // Sticky candidates first; the stable sort keeps the pickClaimableTasks order within each group.
  candidates.sort((a, b) => (b.sticky ? 1 : 0) - (a.sticky ? 1 : 0));

  for (const c of candidates) {
    const lease = lendLease(c.taskId, nodeId, { ttlMs: 3600000, now, env });
    if (!lease) continue; // lost the race to another claimer

    const file = findRecordFile(c.pipelineDir, c.taskId);
    const record = file ? readJson(file) : null;
    if (!record || typeof record !== 'object') {
      cancelLease(c.taskId, { env });
      continue;
    }
    try {
      writeJsonAtomicSync(file, { ...record, leasedTo: nodeId });
    } catch (e) {
      cancelLease(c.taskId, { env });
      continue;
    }
    return { task: { ...record, leasedTo: nodeId }, lease, repo: c.pipelineDir };
  }
  return null;
}

module.exports = { claimNext };
