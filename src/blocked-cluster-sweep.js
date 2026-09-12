'use strict';

// Deterministic blocked-task cluster fingerprinting (2026-09-12, screaminggoatclubmt: "we
// have 4 separate instances with a bespoke solution each... do we have a way to combine
// these patterns into a single fix"). The blocked-task-root-cause-classification concept's
// own research notes already point at the right direction -- Sentry/Rollbar-style error-
// fingerprinting/grouping ("same crash, different stack") -- and this session's own
// actual investigative method WAS exactly that, just done by hand: normalize
// blockedReason text (strip backtick-quoted code, quoted strings, numbers, file paths),
// group by the normalized string, and look for the biggest cluster. Every real fix this
// session found (the truncation cluster, the AVAILABLE-FILES review/draft contradiction,
// the SO WHAT citation gate) started from that exact manual clustering step, repeated by
// hand, four separate times, before a human happened to notice.
//
// This does NOT replace the fix mechanism for a discovered cluster -- postImplementCheck
// (deep_dive/function_length_review/premiseCheck/pipeline-debrief-so-what-check) is
// already the right, uniform, existing extension point for that, and stays hand-written
// per cluster shape (a generic "auto-fix whatever's wrong" step isn't reachable
// deterministically -- diagnosing WHAT'S wrong is the human-judgment part). What this
// closes is the DISCOVERY gap: surfacing a big cluster proactively, before it grows to
// the size this session kept finding them at (21 tasks, 31 tasks) purely because nobody
// happened to go looking with a one-off script.
//
// Deliberately textual/fingerprint-based, not semantic: this reliably groups NEAR-
// IDENTICAL normalized reasons (the truncation cluster, the AVAILABLE-FILES cluster --
// both had, modulo variable substitution, the literal same message every time) but will
// NOT group a cluster that shares a root cause while varying widely in wording (this
// session's own SO WHAT citation cluster needed a keyword/semantic search, not pure
// fingerprinting, to find). That is a real, known limitation, not an oversight -- a
// fingerprint match is cheap and has zero false-positive risk; semantic/embedding-based
// grouping is a real but separate, bigger piece of future work the parent concept's own
// research notes already flag.

const fs = require('fs');
const path = require('path');
const { writeSideFindingInbox } = require('./side-finding.js');

const STATE_FILENAME = 'blocked-cluster-sweep-state.json';

