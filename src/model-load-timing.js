'use strict';

// Model-load timing helpers (swap-cost measurement). Pure: no I/O, no timers.
// Ollama reports load_duration in nanoseconds; these convert it to seconds and to a
// decimal MB/s rate so a cold model read (spinning-disk model store) can be compared
// against the SSD-move decision. Returns null rather than Infinity/NaN on bad input.

function loadRateMBps(bytes, loadDurationNs) {
  if (!(Number(bytes) > 0) || !(Number(loadDurationNs) > 0)) return null;
  return bytes / 1e6 / (loadDurationNs / 1e9);
}

function recordLoad({ model, bytes, loadDurationNs, at } = {}) {
  const valid = Number(loadDurationNs) > 0;
  return {
    model,
    bytes: Number(bytes) > 0 ? bytes : null,
    loadSeconds: valid ? loadDurationNs / 1e9 : null,
    mbps: loadRateMBps(bytes, loadDurationNs),
    at,
  };
}

module.exports = { loadRateMBps, recordLoad };
