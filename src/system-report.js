'use strict';

// Hourly/daily/weekly "what did the pipeline actually do" reports, filed into Second
// Brain (Grimmethy, 2026-08-19 brain dump: "We need to start filing an hourly, daily and
// weekly report into second brain showing what was accomplished during those time
// periods. This should be a new task that is triggered on schedule. We need the report to
// track downtimes and the amount of real time spent on junk tasks vs real benefit").
//
// Deliberately NOT a normal task-sources.js source: a report is a deterministic
// aggregation of already-real data, not an LLM judgment call, so it never touches
// drafting/review/approval -- same "pure code, no model call" shape drift-scan.js and
// reject-retry-check.js already use for queue-watcher.sh's other per-tick housekeeping.
//
// Three inputs, each already real state this pipeline maintains for other reasons:
//   1. queue/done/ + queue/blocked/ (including done/_archived_no_action/) -- what tasks
//      reached a terminal state in the window, and how each is classified (see
//      classifyTask()).
//   2. instances/.uptime-log.jsonl (uptime-log.js, new alongside this) -- per-tick
//      snapshots of every daemon's heartbeat, used to compute downtime.
//   3. model-stats.db's model_calls table -- real per-call wall-clock time (latency_ms),
//      joined back to each call's task_id so time can be summed per classification bucket
//      instead of just counting tasks. Requires model-stats-db.js's node:sqlite migration
//      (2026-08-19, same investigation that led here) to actually have data -- calls made
//      before that fix landed simply have no rows and fall back to a task-count-only view
//      for whatever window includes them, which the report's own methodology note says
//      plainly rather than silently pretending the number is more precise than it is.
//
// CLI:
//   node system-report.js --check-due               (queue-watcher.sh's own per-tick call)
//   node system-report.js --period hourly|daily|weekly --start <iso> --end <iso> [--dry-run]

const fs = require('fs');
const path = require('path');
const { getConfig, ensureRegistered } = require('./config.js');
const { readSamplesInWindow } = require('./uptime-log.js');
const { signatureForTask } = require('./pipeline-self-audit.js');
const { listArchivedMonthDirs } = require('./done-archive.js');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');

// classifyTask() reads each source's own reportClass off the registry (see its comment).
// Populate it with this repo's built-ins + any AGENT_MANAGER_REGISTER_PATH plugin sources,
// same as the loop entry points do -- queue-watcher.sh runs this CLI with the env sourced.
ensureRegistered();

const PERIOD_MS = { hourly: 60 * 60 * 1000, daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };

// A sample-to-sample gap wider than this counts as "pipeline down" for that whole gap --
// generously above queue-watcher.sh's own default 60s tick interval so ordinary tick
// jitter is never misreported as downtime; see uptime-log.js's header for why a gap is
// the only signal available at all.
const DOWN_GAP_THRESHOLD_SEC = 240;

function terminalTimestamp(task) {
  const hist = task.history;
  if (Array.isArray(hist) && hist.length) {
    const last = hist[hist.length - 1];
    if (last && last.at) return last.at;
  }
  return task.createdAt || null;
}

