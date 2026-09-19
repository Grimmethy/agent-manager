'use strict';

// Background task generation (the task-sources.js CLI, run by every worker lane each tick) is
// throttled so a slow drafter can't be buried under an unbounded pile of pending/ tasks. Bound:
// tasks in flight (pending/ + every lane's drafting/) < number of LIVE worker lanes. Lanes are one
// per GPU (src/lanes.js) and every lane claims any task, so N live lanes can usefully hold N
// tasks. (History: this was "any in-flight task blocks generation", then per-tier per-lane
// (2026-09-19 -- one task on the P40 lane left the 3090 lane idle); the tier split is gone.)

const fs = require('fs');
const path = require('path');

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Live worker lanes, per heartbeat files whose pid is still alive. Never below 1: an
// unreadable/empty instances dir must fall back to one-in-flight rather than opening generation
// without bound.
function liveLaneCount(instancesDir) {
  let count = 0;
  try {
    for (const f of fs.readdirSync(instancesDir)) {
      if (!f.startsWith('worker-') || !f.endsWith('.json')) continue;
      try {
        const hb = JSON.parse(fs.readFileSync(path.join(instancesDir, f), 'utf8'));
        if (hb.pid && pidAlive(hb.pid)) count += 1;
      } catch {
        // unreadable heartbeat -- not counted
      }
    }
  } catch {
    // no instances dir -- fall through to the floor below
  }
  return Math.max(1, count);
}

function generationThrottled(inFlightCount, instancesDir) {
  return inFlightCount >= liveLaneCount(instancesDir);
}

module.exports = { liveLaneCount, generationThrottled };
