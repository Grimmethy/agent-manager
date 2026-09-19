'use strict';

// Hub priority (2026-09-09, Grimmethy: "I'd like the hubs to be sortable either
// alphabetically by name or by priority ... Right now Hubs seem to be handled at random
// with new hubs being worked on before old hubs are finished ... The highest priority hub
// should always be worked on next until it is either ready to merge or gets blocked").
//
// A coordinating hub (queue/coordinating/<id>.json) may carry an integer `hubPriority`:
// LOWER means more urgent (same convention as task-source-registry priorities and
// next-claimable-task.js's `priority` sort). It is operator-set from the Hub Tasks tab
// (POST /api/task-anywhere/<id>/hub-priority) and never auto-cleared -- it survives every
// coordinator-sweep reconcile, same discipline as `premiumPriority`.
//
// Ordering rule, used identically by the dashboard's Hub Tasks tab AND by the worker
// claim path (task-sources.js's nextAdhocTask, next-claimable-task.js's ranking) so the
// two can never disagree about which hub is "next":
//
//   1. hubs with an explicit numeric hubPriority, ascending by that number
//   2. then hubs with no hubPriority, oldest-first by `createdAt`
//      (FIFO -- directly answers "new hubs being worked before old hubs are finished")
//
// A hub child inherits its owning hub's key. The child -> hub link is already plumbed
// everywhere: apply-task.js copies promptContext.decomposedFrom onto task.parentHub, and
// every decompose producer (apply-adhoc-diff.js, file-decompose-to-hub.js,
// product-spec-to-hub.js) stamps promptContext.decomposedFrom.

const fs = require('fs');
const path = require('path');

// A hub with no explicit priority sorts AFTER every explicitly-ranked hub. Kept finite so
// callers can do plain arithmetic sorts without special-casing Infinity.
const UNRANKED_HUB_PRIORITY = 1e9;

