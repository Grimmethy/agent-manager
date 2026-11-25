'use strict';

// Deferral helper (HUB0737 2/3). Pure in-memory: sets deferUntil and reason on a task
// object, leaves status non-blocked, never touches the failure counter.
//
// deferOnProviderLimit(task, {resetsAt, resetsAtIso}) -> task
//   task.deferUntil  = resetsAt (ms epoch)
//   task.reason      = 'waiting on provider plan limit, resets <resetsAtIso>'
//   status           left unchanged (caller decides; convention: waiting/queued, i.e. non-blocked)
//   draftFailureCount / reviewFailureCount   never read or written
//
// Reused by both the draft and review call sites.

function deferOnProviderLimit(task, {resetsAt, resetsAtIso}) {
  if (!task || typeof task !== 'object') return task;
  task.deferUntil = Number(resetsAt);
  task.reason = `waiting on provider plan limit, resets ${resetsAtIso}`;
  return task;
}

module.exports = { deferOnProviderLimit };