// One task's place in the "junk vs. filtering vs. benefit" accounting -- see this
// module's own header for why these four buckets specifically (mirrors the breakdown
// already given directly to Grimmethy earlier the same session, "How do the completed
// tasks benefit our program and projects?").
//   'junk'        -- wasted compute, zero usable output (blocked, or archived as a
//                    confirmed-bad finding, e.g. the minified-file scanner bug).
//   'benefit'     -- a real, direct outcome: shipped code, a genuine issue caught, a
//                    curated research artifact.
//   'filtering'   -- a triage verdict that correctly dismissed a false positive. Real,
//                    productive work (it's what stops a human reading 2,200 flagged
//                    lines by hand), but not "benefit" in the direct sense, so kept
//                    separate rather than inflated into the same bucket.
//   'housekeeping'-- operational upkeep (filing a brain-dump note, resolving an ambiguous
//                    path) that keeps the pipeline itself usable, neither junk nor a
//                    direct product outcome.
//   'unclear'     -- didn't match any of the above; reported as its own bucket rather
//                    than guessed into one, same "don't silently misclassify" reasoning
//                    as everywhere else in this pipeline.
function classifyTask(task, queueState) {
  if (queueState === 'blocked' || queueState === 'archived') return 'junk';

  // A task source declares how its completed tasks count toward this accounting via
  // reportClass on its registration -- a plain bucket string, or a (task) => bucket|null
  // for a source that decides from the draft text (observability/performance review split
  // filtering vs. benefit on what the verdict actually said). ADR-0022 Stage A3: the
  // hardcoded branches below are the fallback for sources that don't declare it, and for
  // when a plugin that would isn't loaded; Stage G removes them.
  const registered = getRegisteredSource(resolveSourceName(task));
  const declared = typeof registered?.reportClass === 'function'
    ? registered.reportClass(task)
    : registered?.reportClass;
  if (declared) return declared;

  const source = task.source;
  if (source === 'observability_review' || source === 'performance_review') {
    const text = (task.implementResponse || '').toLowerCase();
    if (text.includes('false positive') || text.includes('false-positive')) return 'filtering';
    if (text.includes('genuine')) return 'benefit';
    return 'unclear';
  }
  if (source === 'manual' || task.domain === 'adhoc') return 'benefit';
  if (['arch_import', 'arch_discovery', 'deep_dive', 'project_search'].includes(source)) return 'benefit';
  if (['brain_dump_sort', 'path_prefetch_resolve'].includes(source)) return 'housekeeping';
  return 'unclear';
}

// Scans queue/done/ (including done/_archived_no_action/, which is where the minified-
// file-bug cleanup archived 182 confirmed-junk tasks 2026-08-19 -- those are exactly the
// kind of thing this report exists to surface, not hide) and queue/blocked/ for anything
// whose terminal history timestamp falls in [startIso, endIso). Best-effort per file: an
// unreadable/malformed task is skipped, never fatal to the whole scan.
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

// Downtime from uptime-log.js's samples: a gap between consecutive samples wider than
// DOWN_GAP_THRESHOLD_SEC is "pipeline down" for that whole gap (watchdog itself wasn't
// ticking -- see uptime-log.js's header for why this is the best available signal).
// Within samples that DO exist, a specific instance marked `stale` contributes to that
// instance's own downtime separately, even while the rest of the pipeline was fine.
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

// Real per-call wall-clock time AND estimated Anthropic API cost (model-stats.db's
// model_calls.latency_ms / cost_usd), summed per classification bucket AND per task
// source, by joining each call's task_id to the same tasks scanTaskActivity already
// classified. Calls whose task_id doesn't match anything in `tasks` (e.g. a task still in
// progress, not yet terminal) are summed separately as 'in-progress' rather than dropped
// silently. Returns null (not thrown) if the db is missing/unreadable -- node:sqlite is
// itself optional-at-runtime the same way the rest of this pipeline treats a missing
// dependency, and a report with no time-accounting section is still useful.
//
// Cost accounting (2026-08-23, Grimmethy: "We should track it in the hourly/daily/weekly
// logs") -- cost_usd may not exist yet on an older db (model-stats-db.js's own ALTER
// TABLE migration only runs from the Node side's next real recordCall()), so this checks
// pragma_table_info the same way app.py's own _has_cost_usd_column already does, rather
// than letting a missing-column query throw and take down the whole report.
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

const LIVE_QUEUE_STATES = ['pending', 'review', 'approved', 'awaiting-confirm', 'needs-clarification', 'blocked'];

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

// Live snapshot of queue depth/age at report-generation time -- deliberately NOT windowed
// like scanTaskActivity above ("what happened in the period" vs. "how healthy is the
// pipeline RIGHT NOW"). Added 2026-08-20 (Grimmethy: "We need to build this sort of
// analysis into the daily report") after a real multi-day review-runner stall
// (queue/review/ items sitting untouched since 2026-08-17, invisible to every report
// generated during that stretch) went completely unnoticed by the pipeline itself -- the
// task-COUNT numbers looked fine because nothing had reached a terminal state yet to be
// counted at all; only live queue depth/age would have shown a backlog quietly not
// moving. oldestReviewAgeSec/oldestPendingAgeSec are the two states most likely to
// silently stall (a claimed-but-abandoned task, a starved reviewer) without an obvious
// symptom anywhere else.
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

