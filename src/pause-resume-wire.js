'use strict';

// Thin wiring for the one-shot pause-resume scheduler (HUB0633 5/5).
//
// wirePauseResume() is the single entry point the 429 park site (HUB0611-07) will call.
// It normalizes resetsAt to epoch ms, builds the pause record from provider/resetsAt, and
// delegates to schedulePauseResume() from ./pause-resume.js. Premium-first ordering lives
// inside schedulePauseResume, so nothing about premium is mapped here.
//
// Never throws. On a bad input (missing provider, unparseable resetsAt) it returns null and
// arms no timer and requeues nothing. Otherwise it returns whatever schedulePauseResume returns.
// It adds no timers, intervals or polling of its own; timing comes only from the injected setTimer.

const { schedulePauseResume } = require('./pause-resume.js');

// resetsAt as Date, epoch ms number or ISO string -> finite epoch ms, or null.
function toEpochMs(resetsAt) {
  let ms;
  if (resetsAt instanceof Date) ms = resetsAt.getTime();
  else if (typeof resetsAt === 'number') ms = resetsAt;
  else if (typeof resetsAt === 'string') ms = Date.parse(resetsAt);
  else return null;
  return Number.isFinite(ms) ? ms : null;
}

function wirePauseResume({ provider, resetsAt, parkedTasks, requeue, now, setTimer } = {}) {
  try {
    if (typeof provider !== 'string' || !provider) return null;
    const ms = toEpochMs(resetsAt);
    if (ms === null) return null;
    const pause = { provider, resetsAt: ms };
    return schedulePauseResume({ pause, parkedTasks, requeue, now, setTimer });
  } catch (e) {
    return null;
  }
}

module.exports = { wirePauseResume };
