'use strict';

// Evidence bundle for the probe debrief (docs/design-notes/capability-routing-and-benchmarking.md section 5a). A source keeps failing on a small
// lane (timeouts, degenerate output, errors), usually because the task is too big for it. The debrief asks a larger local model WHY and how to
// break the work into smaller scoped pieces. This file is the deterministic half, shaped like forensic-bundle.js / debrief-bundle.js: it finds
// failure CLUSTERS in the capability ledger and assembles the evidence for one cluster. It makes no model call and files nothing; the report
// source that consumes it is a follow-up step.
//
// Cluster = (source, model, failure signature). Evidence = the small-lane failures in full, the same tasks' later attempts on larger lanes (the
// paired result that shows the task IS doable), the scorecard for the source across tiers, and a contrast set of small-lane successes.

const fs = require('fs');
const path = require('path');
const { readPipelineHistory } = require('./pipeline-history.js');
const { LEDGER_TYPE, buildScorecard } = require('./capability-ledger.js');
const {
  findTaskRecordById, readModelCallsForTasks, gatherEvidenceForTask, assembleText,
} = require('./forensic-bundle.js');
const { readWorkLog } = require('./work-log.js');

const DEFAULT_MIN_FAILURES = 3;
const DEFAULT_WINDOW_DAYS = 14;
const MAX_SUBJECTS = 4;
const MAX_CONTRAST = 3;
const DEFAULT_BUDGET_CHARS = 28000;
const STATE_FILE = 'capability-debrief-state.json';

function cap(s, n) {
  const str = typeof s === 'string' ? s : (s == null ? '' : String(s));
  return str.length > n ? `${str.slice(0, n)}...[+${str.length - n}]` : str;
}

