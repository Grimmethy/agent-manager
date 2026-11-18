'use strict';

// Node-side claim (multi-node plan): picks the next task this node may take from the given pipelines, leases it
// (src/lease-ledger.js) and stamps leasedTo on wok's own record (same shape as lendTask in src/lend-task.js).
// Event-driven: each claimNext call is one claim attempt. Nothing here polls, sets timers or spawns processes.
//
// Defaults: claimant = nodeId = AGENT_MANAGER_NODE_ID; classes absent = no class filter; settle absent = no-op;
// readRemote = readRemoteUrl (src/remote-url.js), its result is kept on repo.remoteUrl ('' on failure).
// The unleased pool is ranked by pickClaimableTasks with the LEDGER OWNER as the worker (not the claimant), the same
// id claimableOnNode uses. Each pipeline dir's pending and adhoc lists keep their own pickClaimableTasks order, and
// those lists are merged globally by rankPriorityResolved (src/rank-priority.js), ties broken by file mtime then by
// list order. A candidate that isHubBlocked (src/hub-stickiness.js) or that cannot be lent is skipped and
// recorded in the skipped array; the scan continues with the next candidate.
//
// Filtered pipeline dirs (AGENT_MANAGER_NODE_FILTERED_DIRS, comma separated; AGENT_MANAGER_NODE_FILTER_SOURCES and AGENT_MANAGER_NODE_ALLOW_STACKED widen it, see eligibleForNode): a task in such a dir is claimed only when
// eligibleForNode holds (source 'manual', not stacked, domain in AGENT_MANAGER_NODE_FILTER_DOMAINS (default ['adhoc']),
// and filed for this repo or unscoped). Other tasks there are recorded in skipped as 'not-eligible-for-node'.
// Pipeline dirs not listed in AGENT_MANAGER_NODE_FILTERED_DIRS are unfiltered, exactly as before.
// AGENT_MANAGER_NODE_SKIP_PREMIUM (true, 1 or on, trimmed and case-insensitive; default off) refuses tasks with premiumPriority true in every pipeline dir, filtered or not.

const fs = require('fs');
const path = require('path');
const { pickClaimableTasks } = require('./next-claimable-task.js');
const { isDependencySatisfied } = require('./task-sources.js');
const { findRecordFile } = require('./lend-task.js');
const { lendLease, cancelLease, expireLeases, listLeases } = require('./lease-ledger.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');
const { isHubBlocked } = require('./hub-stickiness.js');
const { readRemoteUrl } = require('./remote-url.js');
const { workerNode } = require('./node-affinity.js');
const { rankPriorityResolved } = require('./rank-priority.js');

// Node eligibility (filtered pipeline dirs only): work this node may take. By default plain manual work: not stacked hub pieces, not
// non-manual sources, not tasks filed for another repo. Premium tasks (premiumPriority true) are refused when skipPremium is on (AGENT_MANAGER_NODE_SKIP_PREMIUM, default off). Two settings widen it (owner decision 2026-11-16, to
// give grimm enough work): `sources` (AGENT_MANAGER_NODE_FILTER_SOURCES, default ['manual']) and `allowStacked` (AGENT_MANAGER_NODE_ALLOW_STACKED, default false).
// The domain list and the same-repo rule always apply. A stacked piece that is allowed still goes through the hub rules below (sticky branch, dependsOn).
function eligibleForNode(task, { pipelineDir, domains = ['adhoc'], sources = ['manual'], allowStacked = false, skipPremium = false } = {}) {
  if (!task || typeof task !== 'object') return false;
  if (skipPremium === true && task.premiumPriority === true) return false;
  if (!sources.includes(task.source)) return false;
  if (task.stacked && !allowStacked) return false;
  if (!domains.includes(task.domain)) return false;
  if (task.generatedForRepoRoot && path.resolve(task.generatedForRepoRoot) !== path.resolve(pipelineDir)) return false;
  return true;
}

function splitList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Absolute, resolved pipeline dirs listed in AGENT_MANAGER_NODE_FILTERED_DIRS. Unset gives [].
function filteredDirs(env = process.env) {
  return splitList(env.AGENT_MANAGER_NODE_FILTERED_DIRS).map((d) => path.resolve(d));
}

