'use strict';

// Pure lease-release rule for tasks lent to a node that never got claimed.
// No clock, env, fs or timers here: the caller passes nowMs, the lease rows
// (from src/lease-ledger.js listLeases(), keyed by taskId) and the options.

const REASON = 'unclaimed-on-node';
const DEFAULT_UNCLAIMED_MIN = 60;

function thresholdMs(opts) {
  let min = opts.unclaimedMin;
  if (min === undefined) {
    const raw = opts.env ? opts.env.AGENT_MANAGER_NODE_UNCLAIMED_MIN : undefined;
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    min = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_UNCLAIMED_MIN;
  }
  if (!Number.isFinite(min) || min < 0) {
    throw new TypeError('unclaimedMin must be a non-negative finite number');
  }
  return min * 60000;
}

// A record is protected while it is being drafted or still sends a heartbeat.
function isProtected(rec) {
  return rec.drafting === true || rec.status === 'drafting' || rec.heartbeat != null;
}

// Returns { released, kept }. released entries are { taskId, nodeId, reason, record }.
// The input records are not mutated; the caller applies the release.
function applySlotReleases(records, nowMs, opts = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be a finite number');
  const options = opts || {};
  const leases = options.leases && typeof options.leases === 'object' ? options.leases : {};
  const limit = thresholdMs(options);
  const released = [];
  const kept = [];
  for (const rec of records) {
    if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string') continue;
    if (!rec.leasedTo) { kept.push(rec); continue; }
    if (rec.claimedAt || isProtected(rec)) { kept.push(rec); continue; }
    const lease = leases[rec.id];
    const leasedAt = lease && lease.state === 'lent' ? Date.parse(lease.leasedAt) : NaN;
    if (!Number.isFinite(leasedAt)) { kept.push(rec); continue; }
    if (nowMs - leasedAt > limit) {
      released.push({ taskId: rec.id, nodeId: rec.leasedTo, reason: REASON, record: rec });
    } else {
      kept.push(rec);
    }
  }
  return { released, kept };
}

module.exports = { applySlotReleases, REASON, DEFAULT_UNCLAIMED_MIN };