// Surfaces what pipeline_self_audit (see pipeline-self-audit.js) actually found and
// reported during this window -- closes the loop between the two systems built the same
// day: the self-improvement detector's findings now show up in the same report a human
// already reads regularly, instead of only being visible by hand-inspecting
// self-audit-coverage.json.
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

// Breaks the window's blocked/archived ("junk") tasks down by the SAME failure signature
// pipeline-self-audit.js clusters on, reused directly rather than re-implemented --
// surfaces which failure pattern actually dominates a period's junk count (e.g. "18 of
// 21 arch_import blocks this window were the same harness-search-zero-results pattern")
// instead of just a flat blocked count, the exact kind of breakdown that took a manual
// investigation to produce on 2026-08-20 before this existed. Independent of whether any
// pattern has crossed pipeline_self_audit's own CLUSTER_THRESHOLD -- this reports on
// EVERY pattern seen, however small, since a report reader benefits from seeing a pattern
// start forming even before it's large enough for the automated detector to act on it.
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

// Renders an ISO timestamp in the SYSTEM's own local timezone (Grimmethy, 2026-08-20:
// "We should change the time readout on time reports to match the systems time zone") --
// every timestamp this module computes WITH (window boundaries, downtime gaps, schedule
// state) stays UTC/ISO internally, since that's what's actually correct for date-math
// across a DST transition; this only affects how a timestamp is DISPLAYED in the
// rendered report text. Intl.DateTimeFormat's default timeZone already resolves to the
// OS's own configured zone (confirmed live: America/Denver on this box) with no
// hardcoded zone name and no extra config -- correct automatically if this pipeline ever
// runs somewhere else. Falls back to the raw ISO string for a genuinely unparseable
// input rather than throwing.
function fmtLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  });
}

function fmtDuration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtUsd(usd) {
  return `$${usd.toFixed(4)}`;
}

// A short (2-5 sentence) plain-English narrative of what THIS PERIOD specifically
// accomplished -- added 2026-08-20 (Grimmethy: "Every time tracking entry should contain
// a plain english description of the specific benefit and results of that period. This
// includes hourly, daily and weekly reports"). Deterministic (template-filled from
// already-computed numbers/titles), not an LLM call: this module is architecturally the
// one report-generator in this pipeline with NO LLM involvement by design (see this
// file's own header comment), and a report that fires automatically every hour shouldn't
// gain a new failure mode (a stuck/slow/hallucinating model call) or GPU-contention cost
// just to phrase numbers as sentences -- especially right after this session's own
// reviewer-starvation incident, caused by exactly that kind of unnecessary GPU
// contention. Names REAL accomplishments (actual task titles), not just restated counts,
// so a reader gets something concrete rather than a rephrase of the bullet lists below.
function buildPlainEnglishSummary({ period, tasks, byClassification, blockedPatterns, downtime, timeAccounting }) {
  const periodLabel = period === 'hourly' ? 'This hour' : period === 'daily' ? 'Today' : period === 'weekly' ? 'This week' : 'In this period';
  const sentences = [];

  if (tasks.length === 0) {
    let s = `${periodLabel}, the pipeline completed no tasks.`;
    if (downtime && downtime.pipelineDownSec > 0) s += ` It was down for ${fmtDuration(downtime.pipelineDownSec)} during that stretch, which explains at least part of the gap.`;
    return s;
  }

  sentences.push(`${periodLabel}, the pipeline completed ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`);

  const benefitTasks = tasks.filter((t) => t.classification === 'benefit' && t.title);
  if (benefitTasks.length > 0) {
    const named = benefitTasks.slice(0, 2).map((t) => `"${t.title.length > 90 ? t.title.slice(0, 87) + '...' : t.title}"`);
    const remainder = byClassification.benefit - named.length;
    let s = `${byClassification.benefit} delivered real value -- including ${named.join(' and ')}`;
    s += remainder > 0 ? `, plus ${remainder} more.` : '.';
    sentences.push(s);
  } else if (byClassification.benefit > 0) {
    sentences.push(`${byClassification.benefit} delivered real value (no task titles available to name specifically).`);
  } else {
    sentences.push('No task this period shipped a real fix or confirmed improvement.');
  }

  if (byClassification.filtering > 0 || byClassification.junk > 0) {
    let s = `${byClassification.filtering} scanner alert${byClassification.filtering === 1 ? ' was' : 's were'} correctly identified as false positives (saving real review time)`;
    s += byClassification.junk > 0 ? `, and ${byClassification.junk} ${byClassification.junk === 1 ? 'was a' : 'were'} confirmed non-issue${byClassification.junk === 1 ? '' : 's'} or blocked draft${byClassification.junk === 1 ? '' : 's'}` : '';
    const topPattern = blockedPatterns && blockedPatterns.patterns[0];
    if (topPattern && blockedPatterns.totalJunk > 0 && topPattern.count / blockedPatterns.totalJunk >= 0.5) {
      const pct = Math.round((topPattern.count / blockedPatterns.totalJunk) * 100);
      s += ` (${pct}% of which shared the same "${topPattern.signature}" failure pattern -- likely one root cause, not ${topPattern.count} independent problems)`;
    }
    sentences.push(s + '.');
  }

  if (downtime) {
    if (downtime.pipelineDownSec > 0) {
      sentences.push(`The pipeline was down for ${fmtDuration(downtime.pipelineDownSec)} during this period.`);
    } else {
      sentences.push('The pipeline ran continuously with no detected downtime.');
    }
  }

  // 2026-08-23, Grimmethy: "We should track it in the hourly/daily/weekly logs" / "I'd
  // like estimates for if we had used the API. Even if we used the local models." --
  // folds the estimated cost into the narrative itself, not just the table below, using
  // the hypothetical (real Claude + estimated local) figure so a period that ran
  // entirely on local models still gets a real number here instead of silence.
  if (timeAccounting && timeAccounting.callsWithHypotheticalCost > 0) {
    const realPart = timeAccounting.callsWithCost > 0
      ? ` (${fmtUsd(timeAccounting.totalCostUsd)} of that was REAL Claude spend; the rest ran locally, free, and is a token-based estimate)`
      : ' (every one of those calls actually ran locally, free -- this is a token-based estimate of what they would have cost)';
    sentences.push(`If every model call this period had gone through the Anthropic API, it would have cost an estimated ${fmtUsd(timeAccounting.totalHypotheticalCostUsd)} across ${timeAccounting.callsWithHypotheticalCost} call(s)${realPart}.`);
  }

  return sentences.join(' ');
}

