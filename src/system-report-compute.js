'use strict';

// system-report-compute.js -- extracted from src/system-report.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { readSamplesInWindow } = require('./uptime-log.js');
const { signatureForTask } = require('./pipeline-self-audit.js');
const { listArchivedMonthDirs } = require('./done-archive.js');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');

const DOWN_GAP_THRESHOLD_SEC = 240;

const LIVE_QUEUE_STATES = ['pending', 'review', 'approved', 'awaiting-confirm', 'needs-clarification', 'blocked', 'coordinating'];

function terminalTimestamp(task) {
  const hist = task.history;
  if (Array.isArray(hist) && hist.length) {
    const last = hist[hist.length - 1];
    if (last && last.at) return last.at;
  }
  return task.createdAt || null;
}

function classifyTask(task, queueState) {
  if (queueState === 'blocked' || queueState === 'archived') return 'junk';

  // Each task source declares how its completed tasks count toward this accounting via
  // reportClass on its registration -- a plain bucket string ('benefit' / 'filtering' /
  // 'housekeeping'), or a (task) => bucket function for a source that decides from the
  // draft text (observability/performance review split filtering vs. benefit on what the
  // verdict actually said). A source with no reportClass -> 'unclear', reported as its own
  // bucket rather than guessed into one. ADR-0022 Stage G removed the hardcoded per-source
  // fallback chain this used to carry -- every source that had a branch now sets the field.
  const registered = getRegisteredSource(resolveSourceName(task));
  const declared = typeof registered?.reportClass === 'function'
    ? registered.reportClass(task)
    : registered?.reportClass;
  return declared || 'unclear';
}

function scanTaskActivity(pipelineDir, startIso, endIso) {
  const queueDir = path.join(pipelineDir, 'queue');
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();

  const dirs = [
    { dir: path.join(queueDir, 'done'), state: 'done' },
    { dir: path.join(queueDir, 'done', '_archived_no_action'), state: 'archived' },
    { dir: path.join(queueDir, 'blocked'), state: 'blocked' },
    // done-archive.js's own dated month buckets (2026-08-24) -- a report window reaching
    // back past the retention cutoff (default 30 days) would otherwise silently miss any
    // task that pass already relocated out of done/'s top level. Expanded dynamically
    // (not a static list) since new month buckets appear over time with no code change.
    ...listArchivedMonthDirs(pipelineDir).map((dir) => ({ dir, state: 'archived' })),
  ];

  const tasks = [];
  const skipped = [];
  for (const { dir, state } of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      skipped.push({ dir, reason: err.code ?? err.message });
      continue;
    }
    for (const name of names) {
      let task;
      try {
        task = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch (err) {
        console.warn(`[system-report] skipping ${name}: ${err.message}`);
        continue;
      }
      const at = terminalTimestamp(task);
      if (!at) continue;
      const t = new Date(at).getTime();
      if (Number.isNaN(t) || t < start || t >= end) continue;
      tasks.push({
        id: task.id, source: task.source, domain: task.domain, at, queueState: state,
        classification: classifyTask(task, state),
        // title carried through for buildPlainEnglishSummary() below -- naming a real
        // accomplishment ("...including a fix for silent-catch-block in
        // budget-monitor.js") is what makes a period's summary specific instead of
        // generic restated numbers.
        title: task.title,
        // Carried through for computeBlockedPatterns() below -- signatureForTask() needs
        // the raw blockedReason/history, not just the coarse classification.
        blockedReason: task.blockedReason, history: task.history,
      });
    }
  }
  tasks.skipped = skipped;
  return tasks;
}

