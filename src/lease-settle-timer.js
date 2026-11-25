'use strict';

// Lease settle timers: one private one-shot setTimeout per leaseId, armed when a lease is lent.
// Notes for callers:
//  (a) expiresAt is EPOCH MILLISECONDS. Convert ISO strings with Date.parse before calling; NaN fires immediately.
//  (b) Delays are capped at 2147483647 ms (about 24.8 days). A lease expiring later fires early, so onDue must re-check expiry before acting. Timers never re-arm.
//  (c) This is a one-shot timer per lease, not a poll. No repeating timer and no clock-driven scan.

const handles = new Map();
const MAX_DELAY = 2147483647;

function delayFor(expiresAt) {
  return Math.min(Math.max(0, expiresAt - Date.now()), MAX_DELAY);
}

function armSettle(leaseId, expiresAt, onDue) {
  if (handles.has(leaseId)) clearTimeout(handles.get(leaseId));
  const handle = setTimeout(() => {
    if (handles.get(leaseId) === handle) handles.delete(leaseId);
    onDue(leaseId);
  }, delayFor(expiresAt));
  handles.set(leaseId, handle);
}

function disarmSettle(leaseId) {
  if (!handles.has(leaseId)) return;
  clearTimeout(handles.get(leaseId));
  handles.delete(leaseId);
}

module.exports = { armSettle, disarmSettle };
