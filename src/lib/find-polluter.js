'use strict';

// Polluter bisect (2026-11-16, after superpowers' systematic-debugging find-polluter.sh):
// given the test files that run against a shared apply clone, name the one whose run first
// leaves that clone dirty. Pure and injectable: runSubset / isDirty / resetClone are supplied
// by the caller, so this module never spawns a process, touches git, or waits on a timer.
//
// Assumes a single monotone polluter: once a prefix of the file list dirties the clone, every
// longer prefix does too. The boundary is re-probed on fresh runs before a name is returned;
// if the re-probe disagrees (a non-monotone or flaky clone), the result is inconclusive
// rather than a guessed name.

function findPolluter({ testFiles, runSubset, isDirty, resetClone }) {
  const files = Array.isArray(testFiles) ? testFiles.slice() : [];
  let probes = 0;

  // Reset, run the first n files, report whether the clone is dirty afterwards.
  const dirtyAfter = (n) => {
    probes += 1;
    resetClone();
    runSubset(files.slice(0, n));
    return !!isDirty();
  };

  if (files.length === 0 || !dirtyAfter(files.length)) {
    return { polluter: null, inconclusive: false, probes };
  }

  // Invariant: prefix length lo is clean, prefix length hi is dirty.
  let lo = 0;
  let hi = files.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dirtyAfter(mid)) hi = mid; else lo = mid;
  }

  // The polluter is files[hi-1]. Confirm the boundary on fresh runs.
  const boundaryClean = !dirtyAfter(hi - 1);
  const boundaryDirty = dirtyAfter(hi);
  if (!boundaryClean || !boundaryDirty) {
    return { polluter: null, inconclusive: true, probes };
  }
  return { polluter: files[hi - 1], inconclusive: false, probes };
}

module.exports = { findPolluter };