// Domains a node may take from filtered dirs (AGENT_MANAGER_NODE_FILTER_DOMAINS). Unset or empty gives ['adhoc'].
function filterDomains(env = process.env) {
  const list = splitList(env.AGENT_MANAGER_NODE_FILTER_DOMAINS);
  return list.length ? list : ['adhoc'];
}

// Sources a node may take from filtered dirs (AGENT_MANAGER_NODE_FILTER_SOURCES). Unset or empty gives ['manual'].
function filterSources(env = process.env) {
  const list = splitList(env.AGENT_MANAGER_NODE_FILTER_SOURCES);
  return list.length ? list : ['manual'];
}

// True when a node may take stacked hub pieces from filtered dirs (AGENT_MANAGER_NODE_ALLOW_STACKED = true, 1 or on). Anything else is false.
function allowStackedFrom(env = process.env) {
  return ['true', '1', 'on'].includes(String(env.AGENT_MANAGER_NODE_ALLOW_STACKED || '').trim().toLowerCase());
}

// True when a node must refuse premium-priority tasks (AGENT_MANAGER_NODE_SKIP_PREMIUM = true, 1 or on). Anything else, including unset, is false.
function skipPremiumFrom(env = process.env) {
  return ['true', '1', 'on'].includes(String(env.AGENT_MANAGER_NODE_SKIP_PREMIUM || '').trim().toLowerCase());
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch (e) { return Infinity; }
}

// The class of a task record. ASSUMPTION: the record carries taskClass or class; not yet verified against existing records.
function taskClassOf(task) {
  return task.taskClass || task.class || null;
}

// Orders two candidates: sticky first, then lower rank priority, then older mtime. Negative = a is claimed first.
function compareCandidates(a, b) {
  if (a.sticky !== b.sticky) return a.sticky ? -1 : 1;
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs < b.mtimeMs ? -1 : 1;
  return 0;
}

// Merges ordered per-directory lists into one list. Each list keeps its own order: only list heads are compared,
// and on a full tie the earlier list wins.
function mergeCandidateLists(lists) {
  const queues = lists.map((list) => list.slice());
  const out = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < queues.length; i++) {
      if (queues[i].length === 0) continue;
      if (best < 0 || compareCandidates(queues[i][0], queues[best][0]) < 0) best = i;
    }
    if (best < 0) break;
    out.push(queues[best].shift());
  }
  return out;
}