// Same normalization this session applied by hand, repeatedly, via one-off Python
// scripts: strip the parts of a blockedReason that vary per-task (a quoted code
// identifier, a literal string, a task-count number, a file path) so two messages that
// differ only in those specifics collapse to the same fingerprint. Truncated to a bounded
// length -- long tails after the normalizable prefix are usually task-specific detail,
// not part of the shared shape.
const BACKTICK_RE = /`[^`]+`/g;
const QUOTED_RE = /"[^"]*"/g;
const FILE_RE = /\b[\w./-]+\.(?:js|py|sh|json|html|css|md|ps1)\b/g;
const NUMBER_RE = /\b\d+\b/g;
const FINGERPRINT_MAX_LENGTH = 160;

function normalizeBlockedReason(reason) {
  if (!reason) return null;
  let r = String(reason);
  r = r.replace(BACKTICK_RE, '<code>');
  r = r.replace(QUOTED_RE, '"<x>"');
  r = r.replace(FILE_RE, '<file>');
  r = r.replace(NUMBER_RE, '<n>');
  r = r.trim().slice(0, FINGERPRINT_MAX_LENGTH);
  return r || null;
}

// Scans queue/blocked/*.json, groups by normalized blockedReason. Pure / side-effect
// free -- callers decide what to do with the result (the sweep below; a human poking at
// this directly from a REPL; a future dashboard view).
function findBlockedClusters(pipelineDir, { minClusterSize = 3 } = {}) {
  const blockedDir = path.join(pipelineDir, 'queue', 'blocked');
  let files;
  try {
    files = fs.readdirSync(blockedDir).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no blocked/ dir yet -- nothing to cluster
  }

  const byFingerprint = new Map(); // fingerprint -> { count, taskIds: [], exampleReasons: Set, sources: Set }
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(blockedDir, f), 'utf8'));
    } catch {
      continue; // malformed/mid-write -- skip, not this sweep's job to validate
    }
    const fingerprint = normalizeBlockedReason(data && data.blockedReason);
    if (!fingerprint) continue;
    if (!byFingerprint.has(fingerprint)) {
      byFingerprint.set(fingerprint, { fingerprint, count: 0, taskIds: [], exampleReasons: [], sources: new Set() });
    }
    const bucket = byFingerprint.get(fingerprint);
    bucket.count += 1;
    bucket.taskIds.push(data.id || f.replace(/\.json$/, ''));
    if (bucket.exampleReasons.length < 3) bucket.exampleReasons.push(data.blockedReason);
    if (data.source) bucket.sources.add(data.source);
  }

  return [...byFingerprint.values()]
    .filter((b) => b.count >= minClusterSize)
    .map((b) => ({ ...b, sources: [...b.sources] }))
    .sort((a, b) => b.count - a.count);
}

function loadState(pipelineDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', STATE_FILENAME), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(pipelineDir, state) {
  try {
    fs.writeFileSync(path.join(pipelineDir, 'queue', STATE_FILENAME), JSON.stringify(state, null, 2));
  } catch { /* best-effort -- a lost state write just means a possible re-report next tick, not silence forever */ }
}

// A cluster is worth a fresh side-finding when it's genuinely NEW (never crossed
// minClusterSize before) or has grown meaningfully since the last time it was reported --
// re-filing an identical finding every tick forever would be pure noise, but a cluster
// that kept growing (exactly what happened to the SO WHAT/AVAILABLE-FILES clusters this
// session, unnoticed for days) deserves a fresh nudge, not permanent silence just because
// it was mentioned once already. "Grown meaningfully" mirrors this session's own real
// numbers: the truncation cluster went unnoticed from ~9 to 21 tasks -- doubling (or +5
// absolute, whichever is more forgiving for a small cluster) is a deliberately loose
// enough bar to have caught that growth well before it reached 21.
function shouldReport(cluster, priorState) {
  if (!priorState) return true;
  const grew = cluster.count >= priorState.lastReportedSize * 2 || cluster.count >= priorState.lastReportedSize + 5;
  return grew;
}

// pipelineDir -> { scanned, clustersFound, newlyReported: [{fingerprint, count}] }
function runBlockedClusterSweep({ pipelineDir, minClusterSize = 3 } = {}) {
  const clusters = findBlockedClusters(pipelineDir, { minClusterSize });
  const state = loadState(pipelineDir);
  const newlyReported = [];

  for (const cluster of clusters) {
    const prior = state[cluster.fingerprint];
    if (!shouldReport(cluster, prior)) continue;

    const title = `Blocked-task cluster: ${cluster.count} tasks share a fingerprint`;
    const body = [
      `Normalized reason: ${cluster.fingerprint}`,
      `Real count: ${cluster.count} task(s) currently in queue/blocked/, source(s): ${cluster.sources.join(', ') || '(unknown)'}.`,
      `Example task ids: ${cluster.taskIds.slice(0, 5).join(', ')}${cluster.taskIds.length > 5 ? ', ...' : ''}`,
      '',
      'Example real blockedReason text(s):',
      ...cluster.exampleReasons.map((r) => `- ${String(r).slice(0, 300)}`),
      '',
      'This is large enough to be a systemic gap, not N unrelated incidents -- worth investigating whether a new deterministic postImplementCheck (same hook deep_dive/function_length_review/premiseCheck/pipeline-debrief-so-what-check already use) could catch this before drafting reaches review, the way each of this session\'s own real fixes did.',
    ].join('\n');

    writeSideFindingInbox({ title, body }, { source: 'blocked-cluster-sweep', pipelineDir });
    newlyReported.push({ fingerprint: cluster.fingerprint, count: cluster.count });
    state[cluster.fingerprint] = { lastReportedSize: cluster.count, lastReportedAt: new Date().toISOString(), firstSeenAt: (prior && prior.firstSeenAt) || new Date().toISOString() };
  }

  saveState(pipelineDir, state);
  return { scanned: clusters.reduce((n, c) => n + c.count, 0), clustersFound: clusters.length, newlyReported };
}

module.exports = { normalizeBlockedReason, findBlockedClusters, runBlockedClusterSweep, shouldReport };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const { pipelineDir } = getConfig();
  process.stdout.write(JSON.stringify(runBlockedClusterSweep({ pipelineDir })));
}