function renderMarkdown({ period, startIso, endIso, tasks, downtime, timeAccounting, queueHealth, selfAuditActivity, blockedPatterns }) {
  const bySource = {};
  const byClassification = { junk: 0, benefit: 0, filtering: 0, housekeeping: 0, unclear: 0 };
  for (const t of tasks) {
    bySource[t.source || 'unknown'] = (bySource[t.source || 'unknown'] || 0) + 1;
    byClassification[t.classification] = (byClassification[t.classification] || 0) + 1;
  }

  const lines = [];
  lines.push(`# ${period[0].toUpperCase()}${period.slice(1)} Report — ${fmtLocal(startIso)} to ${fmtLocal(endIso)}`);
  lines.push('');
  lines.push(`**Tasks completed:** ${tasks.length}`);
  lines.push('');

  lines.push('## Summary');
  lines.push(buildPlainEnglishSummary({ period, tasks, byClassification, blockedPatterns, downtime, timeAccounting }));
  lines.push('');

  lines.push('## By Source');
  for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${source}: ${count}`);
  }
  lines.push('');

  lines.push('## Junk vs. Benefit (by task count)');
  lines.push(`- Benefit: ${byClassification.benefit}`);
  lines.push(`- Signal-filtering (correctly dismissed false positives): ${byClassification.filtering}`);
  lines.push(`- Housekeeping: ${byClassification.housekeeping}`);
  lines.push(`- Junk (blocked / confirmed-bad): ${byClassification.junk}`);
  if (byClassification.unclear) lines.push(`- Unclear (not classified): ${byClassification.unclear}`);
  lines.push('');

  if (timeAccounting) {
    // Estimated cost folded directly into this table (2026-08-23, Grimmethy: "I'd like
    // the main time tracking data frame to also include an estimated token cost for
    // that period" -- clarified same day: "I'd like estimates for if we had used the
    // API. Even if we used the local models.") -- each bucket line shows the
    // HYPOTHETICAL figure (what this bucket's real compute would have cost on the API,
    // whether it actually ran on Claude or locally -- always populated, see
    // computeTimeAccounting's own header), not just real spend, since real-spend-only
    // was silently $0 for any bucket that ran entirely on local models -- exactly the
    // gap this clarification called out. The closing line then splits out how much of
    // that total was REAL spend vs. purely hypothetical.
    const bucketLine = (label, sec, calls, hypotheticalCostUsd) => {
      const costPart = hypotheticalCostUsd > 0 ? `, ${fmtUsd(hypotheticalCostUsd)} est. if API` : '';
      return `- ${label}: ${fmtDuration(sec)} (${calls} call(s)${costPart})`;
    };
    lines.push('## Junk vs. Benefit (by real wall-clock time, from model-stats.db)');
    const b = timeAccounting.bucketSec;
    const hcb = timeAccounting.bucketHypotheticalCostUsd || {};
    const calls = timeAccounting.bucketCalls;
    lines.push(bucketLine('Benefit', b.benefit || 0, calls.benefit || 0, hcb.benefit || 0));
    lines.push(bucketLine('Signal-filtering', b.filtering || 0, calls.filtering || 0, hcb.filtering || 0));
    lines.push(bucketLine('Housekeeping', b.housekeeping || 0, calls.housekeeping || 0, hcb.housekeeping || 0));
    lines.push(bucketLine('Junk', b.junk || 0, calls.junk || 0, hcb.junk || 0));
    if (b['in-progress']) lines.push(bucketLine('In-progress / unmatched', b['in-progress'], calls['in-progress'], hcb['in-progress'] || 0));
    if (timeAccounting.callsWithHypotheticalCost > 0) {
      lines.push(`- **Total if every call this period had used the Anthropic API: ${fmtUsd(timeAccounting.totalHypotheticalCostUsd)}** across ${timeAccounting.callsWithHypotheticalCost} call(s) (local models included) -- of which ${fmtUsd(timeAccounting.totalCostUsd)} was REAL spend across ${timeAccounting.callsWithCost} actual Claude call(s); the rest is a token-based estimate for calls that ran locally, free.`);
    }
    lines.push('');
  } else {
    lines.push('## Junk vs. Benefit (by real wall-clock time)');
    lines.push('_model-stats.db was unavailable for this period -- see task-count breakdown above instead._');
    lines.push('');
  }

  // Estimated Anthropic API Cost by SOURCE (2026-08-23, Grimmethy: "We should track it
  // in the hourly/daily/weekly logs" / "Where else would it make sense to track it?" /
  // "Even if we used the local models.") -- the by-outcome-bucket breakdown now lives
  // inline in the table above; this section is what's left that table can't show (which
  // task SOURCE actually drove spend, real or hypothetical). Uses the hypothetical
  // figure so a source that's ENTIRELY local-model-driven still shows up here instead of
  // silently vanishing (a real gap the real-cost-only version had).
  if (timeAccounting && timeAccounting.callsWithHypotheticalCost > 0) {
    lines.push('## Estimated API Cost by Source (if every call had used the API)');
    for (const { source, costUsd, calls } of timeAccounting.hypotheticalCostBySource) {
      lines.push(`- ${source}: ${fmtUsd(costUsd)} (${calls} call(s))`);
    }
    lines.push('');
  } else if (timeAccounting) {
    lines.push('## Estimated API Cost by Source (if every call had used the API)');
    lines.push('_No model calls with a usable token/cost estimate this period._');
    lines.push('');
  }

  if (blockedPatterns && blockedPatterns.totalJunk > 0) {
    lines.push('## Failure Patterns (within junk/blocked)');
    if (blockedPatterns.patterns.length === 0) {
      lines.push(`_${blockedPatterns.totalJunk} junk task(s) this period, none sharing a recognized failure signature -- each looks like an independent one-off._`);
    } else {
      for (const { signature, count } of blockedPatterns.patterns) {
        const pct = Math.round((count / blockedPatterns.totalJunk) * 100);
        lines.push(`- \`${signature}\`: ${count}/${blockedPatterns.totalJunk} (${pct}%)`);
      }
      if (blockedPatterns.uncategorized) lines.push(`- (uncategorized/one-off): ${blockedPatterns.uncategorized}/${blockedPatterns.totalJunk}`);
    }
    lines.push('');
  }

  lines.push('## Queue Health (live snapshot, not windowed to this period)');
  if (queueHealth) {
    const c = queueHealth.counts;
    lines.push(`- pending: ${c.pending} · drafting: ${c.drafting} · review: ${c.review} · approved: ${c.approved} · awaiting-confirm: ${c['awaiting-confirm']} · needs-clarification: ${c['needs-clarification']} · blocked: ${c.blocked}`);
    if (queueHealth.oldestReviewAgeSec !== null) lines.push(`- Oldest item in review/: ${fmtDuration(queueHealth.oldestReviewAgeSec)} old${queueHealth.oldestReviewAgeSec > 3 * 3600 ? ' ⚠ unusually old -- worth checking whether the reviewer is stuck' : ''}`);
    if (queueHealth.oldestPendingAgeSec !== null) lines.push(`- Oldest item in pending/: ${fmtDuration(queueHealth.oldestPendingAgeSec)} old${queueHealth.oldestPendingAgeSec > 3 * 3600 ? ' ⚠ unusually old -- worth checking whether a worker is stuck' : ''}`);
  } else {
    lines.push('_queue state unavailable._');
  }
  lines.push('');

  if (selfAuditActivity && selfAuditActivity.length > 0) {
    lines.push('## Self-Audit Activity (pipeline_self_audit)');
    for (const a of selfAuditActivity) lines.push(`- \`${a.signature}\` reported at ${fmtLocal(a.reportedAt)} → ${a.taskId}`);
    lines.push('');
  }

  lines.push('## Downtime');
  lines.push(`- Total pipeline downtime: ${fmtDuration(downtime.pipelineDownSec)} (out of ${fmtDuration((new Date(endIso) - new Date(startIso)) / 1000)} in this period)`);
  if (downtime.pipelineDownIntervals.length) {
    lines.push('- Down intervals:');
    for (const iv of downtime.pipelineDownIntervals) lines.push(`  - ${fmtLocal(iv.from)} → ${fmtLocal(iv.to)}`);
  }
  const perInstance = Object.entries(downtime.perInstanceDownSec);
  if (perInstance.length) {
    lines.push('- Per-instance downtime (pipeline otherwise up, this instance specifically stale/dead):');
    for (const [id, sec] of perInstance) lines.push(`  - ${id}: ${fmtDuration(sec)}`);
  }
  lines.push('');

  lines.push('## Methodology & Limitations');
  lines.push('- "Junk vs. benefit" classification is a heuristic based on task source and verdict text, not a manual audit -- treat it as a strong first pass, not ground truth (the same review pipeline that classifies these has approved at least one fabricated candidate 3/3 votes).');
  lines.push('- Downtime is inferred from gaps in per-tick heartbeat sampling; the pipeline cannot observe its own downtime any more precisely than "no samples were recorded."');
  lines.push('- Wall-clock time accounting only covers calls recorded in model-stats.db for this window -- see the task-count breakdown as the always-available fallback.');
  lines.push('');

  return lines.join('\n');
}

