'use strict';

// Infra attribution (2026-10-18, HUB0164 1/4 of the draft/review-shell attribution feature).
//
// A worker lane's failure text is "infra-shaped" (a timeout, an unreachable Ollama host, a
// missing model, an empty result from a killed process -- the same class scripts/local-worker.sh
// requeues under its own INFRA_FAILURE_PATTERN) and the lane is NOT the primary one. In that case
// the failure belongs to the LANE, not to the task: record it against the lane so the dashboard's
// per-lane store shows it, and do not treat it as evidence about the task.
//
// Two deliberate reuse decisions (both flagged TODO(HUB0164) until the sibling wiring tasks
// confirm them against the live call sites):
//   1. The infra-shaped check reuses the pipeline's existing, exported BLOCKER-TYPE vocabulary
//      (agentic-draft-common.js's BLOCKER_TYPE_RE) rather than inventing a new keyword list in
//      this file. An EMPTY failure text is always infra-shaped, mirroring local-worker.sh's own
//      `isInfra = PATTERN.test(...) || !text.trim()` rule for a process that produced no output.
//   2. recordLaneFailure delegates to src/lane-health.js -- the per-lane store the dashboard
//      reads (python/dashboard/app.py pulls lane ids/defs from src/lanes.js but reads no
//      lane-health.js symbol; lane-health.js is where per-lane failure verdicts live) --
//      through its exported surface only (assess/readSamples), not a new store of its own.

const { BLOCKER_TYPE_RE } = require('./agentic-draft-common.js');
// TODO(HUB0164): confirm which existing infra predicate the worker's own requeue path treats as
// authoritative at the wired call sites (HUB0164 3/4 local-worker.sh / 4/4 review-runner.sh).
// local-worker.sh's unimportable bash-side INFRA_FAILURE_PATTERN is the closest existing
// keyword list; if the wired path needs THAT list instead, move it into an importable module and
// swap this BLOCKER_TYPE_RE check for it there -- do not grow a second copy in this file.
const laneHealth = require('./lane-health.js');

// -> { laneAttributable, reason }. Lane-attributable ONLY when the text is infra-shaped OR
// empty, AND the failing lane is not the primary lane. A primary-lane failure is never
// attributed to the lane (there is no other lane to blame), and a non-infra failure is task-
// shaped content, not infrastructure.
function classifyInfraFailure({ failureText, laneId, primaryLaneId } = {}) {
  const text = String(failureText || '');
  const infraShaped = !text.trim() || (BLOCKER_TYPE_RE.exec(text) || [])[1] === 'infra-error';
  if (!infraShaped) {
    return { laneAttributable: false, reason: 'failure text is not infra-shaped (or empty); treating it as task content, not a lane fault' };
  }
  if (laneId === primaryLaneId) {
    return { laneAttributable: false, reason: 'primary lane failed infra-shaped -- nothing else to attribute it to, so it is not a lane-attributable failure' };
  }
  const why = text.trim() ? `infra-shaped failure on ${laneId}: ${text.trim().slice(0, 200)}` : `no output recorded from ${laneId} (empty failure text is treated as infra-shaped)`;
  return { laneAttributable: true, reason: why };
}

// Record one lane failure into the existing per-lane store (src/lane-health.js). The store's
// samples are what its assess() reads, so a recorded failure is the lane's latest sample with
// ok:false -- a fresh, failed verdict -- which is exactly what a consumer (capability-routing,
// the debrief bundle) expects a lane failure to look like. Best-effort: a recording failure
// must never break the worker path that called us.
function recordLaneFailure(laneId, { reason, now = Date.now(), instancesDir } = {}) {
  // TODO(HUB0164): confirm against the wired call sites that the per-lane store to delegate to
  // is lane-health.js's sample state (lane-health.<laneId>.json) and that appending a
  // { ok:false } sample is the intended record -- lane-health.js exports no dedicated
  // failure-recording symbol, so if one is added (or the dashboard turns out to read a
  // different per-lane field), swap this delegate for that single symbol.
  if (!instancesDir || !laneId) return null;
  const samples = laneHealth.readSamples(instancesDir, laneId);
  const sample = { at: new Date(now).toISOString(), ok: false, tps: 0, totalMs: 0, error: String(reason || 'unrecorded lane failure').slice(0, 200) };
  const next = [...samples, sample].slice(-50); // lane-health.js keeps at most MAX_SAMPLES (50) per lane
  const path = require('path');
  const fs = require('fs');
  try {
    fs.mkdirSync(instancesDir, { recursive: true });
    fs.writeFileSync(path.join(instancesDir, `lane-health.${laneId}.json`), JSON.stringify({ samples: next }));
  } catch (e) { /* best-effort -- the store is a display signal, not a source of truth */ }
  return laneHealth.assess(next);
}

module.exports = { classifyInfraFailure, recordLaneFailure };
