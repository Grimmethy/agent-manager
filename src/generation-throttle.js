'use strict';

// Background task generation (task-sources.js CLI) is throttled so a slow drafter can't be
// buried under an unbounded pile of pending/ tasks. The throttle used to be "any same-tier
// task in pending/ or drafting/ blocks generation" -- one in-flight task per TIER across all
// lanes -- so with two low-tier lanes (worker-1 on the local GPU, worker-p40 on the P40) a
// claimed task on one lane left the other permanently idle even with work available
// (2026-09-19, PF-Client-Portal first start). The bound is now per LANE: generation stays
// open while fewer tasks are in flight than there are live lanes of that tier.

const fs = require('fs');
const path = require('path');

function laneTier(instanceId) {
  return /^worker-reasoning/.test(instanceId) ? 'high' : 'low';
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Live worker lanes of `tier` ('low'|'high', or 'all' when lane tiers are off), per heartbeat files whose pid is still alive.
// Never below 1: an unreadable/empty instances dir must fall back to the old
// one-in-flight behavior rather than opening generation without bound.
function liveLaneCount(instancesDir, tier) {
  let count = 0;
  try {
    for (const f of fs.readdirSync(instancesDir)) {
      if (!f.startsWith('worker-') || !f.endsWith('.json')) continue;
      try {
        const hb = JSON.parse(fs.readFileSync(path.join(instancesDir, f), 'utf8'));
        const id = hb.instanceId || f.replace(/\.json$/, '');
        if ((tier === 'all' || laneTier(id) === tier) && hb.pid && pidAlive(hb.pid)) count += 1;
      } catch {
        // unreadable heartbeat -- not counted
      }
    }
  } catch {
    // no instances dir -- fall through to the floor below
  }
  return Math.max(1, count);
}

// tierFilter undefined (no --tier) keeps the legacy single-slot behavior; 'all' bounds by every
// live worker lane (lane tiers off -- see lane-tiers.js).
function generationThrottled(inFlightCount, instancesDir, tierFilter) {
  if (!tierFilter) return inFlightCount >= 1;
  return inFlightCount >= liveLaneCount(instancesDir, tierFilter);
}

module.exports = { laneTier, liveLaneCount, generationThrottled };