function computeDowntime(instancesDir, startIso, endIso) {
  const samples = readSamplesInWindow(instancesDir, startIso, endIso);
  const windowStart = new Date(startIso).getTime();
  const windowEnd = new Date(endIso).getTime();

  let pipelineDownMs = 0;
  const pipelineDownIntervals = [];
  const perInstanceDownMs = {};

  // Clamp every interval endpoint to the report window -- the "sample before the window"
  // readSamplesInWindow includes can start before windowStart, and there's no sample
  // guaranteed to exist exactly at windowEnd either.
  const clamp = (ms) => Math.max(windowStart, Math.min(windowEnd, ms));

  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i];
    const curMs = new Date(cur.at).getTime();
    const next = samples[i + 1];
    const nextMs = next ? new Date(next.at).getTime() : windowEnd;
    const segStart = clamp(curMs);
    const segEnd = clamp(nextMs);
    const gapSec = (nextMs - curMs) / 1000;

    if (gapSec > DOWN_GAP_THRESHOLD_SEC && segEnd > segStart) {
      pipelineDownMs += segEnd - segStart;
      pipelineDownIntervals.push({ from: new Date(segStart).toISOString(), to: new Date(segEnd).toISOString() });
    } else if (segEnd > segStart) {
      // Pipeline itself was observed (gap is normal tick cadence) -- attribute any
      // individual stale instance's share of this segment to its own downtime.
      for (const [instanceId, info] of Object.entries(cur.instances || {})) {
        if (info.stale) perInstanceDownMs[instanceId] = (perInstanceDownMs[instanceId] || 0) + (segEnd - segStart);
      }
    }
  }

  // No samples at all in the window (and none before it either) means the whole window
  // is unobserved -- report it as fully down rather than silently showing zero downtime,
  // which would read as "everything was fine" when really "nothing was watching."
  if (samples.length === 0) {
    pipelineDownMs = windowEnd - windowStart;
    pipelineDownIntervals.push({ from: startIso, to: endIso });
  }

  return {
    pipelineDownSec: Math.round(pipelineDownMs / 1000),
    pipelineDownIntervals,
    perInstanceDownSec: Object.fromEntries(Object.entries(perInstanceDownMs).map(([k, v]) => [k, Math.round(v / 1000)])),
    sampleCount: samples.length,
  };
}

function computeTimeAccounting(dbPath, tasks, startIso, endIso) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null;
  }
  if (!fs.existsSync(dbPath)) return null;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  const byTaskId = new Map(tasks.map((t) => [t.id, t.classification]));
  const sourceByTaskId = new Map(tasks.map((t) => [t.id, t.source || 'unknown']));
  const bucketMs = { junk: 0, benefit: 0, filtering: 0, housekeeping: 0, unclear: 0, 'in-progress': 0 };
  const bucketCalls = { junk: 0, benefit: 0, filtering: 0, housekeeping: 0, unclear: 0, 'in-progress': 0 };
  const bucketCostUsd = { junk: 0, benefit: 0, filtering: 0, housekeeping: 0, unclear: 0, 'in-progress': 0 };
  // Hypothetical (2026-08-23, Grimmethy: "Clarification on the anthropic costs. I'd like
  // estimates for if we had used the API. Even if we used the local models.") -- unlike
  // bucketCostUsd above (real spend, only real Claude calls contribute), this sums
  // hypothetical_cost_usd, which model-stats-client.js's recordCall() always populates
  // for EVERY call (the real cost when it was a real Claude call, a token-based estimate
  // via anthropic-pricing.js otherwise) -- so this bucket set answers "what would THIS
  // period have cost if every call, including the local ones, had gone through the API."
  const bucketHypotheticalCostUsd = { junk: 0, benefit: 0, filtering: 0, housekeeping: 0, unclear: 0, 'in-progress': 0 };
  const costBySource = new Map(); // source -> { costUsd, calls }
  const hypotheticalCostBySource = new Map(); // source -> { costUsd, calls }
  let totalCostUsd = 0;
  let callsWithCost = 0;
  let totalHypotheticalCostUsd = 0;
  let callsWithHypotheticalCost = 0;

  try {
    const hasCostColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'cost_usd'`).get().c > 0;
    const hasHypotheticalColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'hypothetical_cost_usd'`).get().c > 0;
    const costSelect = (hasCostColumn ? ', cost_usd' : '') + (hasHypotheticalColumn ? ', hypothetical_cost_usd' : '');
    const rows = db.prepare(`SELECT task_id, latency_ms${costSelect} FROM model_calls WHERE started_at >= ? AND started_at < ?`).all(startIso, endIso);
    for (const row of rows) {
      const ms = row.latency_ms || 0;
      const bucket = byTaskId.has(row.task_id) ? byTaskId.get(row.task_id) : 'in-progress';
      const source = sourceByTaskId.has(row.task_id) ? sourceByTaskId.get(row.task_id) : 'in-progress';
      bucketMs[bucket] = (bucketMs[bucket] || 0) + ms;
      bucketCalls[bucket] = (bucketCalls[bucket] || 0) + 1;
      if (hasCostColumn && row.cost_usd != null) {
        bucketCostUsd[bucket] = (bucketCostUsd[bucket] || 0) + row.cost_usd;
        totalCostUsd += row.cost_usd;
        callsWithCost += 1;
        const entry = costBySource.get(source) || { costUsd: 0, calls: 0 };
        entry.costUsd += row.cost_usd;
        entry.calls += 1;
        costBySource.set(source, entry);
      }
      if (hasHypotheticalColumn && row.hypothetical_cost_usd != null) {
        bucketHypotheticalCostUsd[bucket] = (bucketHypotheticalCostUsd[bucket] || 0) + row.hypothetical_cost_usd;
        totalHypotheticalCostUsd += row.hypothetical_cost_usd;
        callsWithHypotheticalCost += 1;
        const hEntry = hypotheticalCostBySource.get(source) || { costUsd: 0, calls: 0 };
        hEntry.costUsd += row.hypothetical_cost_usd;
        hEntry.calls += 1;
        hypotheticalCostBySource.set(source, hEntry);
      }
    }
  } finally {
    db.close();
  }

  const bySource = [...costBySource.entries()]
    .map(([source, v]) => ({ source, costUsd: v.costUsd, calls: v.calls }))
    .sort((a, b) => b.costUsd - a.costUsd);
  const hypotheticalBySource = [...hypotheticalCostBySource.entries()]
    .map(([source, v]) => ({ source, costUsd: v.costUsd, calls: v.calls }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    bucketSec: Object.fromEntries(Object.entries(bucketMs).map(([k, v]) => [k, Math.round(v / 1000)])),
    bucketCalls,
    bucketCostUsd,
    totalCostUsd,
    callsWithCost,
    costBySource: bySource,
    bucketHypotheticalCostUsd,
    totalHypotheticalCostUsd,
    callsWithHypotheticalCost,
    hypotheticalCostBySource: hypotheticalBySource,
  };
}