function reportDir(secondBrainDir, period) {
  return path.join(secondBrainDir, 'Agent Manager Reports', period);
}

function reportFilename(period, endIso) {
  const d = new Date(endIso);
  if (period === 'hourly') return `${d.toISOString().slice(0, 13)}h.md`; // 2026-08-19T14h.md
  if (period === 'daily') return `${d.toISOString().slice(0, 10)}.md`; // 2026-08-19.md
  return `${d.toISOString().slice(0, 10)}-week-ending.md`;
}

function generateReport({ period, startIso, endIso, pipelineDir, instancesDir, dbPath, secondBrainDir, selfAuditCoveragePath }) {
  const tasks = scanTaskActivity(pipelineDir, startIso, endIso);
  const downtime = computeDowntime(instancesDir, startIso, endIso);
  const timeAccounting = computeTimeAccounting(dbPath, tasks, startIso, endIso);
  const queueHealth = computeQueueHealth(pipelineDir);
  const blockedPatterns = computeBlockedPatterns(tasks);
  const selfAuditActivity = selfAuditCoveragePath
    ? computeSelfAuditActivity(selfAuditCoveragePath, startIso, endIso)
    : [];
  const markdown = renderMarkdown({ period, startIso, endIso, tasks, downtime, timeAccounting, queueHealth, selfAuditActivity, blockedPatterns });

  const dir = reportDir(secondBrainDir, period);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, reportFilename(period, endIso));
  fs.writeFileSync(filePath, markdown);

  return { filePath, taskCount: tasks.length, downtime, timeAccounting, queueHealth, blockedPatterns, selfAuditActivity };
}

