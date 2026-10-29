'use strict';

// Cross-file threshold-consistency test (AC-81).
// Verifies that src/uptime-log.js re-exports the same threshold values as the
// single source of truth (src/heartbeat-thresholds.js).
//
// src/dead-process-check.js imports from the same shared module
// (const { STALE_HEARTBEAT_SECONDS, WORKER_ZOMBIE_THRESHOLD_SECONDS } = require('./heartbeat-thresholds.js'))
// but does not re-export the constants, so agreement is transitive: if shared and
// uptime-log agree, and dead-process-check imports from shared, all three agree.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const shared = require('../src/heartbeat-thresholds.js');
const uptimeLog = require('../src/uptime-log.js');

test('shared and uptime-log agree on STALE_HEARTBEAT_SECONDS', () => {
  assert.equal(typeof shared.STALE_HEARTBEAT_SECONDS, 'number');
  assert.ok(Number.isInteger(shared.STALE_HEARTBEAT_SECONDS) && shared.STALE_HEARTBEAT_SECONDS > 0);
  assert.equal(uptimeLog.STALE_HEARTBEAT_SECONDS, shared.STALE_HEARTBEAT_SECONDS);
});

test('shared and uptime-log agree on WORKER_ZOMBIE_THRESHOLD_SECONDS', () => {
  assert.equal(typeof shared.WORKER_ZOMBIE_THRESHOLD_SECONDS, 'number');
  assert.ok(Number.isInteger(shared.WORKER_ZOMBIE_THRESHOLD_SECONDS) && shared.WORKER_ZOMBIE_THRESHOLD_SECONDS > 0);
  assert.equal(uptimeLog.WORKER_ZOMBIE_THRESHOLD_SECONDS, shared.WORKER_ZOMBIE_THRESHOLD_SECONDS);
});