function claimNext({ nodeId = process.env.AGENT_MANAGER_NODE_ID, claimant = nodeId, classes, pipelineDirs = [], env = process.env, now = Date.now(), settle, readRemote = readRemoteUrl, skipped = [] } = {}) {
  if (!claimant) return null;
  // Same owner id claimableOnNode uses: AGENT_MANAGER_NODE_ID, or 'wok' when unset.
  const ownerId = workerNode(env.AGENT_MANAGER_NODE_ID);

  // Overdue leases go back to the pool through settle (expireLeases marks them expired and returns them).
  const expired = expireLeases({ now, env });
  if (typeof settle === 'function') for (const row of expired) settle(row);

  const live = listLeases(env).filter((l) => l && l.state === 'lent' && Date.parse(l.expiresAt) > now);
  const leasedIds = new Set(live.map((l) => l.taskId));
  const readRecord = (taskId) => {
    for (const pipelineDir of pipelineDirs) {
      const file = findRecordFile(pipelineDir, taskId);
      if (file) return readJson(file);
    }
    return null;
  };
  // Hub stickiness: branches of tasks this claimant already holds, so a stacked branch keeps going to the same node.
  // Lease rows hold only taskId/nodeId/expiresAt, so the branch is read from the held task's record.
  const stickyBranches = new Set();
  for (const l of live) {
    if (l.nodeId !== claimant) continue;
    const held = readRecord(l.taskId);
    if (held && held.stacked && held.stacked.branch) stickyBranches.add(held.stacked.branch);
  }

  // Computed once per call: which pipeline dirs are filtered, and the domains allowed there.
  const filtered = new Set(filteredDirs(env));
  const allowedDomains = filterDomains(env);
  const allowedSources = filterSources(env);
  const stackedAllowed = allowStackedFrom(env);
  const skipPremium = skipPremiumFrom(env);

  // One ordered list per pipeline dir and sub-directory. pickClaimableTasks keeps its own order within each list.
  const lists = [];
  const seen = new Set();
  for (const pipelineDir of pipelineDirs) {
    for (const sub of ['pending', 'adhoc']) {
      const dir = path.join(pipelineDir, 'queue', sub);
      // Ranked by pickClaimableTasks with the ledger owner as the worker (pinned first, then priority and age).
      const names = pickClaimableTasks(dir, ownerId, { nodeId: ownerId });
      const list = [];
      for (const name of names) {
        const file = path.join(dir, name);
        const task = readJson(file);
        if (!task || typeof task !== 'object') continue;
        const taskId = name.replace(/\.json$/, '');
        if (seen.has(taskId)) continue;
        // Deliberately before seen.add (not after the classes check): an ineligible copy in a filtered dir must not
        // shadow an eligible same-id record in a later, unfiltered dir.
        // Premium gate for every pipeline dir (filtered or not), so unfiltered dirs cannot lend premium tasks when the knob is on.
        if (skipPremium && task.premiumPriority === true) {
          skipped.push({ taskId, reason: 'premium-skipped' });
          continue;
        }
        if (filtered.has(path.resolve(pipelineDir)) && !eligibleForNode(task, { pipelineDir, domains: allowedDomains, sources: allowedSources, allowStacked: stackedAllowed, skipPremium })) {
          skipped.push({ taskId, reason: 'not-eligible-for-node' });
          continue;
        }
        seen.add(taskId);
        if (leasedIds.has(taskId)) continue; // leased (unexpired)
        if (task.pinnedWorker && task.pinnedWorker !== claimant) continue; // pinned to another worker
        if (Array.isArray(task.dependsOn) && task.dependsOn.some((dep) => !isDependencySatisfied(pipelineDir, dep))) continue;
        if (Array.isArray(classes) && !classes.includes(taskClassOf(task))) continue;
        const sticky = Boolean(task.stacked && task.stacked.branch && stickyBranches.has(task.stacked.branch));
        list.push({ taskId, pipelineDir, task, sticky, rank: rankPriorityResolved(task), mtimeMs: mtimeOf(file) });
      }
      lists.push(list);
    }
  }

  // Global order across directories: sticky first, then rank priority, then mtime (see mergeCandidateLists).
  // Stable partition: every sticky candidate moves to the front; merged order is kept within each group.
  const merged = mergeCandidateLists(lists);
  const candidates = [...merged.filter((c) => c.sticky), ...merged.filter((c) => !c.sticky)];

  for (const c of candidates) {
    if (isHubBlocked(c.task, claimant, now, { leases: listLeases(env), readRecord, env })) {
      skipped.push({ taskId: c.taskId, reason: 'hub-blocked' });
      continue;
    }
    const lease = lendLease(c.taskId, claimant, { ttlMs: 3600000, now, env });
    if (!lease) {
      skipped.push({ taskId: c.taskId, reason: 'already-leased' }); // lost the race to another claimer
      continue;
    }

    const file = findRecordFile(c.pipelineDir, c.taskId);
    const record = file ? readJson(file) : null;
    if (!record || typeof record !== 'object') {
      cancelLease(c.taskId, { env });
      skipped.push({ taskId: c.taskId, reason: 'record-unreadable' });
      continue;
    }
    try {
      writeJsonAtomicSync(file, { ...record, leasedTo: claimant });
    } catch (e) {
      cancelLease(c.taskId, { env });
      skipped.push({ taskId: c.taskId, reason: 'stamp-failed' });
      continue;
    }
    const remoteUrl = readRemote(c.pipelineDir);
    // Handed-out copy only (the wok file above keeps dependsOn). The deps were verified satisfied on wok by the filter
    // above, so their ids are passed as dependsOnResolved, stamped with the same 'now' claimNext already uses.
    const { dependsOn, ...rest } = record;
    const verifiedIds = Array.isArray(dependsOn) ? dependsOn.slice() : [];
    const lent = { ...rest, leasedTo: claimant, dependsOnResolved: { ids: verifiedIds, checkedAt: now } };
    return { task: lent, lease, repo: { root: c.pipelineDir, remoteUrl }, skipped };
  }
  return null;
}

module.exports = { claimNext, eligibleForNode, filteredDirs, filterDomains, filterSources, allowStackedFrom, skipPremiumFrom };