// --- Scheduling: instances/.report-schedule.json tracks lastGeneratedAt per period -----
function schedulePath(instancesDir) {
  return path.join(instancesDir, '.report-schedule.json');
}

function loadSchedule(instancesDir) {
  try {
    return JSON.parse(fs.readFileSync(schedulePath(instancesDir), 'utf8'));
  } catch {
    return {};
  }
}

function saveSchedule(instancesDir, schedule) {
  fs.writeFileSync(schedulePath(instancesDir), JSON.stringify(schedule, null, 2));
}

// Generates any period whose interval has elapsed since its last report, covering
// [lastGeneratedAt, now) -- a rolling window, not calendar-aligned buckets, so a gap
// (pipeline down when an hour boundary "should" have fired) is naturally folded into the
// next report's window instead of silently skipped. First-ever run bootstraps every
// period's lastGeneratedAt to `now` WITHOUT generating a report -- an immediate backfill
// over the pipeline's entire history would be both huge and not what "hourly/daily/
// weekly" implies; real reports start accruing from whenever this feature first ran.
function checkDue({ pipelineDir, instancesDir, dbPath, secondBrainDir, selfAuditCoveragePath, now = new Date() }) {
  const schedule = loadSchedule(instancesDir);
  const generated = [];
  let changed = false;

  for (const period of ['hourly', 'daily', 'weekly']) {
    const last = schedule[period]?.lastGeneratedAt;
    if (!last) {
      schedule[period] = { lastGeneratedAt: now.toISOString() };
      changed = true;
      continue;
    }
    const elapsedMs = now.getTime() - new Date(last).getTime();
    if (elapsedMs < PERIOD_MS[period]) continue;

    const result = generateReport({ period, startIso: last, endIso: now.toISOString(), pipelineDir, instancesDir, dbPath, secondBrainDir, selfAuditCoveragePath });
    generated.push({ period, ...result });
    schedule[period] = { lastGeneratedAt: now.toISOString() };
    changed = true;
  }

  if (changed) saveSchedule(instancesDir, schedule);
  return generated;
}

