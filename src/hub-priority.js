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

module.exports = {
  UNRANKED_HUB_PRIORITY,
  normalizeHubPriority,
  hubIdForTask,
  readHubOrderKey,
  hubOrderKeyForTask,
  compareHubKeys,
};