// Accepts whatever the dashboard route was handed; returns an integer, or null to mean
// "clear it / unranked". Non-finite, non-numeric -> null.
function normalizeHubPriority(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

// The owning-hub id for a task, or null. `parentHub` (stamped by apply-task.js) wins;
// promptContext.decomposedFrom is the raw link every decompose producer writes.
function hubIdForTask(task) {
  if (!task || typeof task !== 'object') return null;
  if (typeof task.parentHub === 'string' && task.parentHub.trim()) return task.parentHub.trim();
  const ctx = task.promptContext;
  if (ctx && typeof ctx.decomposedFrom === 'string' && ctx.decomposedFrom.trim()) return ctx.decomposedFrom.trim();
  return null;
}

// { found, rank, createdAt } for a hub id. `found` is false when no live coordinating
// record exists (the hub already completed and left coordinating/, or the id is a plain
// adhoc parent that never became a hub) -- callers use that to decide whether a child
// still counts as "hub work" for prioritisation.
function readHubOrderKey(pipelineDir, hubId, cache) {
  if (!hubId) return { found: false, rank: UNRANKED_HUB_PRIORITY, createdAt: null };
  if (cache && cache.has(hubId)) return cache.get(hubId);
  let key = { found: false, rank: UNRANKED_HUB_PRIORITY, createdAt: null };
  try {
    const raw = fs.readFileSync(path.join(pipelineDir, 'queue', 'coordinating', `${hubId}.json`), 'utf8');
    const hub = JSON.parse(raw);
    const norm = normalizeHubPriority(hub.hubPriority);
    key = {
      found: true,
      rank: norm === null ? UNRANKED_HUB_PRIORITY : norm,
      createdAt: typeof hub.createdAt === 'string' ? hub.createdAt : null,
    };
  } catch { /* no live hub record -- leave the not-found default */ }
  if (cache) cache.set(hubId, key);
  return key;
}

// The sort key for a task that may be a hub child. `isHubChild` is true only when a LIVE
// coordinating record backs the link, so a child whose hub already shipped falls back to
// ordinary ordering.
function hubOrderKeyForTask(pipelineDir, task, cache) {
  const key = readHubOrderKey(pipelineDir, hubIdForTask(task), cache);
  return { isHubChild: key.found, rank: key.rank, createdAt: key.createdAt };
}

// -1 / 0 / 1 comparing two { rank, createdAt } hub keys by the ordering rule above.
// A missing createdAt sorts last within the same rank.
function compareHubKeys(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const ac = a.createdAt || '￿';
  const bc = b.createdAt || '￿';
  if (ac < bc) return -1;
  if (ac > bc) return 1;
  return 0;
}

// Hub-aware draft sequencing (2026-09-18, pipeline hardening -- Grimmethy: "These hub
// tasks are closely linked in reality, they should be closely linked in the code").
//
// Root-caused live: a 3-sub-task hub (add a gate carve-out -> guard the review path
// against it -> add tests proving both) had sub-task 2 draft/redraft THREE times while
// sub-tasks 0 and 1 sat at `pending-merge` -- approved and applied, but not yet actually
// merged into master. Every attempt hit the same wall: sub-task 2's own review ran
// against a checkout that didn't have sub-tasks 0/1's code yet, so the very behavior
// sub-task 2 was written to test (and needs present to pass its own review) simply wasn't
// there. dependsOn (see isDependencySatisfied's own header in task-sources.js) exists
// for exactly this and was even declared on the stuck task -- but its `stacked`-branch
// exemption reported the dependency satisfied the moment the prerequisite reached
// queue/done/, without confirming the REVIEW environment could actually see that code.
// A single dependsOn edge is also only as complete as whoever authored the decompose
// remembered to declare -- sub-task 2 here named only ONE of its two real prerequisites.
//
// This is a coarser, more conservative safety net that doesn't depend on either of those
// being right: a hub's own subTasks array is already an ordered checklist (decompose
// naturally produces build -> wire -> test sequences), so a child should not be drafted
// while an EARLIER-ordered sibling in the SAME hub hasn't actually landed on main yet --
// regardless of whether a fine-grained dependsOn edge names it. It sits alongside
// dependsOn, not in place of it; either one blocking is enough to hold a candidate.
//
// Resolved = no code from this sibling will EVER land on main, so there's nothing left
// to wait for. This is the full TERMINAL_STAGES set from task-disposition.js minus
// 'pending-merge' (the one terminal stage that means "real code exists and genuinely
// hasn't landed yet" -- the whole reason this check exists), plus classifyChildStatus's
// own 'gone' (record missing entirely). Confirmed live via a dry run against the real
// queue before this shipped: 8 real tasks across 5 hubs would have been held FOREVER
// without this -- each one's "earlier sibling" had already resolved as 'noop' (no code
// change was needed) or similar, so waiting for it to reach 'merged' specifically would
// never happen; that's a brand-new permanent deadlock, the exact failure class this
// feature exists to close, not open.
//   merged          -- landed on main, obviously resolved
//   applied-direct  -- committed straight to main (directToMain sources), already there
//   filed           -- apply wrote a doc/candidate-list entry, no branch was ever created
//   dismissed       -- reviewed and dismissed as a false positive, no code was produced
//   noop            -- apply concluded no change was needed
//   abandoned       -- branch gone, work lost -- a human already accepted that outcome
//   superseded      -- this task record's own identity is moot; whatever superseded it
//                      is a SEPARATE record this check will see on its own merits
//   gone            -- the task record can't be found at all (aged out, hand-removed)
const SIBLING_RESOLVED_STATUSES = new Set([
  'merged', 'applied-direct', 'filed', 'dismissed', 'noop', 'abandoned', 'superseded', 'gone',
]);

// { blocked, blockingSiblingId?, blockingSiblingStatus? } for a task that may be a hub
// child. `blocked: false` when the task isn't a hub child, its hub record can't be read,
// it isn't listed in the hub's own subTasks, or it's first in that list (nothing earlier
// to wait on). Otherwise reports the first (lowest-indexed) earlier sibling whose status
// isn't in SIBLING_RESOLVED_STATUSES yet.
function hubHasUnmergedEarlierSibling(pipelineDir, task) {
  const hubId = hubIdForTask(task);
  if (!hubId) return { blocked: false };
  const taskId = task && typeof task.id === 'string' ? task.id : null;
  if (!taskId) return { blocked: false };

  let hub;
  try {
    hub = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'coordinating', `${hubId}.json`), 'utf8'));
  } catch {
    return { blocked: false }; // no live hub record -- nothing to sequence against
  }
  const subTasks = Array.isArray(hub.subTasks) ? hub.subTasks : [];
  const myIndex = subTasks.findIndex((s) => s && s.id === taskId);
  if (myIndex <= 0) return { blocked: false }; // not listed, or first in order

  for (let i = 0; i < myIndex; i += 1) {
    const sib = subTasks[i];
    if (!sib || !sib.status) continue;
    if (!SIBLING_RESOLVED_STATUSES.has(sib.status)) {
      return { blocked: true, blockingSiblingId: sib.id, blockingSiblingStatus: sib.status };
    }
  }
  return { blocked: false };
}

module.exports = {
  UNRANKED_HUB_PRIORITY,
  normalizeHubPriority,
  hubIdForTask,
  readHubOrderKey,
  hubOrderKeyForTask,
  compareHubKeys,
  hubHasUnmergedEarlierSibling,
};
