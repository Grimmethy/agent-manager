'use strict';

// Guard for the worker process result used by applyAdhocDiff. Pure: it inspects the
// result object the caller already has and throws on an abnormal exit. No timers,
// no loops, no I/O.

function assertCleanWorkerExit(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('worker exited abnormally (no result object)');
  }
  const { status, signal, error } = result;
  if (error) {
    throw new Error(`worker exited abnormally (error: ${error.message || error})`);
  }
  if (signal) {
    throw new Error(`worker exited abnormally (signal ${signal})`);
  }
  if (typeof status === 'number' && status !== 0) {
    throw new Error(`worker exited abnormally (status ${status})`);
  }
  return undefined;
}

module.exports = { assertCleanWorkerExit };
