'use strict';

// One-shot pause-resume scheduler. Arms exactly one timer that fires at pause.resetsAt
// and then requeues every parked task once, premium tasks first. No polling, no
// interval timers, no re-arming. A fired flag makes any later invocation of the callback a no-op.

function isPremium(task) {
  return !!(task && task.premiumPriority);
}

function schedulePauseResume({ pause, parkedTasks, requeue, now, setTimer }) {
  const delay = Math.max(0, pause.resetsAt - now());
  let fired = false;

  setTimer(() => {
    if (fired) return;
    fired = true;
    const ordered = [...parkedTasks].sort(
      (a, b) => (isPremium(b) ? 1 : 0) - (isPremium(a) ? 1 : 0)
    );
    for (const task of ordered) requeue(task);
  }, delay);
}

module.exports = { schedulePauseResume };