module.exports = {
  classifyTask, scanTaskActivity, computeDowntime, computeTimeAccounting, renderMarkdown,
  computeQueueHealth, computeSelfAuditActivity, computeBlockedPatterns, buildPlainEnglishSummary, fmtLocal, fmtUsd,
  generateReport, checkDue, loadSchedule, saveSchedule, PERIOD_MS,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };

  const { pipelineDir, secondBrainDir, selfAuditCoveragePath } = getConfig();
  const instancesDir = path.join(pipelineDir, 'instances');
  const dbPath = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH || path.join(pipelineDir, 'model-stats.db');

  if (args.includes('--check-due')) {
    if (!secondBrainDir) {
      console.error('system-report: SECOND_BRAIN_DIR is not set -- skipping (nowhere to write reports).');
      process.exit(0);
    }
    const generated = checkDue({ pipelineDir, instancesDir, dbPath, secondBrainDir, selfAuditCoveragePath });
    for (const g of generated) console.log(`[system-report] wrote ${g.period} report (${g.taskCount} tasks): ${g.filePath}`);
    process.exit(0);
  }

  const period = flag('period');
  const startIso = flag('start');
  const endIso = flag('end');
  if (!period || !startIso || !endIso) {
    console.error('Usage: node system-report.js --check-due');
    console.error('   or: node system-report.js --period hourly|daily|weekly --start <iso> --end <iso>');
    process.exit(1);
  }
  if (!secondBrainDir) {
    console.error('system-report: SECOND_BRAIN_DIR is not set.');
    process.exit(1);
  }
  const result = generateReport({ period, startIso, endIso, pipelineDir, instancesDir, dbPath, secondBrainDir, selfAuditCoveragePath });
  console.log(`wrote ${result.filePath} (${result.taskCount} tasks)`);
}
