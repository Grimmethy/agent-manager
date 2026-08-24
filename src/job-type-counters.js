'use strict';

// Cumulative "how many times has this job type run" counters (Job List tab, 2026-08-23:
// "we should add a field that tracks how many times each job type has been performed").
// A long-term debugging tool, not a lifecycle-scoped stat: it survives task deletion,
// archiving, and requeueing untouched -- the only writes are (a) writeTask() incrementing
// the count for whichever source just generated a task, and (b) a manual reset that clears
// EVERY source's count at once (never a single source in isolation), so the counters stay
// mutually comparable as one shared baseline instead of drifting into per-type baselines
// that mean different things depending on when each was last reset.

const fs = require('fs');
const path = require('path');

function readCounters(countersPath) {
  try {
    const raw = fs.readFileSync(countersPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCounters(countersPath, counters) {
  fs.mkdirSync(path.dirname(countersPath), { recursive: true });
  fs.writeFileSync(countersPath, JSON.stringify(counters, null, 2));
}

// Increments and persists the counter for `sourceName`, returning the new (post-increment)
// value -- this is the value writeTask() stamps onto the task record at creation time.
function incrementJobTypeCounter(countersPath, sourceName) {
  const counters = readCounters(countersPath);
  const next = (counters[sourceName] || 0) + 1;
  counters[sourceName] = next;
  writeCounters(countersPath, counters);
  return next;
}

// Zeroes every source's counter at once -- see header for why this is deliberately
// all-or-nothing rather than per-source.
function resetAllJobTypeCounters(countersPath) {
  const counters = readCounters(countersPath);
  for (const name of Object.keys(counters)) counters[name] = 0;
  writeCounters(countersPath, counters);
  return counters;
}

module.exports = { readCounters, incrementJobTypeCounter, resetAllJobTypeCounters };