// outcome + the reason with numbers and ids removed, so "timed out after 300000ms" and "after 120000ms" cluster together.
function failureSignature(entry) {
  const reason = String(entry.reason || '').toLowerCase().replace(/\d+/g, 'N').replace(/[a-f0-9]{7,}/g, 'H').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${entry.outcome}${reason ? `:${reason}` : ''}`;
}

function clusterKey(c) { return `${c.source}|${c.model}|${c.signature}`; }

// Failure clusters among small-lane attempts: entries with a known tier that has a larger tier above it in the ledger window, grouped by
// (source, model, signature), keeping groups with >= minFailures failures. Newest cluster first.
function collectFailureClusters(entries, { minFailures = DEFAULT_MIN_FAILURES } = {}) {
  const tiers = (entries || []).map((e) => e.tier).filter((t) => typeof t === 'number');
  const maxTier = tiers.length ? Math.max(...tiers) : null;
  const groups = new Map();
  for (const e of entries || []) {
    if (!e || !e.source || !e.model || e.outcome === 'ok') continue;
    if (typeof e.tier !== 'number' || maxTier == null || !(e.tier < maxTier)) continue;
    const signature = failureSignature(e);
    const key = `${e.source}|${e.model}|${signature}`;
    let g = groups.get(key);
    if (!g) { g = { source: e.source, model: e.model, tier: e.tier, outcome: e.outcome, signature, entries: [], taskIds: [] }; groups.set(key, g); }
    g.entries.push(e);
    if (e.taskId && !g.taskIds.includes(e.taskId)) g.taskIds.push(e.taskId);
  }
  return [...groups.values()]
    .filter((g) => g.entries.length >= minFailures)
    .map((g) => ({ ...g, failures: g.entries.length, firstAt: g.entries[0].at || null, lastAt: g.entries[g.entries.length - 1].at || null }))
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

function readState(instancesDir) {
  try { return JSON.parse(fs.readFileSync(path.join(instancesDir, STATE_FILE), 'utf8')); } catch (_) { return {}; }
}

// Clusters not yet debriefed. One debrief per cluster until a fix lands: markDebriefed records it; resetCluster (called when a fix merges) clears it.
function pendingClusters(clusters, instancesDir) {
  const state = readState(instancesDir);
  return clusters.filter((c) => !state[clusterKey(c)]);
}

function markDebriefed(instancesDir, cluster, extra = {}) {
  const state = readState(instancesDir);
  state[clusterKey(cluster)] = { at: new Date().toISOString(), failures: cluster.failures, ...extra };
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(path.join(instancesDir, STATE_FILE), JSON.stringify(state, null, 2));
}

function resetCluster(instancesDir, cluster) {
  const state = readState(instancesDir);
  delete state[clusterKey(cluster)];
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(path.join(instancesDir, STATE_FILE), JSON.stringify(state, null, 2));
}

function renderScorecard(rows, source) {
  const mine = rows.filter((r) => r.source === source);
  if (!mine.length) return 'SCORECARD: no ledger rows for this source.';
  const lines = [`SCORECARD for ${source} (trailing window; "lower" = Wilson lower bound on the success rate):`];
  for (const r of mine) {
    lines.push(`  tier ${r.tier ?? '?'}  ${r.model}  n=${r.n}  ok=${r.ok} (${Math.round(r.okRate * 100)}%, lower ${r.lower.toFixed(2)})  `
      + `p50=${r.p50WallMs == null ? '-' : Math.round(r.p50WallMs / 1000)}s  outcomes=${JSON.stringify(r.outcomes)}  failStreak=${r.failStreak ?? 0}`);
  }
  return lines.join('\n');
}

// The paired result: what happened to each failed task on the larger lanes, from its own draftAttempts.
function renderPairedOutcome(record, smallModel) {
  const attempts = Array.isArray(record.task.draftAttempts) ? record.task.draftAttempts : [];
  if (!attempts.length) return `  ${record.task.id}: no draftAttempts on record`;
  const rows = attempts.map((a) => {
    const t0 = Date.parse(a.at); const t1 = Date.parse(a.finishedAt);
    const secs = Number.isFinite(t0) && Number.isFinite(t1) ? `${Math.round((t1 - t0) / 1000)}s` : '?s';
    return `    attempt ${a.attemptNo ?? '?'} on ${a.lane || 'unknown lane'} → ${a.outcome}${a.reason || a.blockedReason ? ` (${cap(a.reason || a.blockedReason, 120)})` : ''} in ${secs}`;
  });
  return [`  ${record.task.id} (final state: ${record.state}; failed on ${smallModel}):`, ...rows].join('\n');
}

function renderFraming(cluster, now) {
  return [
    `CAPABILITY DEBRIEF BUNDLE — assembled ${new Date(now).toISOString()}`,
    `cluster: source=${cluster.source} model=${cluster.model} (tier ${cluster.tier}) signature="${cluster.signature}"`,
    `${cluster.failures} failed attempt(s) across ${cluster.taskIds.length} task(s), ${cluster.firstAt || '?'} .. ${cluster.lastAt || '?'}`,
    '',
    'Question: why does this task class fail on the small model, and what is the smallest change to the SYSTEM that would let it fit? Classify the cause:',
    '  1. prompt or context too large for the lane (numCtx, prompt tokens vs the limit)  -> trim/window the input, or split it by file/section',
    '  2. several jobs in one call                                                      -> split into stages (plan / write / verify) or per-file sub-tasks',
    '  3. a call that is mechanically decidable                                         -> replace it with a deterministic check',
    '  4. needs reasoning depth this tier lacks                                         -> verdict "not shrinkable at this tier", with the reason',
    'The deliverable is a change to this pipeline (prompts, source definitions, splitting), never a re-attempt of the failed task. Cite only evidence in this bundle.',
  ].join('\n');
}

function buildCapabilityDebriefBundle({ pipelineDir, dbPath, cluster, entries, now = new Date(), budgetChars = DEFAULT_BUDGET_CHARS }) {
  const sections = [{ text: renderFraming(cluster, now) }];
  const rows = buildScorecard(entries || []);
  sections.push({ text: renderScorecard(rows, cluster.source) });

  const subjectIds = cluster.taskIds.slice(-MAX_SUBJECTS);
  const subjectRecords = subjectIds.map((id) => findTaskRecordById(pipelineDir, id)).filter(Boolean);

  // Contrast: small-lane successes of the same source/model.
  const contrastIds = [];
  for (const e of [...(entries || [])].reverse()) {
    if (contrastIds.length >= MAX_CONTRAST) break;
    if (e.outcome === 'ok' && e.source === cluster.source && e.model === cluster.model && e.taskId && !contrastIds.includes(e.taskId)) contrastIds.push(e.taskId);
  }
  const contrastRecords = contrastIds.map((id) => findTaskRecordById(pipelineDir, id)).filter(Boolean);

  const ids = [...subjectRecords, ...contrastRecords].map((r) => r.task.id);
  const callsById = readModelCallsForTasks(dbPath, ids);
  const worklogFor = (id) => { try { return readWorkLog(id, pipelineDir); } catch (_) { return null; } };

  sections.push({
    text: ['FAILED ATTEMPTS ON THE SMALL LANE (ledger):', ...cluster.entries.slice(-10).map((e) =>
      `  ${e.at || '?'} ${e.taskId} lane=${e.lane} numCtx=${e.numCtx ?? 'default'} outcome=${e.outcome} wall=${e.wallMs == null ? '?' : Math.round(e.wallMs / 1000)}s reason="${cap(e.reason, 140)}"`)].join('\n'),
  });
  if (subjectRecords.length) {
    sections.push({ text: ['PAIRED OUTCOMES (what happened to the same tasks on larger lanes):', ...subjectRecords.map((r) => renderPairedOutcome(r, cluster.model))].join('\n') });
  }
  subjectRecords.forEach((rec, i) => {
    sections.push({ text: gatherEvidenceForTask(rec, worklogFor(rec.task.id), callsById.get(rec.task.id), { label: `FAILED ON ${cluster.model} ${i + 1}` }), dropTag: i === 0 ? 'subjectWorklog' : 'subjectOldAttempts' });
  });
  contrastRecords.forEach((rec, i) => {
    sections.push({ text: gatherEvidenceForTask(rec, worklogFor(rec.task.id), callsById.get(rec.task.id), { label: `SUCCEEDED ON ${cluster.model} ${i + 1}` }), dropTag: i === 0 ? 'winnerAttempts' : 'winnerCalls' });
  });

  const { text, dropped } = assembleText(sections, budgetChars);
  return {
    evidenceText: text,
    signature: clusterKey(cluster),
    subjectIds: subjectRecords.map((r) => r.task.id),
    contrastIds: contrastRecords.map((r) => r.task.id),
    stats: { failures: cluster.failures, subjectCount: subjectRecords.length, contrastCount: contrastRecords.length, droppedForBudget: dropped, chars: text.length },
  };
}

function readLedgerEntries(pipelineDir, { windowDays = DEFAULT_WINDOW_DAYS, now = Date.now() } = {}) {
  const since = new Date(now - windowDays * 86400000).toISOString();
  return readPipelineHistory(pipelineDir, { type: LEDGER_TYPE, since });
}

module.exports = {
  failureSignature, clusterKey, collectFailureClusters, pendingClusters, markDebriefed, resetCluster,
  buildCapabilityDebriefBundle, readLedgerEntries, DEFAULT_MIN_FAILURES, STATE_FILE,
};

// CLI (read-only): node src/capability-debrief-bundle.js [--min N] [--days N] [--index I]   lists clusters; with --index prints that cluster's bundle.
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? null : args[i + 1]; };
  const pipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
  const dbPath = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH || path.join(pipelineDir, 'model-stats.db');
  const entries = readLedgerEntries(pipelineDir, { windowDays: Number(get('days')) || DEFAULT_WINDOW_DAYS });
  const clusters = collectFailureClusters(entries, { minFailures: Number(get('min')) || DEFAULT_MIN_FAILURES });
  if (get('index') == null) {
    if (!clusters.length) console.log('no failure clusters');
    clusters.forEach((c, i) => console.log(`[${i}] ${c.source} on ${c.model}: ${c.failures} x ${c.signature} (${c.taskIds.length} tasks, last ${c.lastAt})`));
  } else {
    const cluster = clusters[Number(get('index'))];
    if (!cluster) { console.error('no such cluster'); process.exit(1); }
    console.log(buildCapabilityDebriefBundle({ pipelineDir, dbPath, cluster, entries }).evidenceText);
  }
}
