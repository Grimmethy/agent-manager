'use strict';

// Node-draft reviews under swap-only critical memory pressure (see nodeDraftMayRunUnderPressure below). Split out of pool-projects.js so that file stays under its size cap.
const fs = require('fs');
const path = require('path');

// Node-draft reviews under SWAP-ONLY critical pressure (owner request 2026-11-12: the reviewers yielded all night on a marker that was critical only through
// the gpu-broker's swap backstop -- swap_free 0, 2.2 GB available, mem_full 0.7, io_full 1.2). A small review of a draft that another machine already built may
// run when ALL hold: the marker is critical, swap is nearly gone (so nothing else can have made it critical), at least 1024 MB is available, memory full is
// under 5, io full is under 10, and a record with a fromNode is waiting. Missing or non-numeric numbers fail closed. Kill switch
// AGENT_MANAGER_NODE_DRAFT_REVIEW_UNDER_SWAP_CRITICAL=false. Pure so it can be tested; scripts/review-runner.sh reaches it through this file's command line.
function nodeDraftMayRunUnderPressure({ state, numbers, hasNodeDraftReview, env = process.env } = {}) {
  if (String((env || {}).AGENT_MANAGER_NODE_DRAFT_REVIEW_UNDER_SWAP_CRITICAL || '').toLowerCase() === 'false') return false;
  if (state !== 'critical' || hasNodeDraftReview !== true) return false;
  const n = numbers || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const swap = num(n.swap_free_mb), avail = num(n.available_mb), memFull = num(n.mem_full), ioFull = num(n.io_full);
  return swap < 128 && avail >= 1024 && memFull < 5 && ioFull < 10;   // NaN fails every comparison, so a missing number is false
}

// True when a record waiting in <pipelineDir>/queue/review carries a non-empty string fromNode (a draft another machine built).
function hasNodeDraftReview(pipelineDir) {
  try {
    const dir = path.join(pipelineDir, 'queue', 'review');
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.json')) continue;
      try { const t = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (typeof t.fromNode === 'string' && t.fromNode) return true; } catch { /* unreadable record: not a node draft */ }
    }
  } catch { /* no review dir */ }
  return false;
}

module.exports = { nodeDraftMayRunUnderPressure, hasNodeDraftReview };

if (require.main === module) {
  // node src/node-draft-pressure.js <homePipelineDir> <state> <swap_free_mb> <available_mb> <mem_full> <io_full>   exit 0 when a node-draft review may run under swap-only critical pressure
  const [a, b, c, d, e, f] = process.argv.slice(2);
  const toNum = (v) => (v === undefined || v === '' ? NaN : Number(v));
  process.exit(nodeDraftMayRunUnderPressure({ state: b, numbers: { swap_free_mb: toNum(c), available_mb: toNum(d), mem_full: toNum(e), io_full: toNum(f) }, hasNodeDraftReview: hasNodeDraftReview(a) }) ? 0 : 1);
}
