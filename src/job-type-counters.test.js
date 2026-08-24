'use strict';

// Run: node --test src/job-type-counters.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { readCounters, incrementJobTypeCounter, resetAllJobTypeCounters } = require('./job-type-counters.js');

function tmpCountersPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-type-counters-test-'));
  return path.join(dir, 'job-type-counters.json');
}

test('incrementJobTypeCounter starts at 1 and persists across calls', () => {
  const p = tmpCountersPath();
  assert.equal(incrementJobTypeCounter(p, 'adhoc'), 1);
  assert.equal(incrementJobTypeCounter(p, 'adhoc'), 2);
  assert.equal(incrementJobTypeCounter(p, 'adhoc'), 3);
  assert.deepEqual(readCounters(p), { adhoc: 3 });
});

test('incrementJobTypeCounter tracks separate job types independently', () => {
  const p = tmpCountersPath();
  incrementJobTypeCounter(p, 'adhoc');
  incrementJobTypeCounter(p, 'adhoc');
  incrementJobTypeCounter(p, 'research_task');
  assert.deepEqual(readCounters(p), { adhoc: 2, research_task: 1 });
});

test('readCounters returns {} when the file does not exist yet', () => {
  const p = tmpCountersPath();
  assert.deepEqual(readCounters(p), {});
});

test('resetAllJobTypeCounters zeroes every existing job type at once, not just one', () => {
  const p = tmpCountersPath();
  incrementJobTypeCounter(p, 'adhoc');
  incrementJobTypeCounter(p, 'adhoc');
  incrementJobTypeCounter(p, 'research_task');

  resetAllJobTypeCounters(p);

  assert.deepEqual(readCounters(p), { adhoc: 0, research_task: 0 });
});

test('incrementJobTypeCounter after a reset starts counting up again from zero', () => {
  const p = tmpCountersPath();
  incrementJobTypeCounter(p, 'adhoc');
  resetAllJobTypeCounters(p);
  assert.equal(incrementJobTypeCounter(p, 'adhoc'), 1);
});
