'use strict';

// Shared heartbeat / zombie-process thresholds -- single source of truth (AC-78).
// Previously declared independently in uptime-log.js and dead-process-check.js
// with divergent values; this module is now the authoritative owner.

const STALE_HEARTBEAT_SECONDS = 300;
const WORKER_ZOMBIE_THRESHOLD_SECONDS = 1680;

module.exports = { STALE_HEARTBEAT_SECONDS, WORKER_ZOMBIE_THRESHOLD_SECONDS };
