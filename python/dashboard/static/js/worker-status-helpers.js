// Shared worker status helpers: fmtAge, statusBadgeClass, statusLabel. Moved byte for byte out of workers-tab.js (HUB0323 piece W-A4a) so the Workers Graph view can use the same age and badge rules as the cards.
// A plain global <script> holding only declarations, loaded by index.html directly BEFORE workers-tab.js; the guarded export below lets `node --test` require it.

function fmtAge(sec) {
  if (sec == null) return '?';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  return Math.round(sec / 3600) + 'h';
}

function statusBadgeClass(status, stale) {
  if (stale) return 'bad';
  if (status === 'offline') return 'idle';
  if (status === 'working' || status === 'checking') return 'ok';
  if (status === 'idle') return 'idle';
  // 'queued' (2026-08-19): a claimed task waiting its turn behind another lane at the
  // single-flight lock (agent-manager-common.sh's acquire_single_flight_lock) -- amber,
  // same as the generic 'warn' fallback below, but named explicitly so it reads as a
  // deliberate third state (green=actively running, amber=waiting its turn, gray=idle)
  // rather than falling through by accident.
  if (status === 'queued') return 'warn';
  // 'paused' / 'warming' (B3): the lane is yielding to a GPU session, or reloading its model after one. Amber like 'queued': deliberate, not broken.
  if (status === 'paused' || status === 'warming') return 'warn';
  return 'warn';
}

// What the badge says. Most statuses are shown as they are; the two GPU-session states say why in words.
function statusLabel(status) {
  if (status === 'paused') return 'paused: GPU session';
  if (status === 'warming') return 'resuming: model warming';
  return status;
}

if (typeof module !== 'undefined') module.exports = { fmtAge, statusBadgeClass, statusLabel };
