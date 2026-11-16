'use strict';

// live-checkout-sync.js -- keeps the live checkout (AGENT_MANAGER_REPO_ROOT) judged against origin, as a queue-events consumer (ADR-0024).
//
//   consume(pipelineDir, deps)   -- triggered by branch_merged events. Drains them; with none, returns at once with no git call.
//                                   Otherwise runs one `git fetch origin`, one checkDrift(), appends one audit line, then commit()s the position.
//   reconcile(pipelineDir, deps) -- the slow safety-net pass. One fetch and one checkDrift. If the checkout is behind and no branch_merged
//                                   event announces it, recordCorrection(...) counts it.
//
// deps = { fs, execGit, clock, env }. execGit(args, { cwd }) must run git and return its stdout.
// AGENT_MANAGER_LIVE_CHECKOUT_SYNC = 'on' | 'dry-run' (default 'dry-run'). Both modes only record the intended decision; neither changes the checkout.
// Git subcommands used here: fetch (directly), and rev-parse / rev-list / symbolic-ref via checkDrift.
// No timers and no polling loops: scheduling is the caller's job.

const path = require('path');
const queueEvents = require('./queue-events.js');
const { checkDrift } = require('./live-checkout-drift.js');

const CONSUMER = 'live-checkout-sync';
const AUDIT_FILE = 'live-checkout-sync.audit.jsonl';

function modeOf(env) {
  return env.AGENT_MANAGER_LIVE_CHECKOUT_SYNC === 'on' ? 'on' : 'dry-run';
}

function clockOf(deps) {
  return () => new Date(deps.clock ? deps.clock() : Date.now());
}

function writeAudit(pipelineDir, deps, rec) {
  const file = path.join(pipelineDir, 'queue-events', AUDIT_FILE);
  deps.fs.mkdirSync(path.dirname(file), { recursive: true });
  deps.fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

function logError(rec) {
  console.error(JSON.stringify({ consumer: CONSUMER, state: 'error', error: rec.error }));
}

// One fetch and one drift check. Throws on fetch failure; checkDrift reports its own failures as state 'error'.
function fetchAndCheck(repoRoot, deps) {
  const git = (args) => deps.execGit(args, { cwd: repoRoot });
  git(['fetch', 'origin']);
  return checkDrift(repoRoot, { execGit: git });
}

function consume(pipelineDir, deps) {
  const env = deps.env || process.env;
  const drained = queueEvents.drain(pipelineDir, CONSUMER, { fs: deps.fs });
  const merged = drained.events.filter((e) => e.type === 'branch_merged');
  if (merged.length === 0) {
    // Nothing to act on: no git call. The position still advances so these non-merge events are not re-read.
    drained.commit();
    return { state: 'idle', events: 0 };
  }

  const mode = modeOf(env);
  const repoRoot = env.AGENT_MANAGER_REPO_ROOT;
  const now = clockOf(deps);
  let rec;
  try {
    const drift = fetchAndCheck(repoRoot, deps);
    rec = { at: now().toISOString(), kind: 'consume', consumer: CONSUMER, mode, events: merged.length,
      state: drift.state, ahead: drift.ahead, behind: drift.behind, branch: drift.branch, error: drift.error || null };
  } catch (err) {
    rec = { at: now().toISOString(), kind: 'consume', consumer: CONSUMER, mode, events: merged.length,
      state: 'error', ahead: null, behind: null, branch: null, error: String(err && err.message ? err.message : err).replace(/\s+/g, ' ').trim() };
  }
  if (rec.state === 'error') logError(rec);
  writeAudit(pipelineDir, deps, rec);
  drained.commit();
  return rec;
}

function reconcile(pipelineDir, deps) {
  const env = deps.env || process.env;
  const mode = modeOf(env);
  const repoRoot = env.AGENT_MANAGER_REPO_ROOT;
  const now = clockOf(deps);
  // snapshot reads without saving a position, so this pass does not consume events meant for consume().
  const announced = queueEvents.snapshot(pipelineDir, { fs: deps.fs }).some((e) => e.type === 'branch_merged');
  let rec;
  try {
    const drift = fetchAndCheck(repoRoot, deps);
    const behind = drift.behind !== null && drift.behind > 0;
    const correction = behind && !announced;
    if (correction) queueEvents.recordCorrection(pipelineDir, CONSUMER, 1, { fs: deps.fs, now });
    rec = { at: now().toISOString(), kind: 'reconcile', consumer: CONSUMER, mode,
      state: drift.state, ahead: drift.ahead, behind: drift.behind, branch: drift.branch, error: drift.error || null,
      announced, intended: correction ? 'sync' : 'none' };
  } catch (err) {
    rec = { at: now().toISOString(), kind: 'reconcile', consumer: CONSUMER, mode,
      state: 'error', ahead: null, behind: null, branch: null, announced, intended: 'none',
      error: String(err && err.message ? err.message : err).replace(/\s+/g, ' ').trim() };
  }
  if (rec.state === 'error') logError(rec);
  writeAudit(pipelineDir, deps, rec);
  return rec;
}

module.exports = { consume, reconcile, CONSUMER };