function oldestFileAgeSec(dir, now) {
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  let oldestMtime = null;
  for (const name of entries) {
    try {
      const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
      if (oldestMtime === null || mtime < oldestMtime) oldestMtime = mtime;
    } catch {
      // skip an unreadable file rather than let it abort the whole scan
    }
  }
  return oldestMtime === null ? null : Math.round((now.getTime() - oldestMtime) / 1000);
}

function computeQueueHealth(pipelineDir, now = new Date()) {
  const queueDir = path.join(pipelineDir, 'queue');
  const counts = {};
  for (const state of LIVE_QUEUE_STATES) {
    try {
      counts[state] = fs.readdirSync(path.join(queueDir, state)).filter((f) => f.endsWith('.json')).length;
    } catch {
      counts[state] = 0;
    }
  }

  // drafting/ is one level deeper (per-instance subfolders) -- same walk task-sources.js's
  // own hasDraftingWork uses.
  let draftingCount = 0;
  try {
    const draftingDir = path.join(queueDir, 'drafting');
    for (const entry of fs.readdirSync(draftingDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        draftingCount += fs.readdirSync(path.join(draftingDir, entry.name)).filter((f) => f.endsWith('.json')).length;
      } catch {
        // skip an unreadable instance subfolder
      }
    }
  } catch {
    // no drafting dir at all -- 0 is correct
  }
  counts.drafting = draftingCount;

  return {
    counts,
    oldestReviewAgeSec: oldestFileAgeSec(path.join(queueDir, 'review'), now),
    oldestPendingAgeSec: oldestFileAgeSec(path.join(queueDir, 'pending'), now),
  };
}

function computeSelfAuditActivity(selfAuditCoveragePath, startIso, endIso) {
  let coverage;
  try {
    coverage = JSON.parse(fs.readFileSync(selfAuditCoveragePath, 'utf8'));
  } catch {
    return [];
  }
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const activity = [];
  for (const [signature, entry] of Object.entries(coverage || {})) {
    const at = entry && entry.reportedAt ? new Date(entry.reportedAt).getTime() : NaN;
    if (Number.isNaN(at) || at < start || at >= end) continue;
    activity.push({ signature, taskId: entry.taskId, reportedAt: entry.reportedAt });
  }
  activity.sort((a, b) => new Date(a.reportedAt) - new Date(b.reportedAt));
  return activity;
}

function computeBlockedPatterns(tasks) {
  const junkTasks = tasks.filter((t) => t.classification === 'junk');
  const counts = new Map();
  let uncategorized = 0;
  for (const task of junkTasks) {
    const signature = signatureForTask(task);
    if (!signature) {
      uncategorized += 1;
      continue;
    }
    counts.set(signature, (counts.get(signature) || 0) + 1);
  }
  const patterns = [...counts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count);
  return { patterns, uncategorized, totalJunk: junkTasks.length };
}

module.exports = { classifyTask, scanTaskActivity, computeDowntime, computeTimeAccounting, oldestFileAgeSec, computeQueueHealth, computeSelfAuditActivity, computeBlockedPatterns, DOWN_GAP_THRESHOLD_SEC, LIVE_QUEUE_STATES, terminalTimestamp };
