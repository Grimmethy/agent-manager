'use strict';

// Marks a reviewer that was rejected or timed out. It is never counted as a verdict.
const ABSTAIN = Symbol('ABSTAIN');

// Runs reviewers concurrently and resolves exactly once with a verdict.
//   reviewers:      array of functions (called once each) or promises/values
//   predicate:      (tally, pending) => verdict to decide early, or null/undefined to keep waiting
//   fallback:       (tally) => verdict, used when every reviewer has settled
//   defaultVerdict: verdict used on a tie or when no reviewer produced a verdict
//   timeoutMs:      per-reviewer one-shot timeout; a timed-out reviewer abstains
function quorumVote({ reviewers, predicate, fallback, defaultVerdict, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let pending = reviewers.length;
    const tally = new Map();
    const abstains = [];
    const timers = new Array(reviewers.length);
    const done = new Array(reviewers.length).fill(false);
    let resolved = false;

    function clearAllTimers() {
      for (const t of timers) {
        if (t !== undefined) clearTimeout(t);
      }
    }

    function finish(verdict) {
      if (resolved) return;
      resolved = true;
      clearAllTimers();
      resolve(verdict);
    }

    function fail(err) {
      if (resolved) return;
      resolved = true;
      clearAllTimers();
      reject(err);
    }

    function isTie() {
      const counts = [...tally.values()].sort((a, b) => b - a);
      return counts.length > 1 && counts[0] === counts[1];
    }

    function settle() {
      if (resolved) return;
      try {
        const early = predicate(tally, pending);
        if (early !== undefined && early !== null) {
          finish(early);
          return;
        }
        if (pending === 0) {
          if (tally.size === 0 || isTie()) {
            finish(defaultVerdict);
          } else {
            finish(fallback(tally));
          }
        }
      } catch (err) {
        fail(err);
      }
    }

    function record(i, value) {
      if (resolved || done[i]) return;
      done[i] = true;
      if (timers[i] !== undefined) clearTimeout(timers[i]);
      pending -= 1;
      if (value === ABSTAIN) {
        abstains.push(ABSTAIN);
      } else {
        tally.set(value, (tally.get(value) || 0) + 1);
      }
      settle();
    }

    if (reviewers.length === 0) {
      settle();
      return;
    }

    reviewers.forEach((reviewer, i) => {
      if (Number.isFinite(timeoutMs)) {
        timers[i] = setTimeout(() => record(i, ABSTAIN), timeoutMs);
      }
      let p;
      try {
        p = typeof reviewer === 'function' ? reviewer() : reviewer;
      } catch (err) {
        p = Promise.reject(err);
      }
      Promise.resolve(p).then(
        (value) => record(i, value),
        () => record(i, ABSTAIN),
      );
    });
  });
}

module.exports = { quorumVote, ABSTAIN };
