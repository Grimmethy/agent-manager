'use strict';

// Context outcomes (2026-11-05, piece P2 of the context-impact loop, plan context-ops-plan/PLAN-impact-loop.md).
//
// Joins the `contextProvenance` stamp (src/lib/context-provenance.js, stamped on a task by runPlanPass) with what happened to the task:
// shipped (queue/done) against stuck (queue/blocked and queue/needs-clarification, the CONTRAST set, the same survivorship discipline
// as src/debrief-bundle.js: describe both sides, never only the successes). DESCRIPTIVE ONLY: counts and rates per cell, no causal
// wording, no recommendations, and a `caveats` array on every output. A cell with fewer than MIN_CELL_N tasks reports `insufficient`
// and no rate. Different task `source`s are never pooled (a stratum per source). A task without a usable stamp is `unstamped` and is
// reported as its own baseline per stratum (every task drafted before the stamp existed is one).
//
// Outcome facts come from the real record: terminalDisposition, the history STAGE names (advisory events are noise and are not counted),
// and the stage names that mean a retry or a stop. FIRST PASS = approved, never requeued, never blocked, never sent to clarification,
// and drafted once (at most one draft-started stage). Read-only: it reads queue/<state>/*.json and writes nothing.
//
//   joinContextOutcomes({ pipelineDir, sinceMs, nowMs, readDir })   readDir(dir, minMtimeMs) -> [record] (injected in tests)
//   CLI: node src/context-outcomes.js [--since 14d] [--pipeline-dir <dir>]   prints JSON; pipeline dir defaults to AGENT_MANAGER_PIPELINE_DIR,
//   then AGENT_MANAGER_REPO_ROOT, then the working directory.

const fs = require('fs');
const path = require('path');
const { terminalTs } = require('./forensic-bundle.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SINCE_MS = 14 * DAY_MS;
const MIN_CELL_N = 10;
const CAVEATS = [
  'confounded by task size and source',
  'stamped tasks only exist since the context provenance stamp merged; unstamped tasks are the baseline before it',
  'descriptive correlations, not effects',
  'a task still in flight is in no state directory and is not counted',
];
const EXCLUDED_DISPOSITIONS = new Set(['noop', 'dismissed', 'abandoned', 'filed']);
const RETRY_STAGES = new Set(['requeued', 'blocked', 'needs-clarification']);

// Reads queue/<state>/*.json whose file mtime is at or after minMtimeMs (a stat before the parse: the done directory holds thousands of records).
function defaultReadDir(dir, minMtimeMs) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (minMtimeMs && fs.statSync(file).mtimeMs < minMtimeMs) continue;
      out.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch { /* an unreadable or torn record is skipped */ }
  }
  return out;
}

const stages = (task) => (Array.isArray(task && task.history) ? task.history : []).map((h) => h && h.stage).filter((s) => typeof s === 'string' && s !== 'advisory');

function isFirstPass(task) {
  const s = stages(task);
  if (!s.includes('approved')) return false;
  if (s.some((x) => RETRY_STAGES.has(x))) return false;
  return s.filter((x) => x === 'draft-started').length <= 1;
}

const isShipped = (task) => !EXCLUDED_DISPOSITIONS.has(task && task.terminalDisposition);

function blockedClass(task) {
  const raw = task && (task.blockedReason || task.needsClarification);
  const text = typeof raw === 'string' ? raw : (raw ? JSON.stringify(raw) : '');
  if (/design-decision/.test(text)) return 'design-decision';
  if (/Deterministic gate/.test(text)) return 'executed-verification-gate';
  if (/Plan pass degenerate/.test(text)) return 'degenerate-plan';
  if (/premise may be stale/.test(text)) return 'stale-premise';
  if (/Ungrounded draft/.test(text)) return 'ungrounded-draft';
  if (/Agentic implement pass/.test(text)) return 'agentic-diff';
  return 'other';
}

const validStamp = (task) => !!(task && task.contextProvenance && typeof task.contextProvenance === 'object' && !Array.isArray(task.contextProvenance));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const FEATURES = {
  anchorFileCount: (p) => { const n = num(p.anchorFileCount); return n === null ? null : (n === 0 ? '0' : n <= 2 ? '1-2' : '3+'); },
  grepHitFileCount: (p) => { const n = num(p.grepHitFileCount); return n === null ? null : (n === 0 ? '0' : '1+'); },
  orientRan: (p) => (typeof p.orientRan === 'boolean' ? String(p.orientRan) : null),
  priorRejectionCount: (p) => { const n = num(p.priorRejectionCount); return n === null ? null : (n === 0 ? '0' : '1+'); },
};

function median(values) {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// items: [{ state: 'done' | 'stuck', firstPass, stageCount }]
function cell(items) {
  const n = items.length;
  if (n < MIN_CELL_N) return { n, insufficient: true };
  return {
    n,
    approvedFirstPass: items.filter((i) => i.state === 'done' && i.firstPass).length,
    blockedOrNeedsClarification: items.filter((i) => i.state === 'stuck').length,
    medianHistoryStages: median(items.map((i) => i.stageCount)),
  };
}

function joinContextOutcomes({ pipelineDir, sinceMs = DEFAULT_SINCE_MS, nowMs = Date.now(), readDir = defaultReadDir } = {}) {
  const cutoff = nowMs - sinceMs;
  const dirOf = (state) => path.join(pipelineDir || '.', 'queue', state);
  const inWindow = (task) => { const ts = Date.parse(terminalTs(task) || ''); return Number.isFinite(ts) && ts >= cutoff && ts <= nowMs + DAY_MS; };

  const counts = { shipped: 0, excludedDone: 0, blocked: 0, needsClarification: 0, stamped: 0, unstamped: 0 };
  const byStratum = new Map();
  const add = (task, state) => {
    const source = (task && typeof task.source === 'string' && task.source) || 'unknown';
    if (!byStratum.has(source)) byStratum.set(source, { items: [], unstampedItems: [], blockedClasses: {}, stuck: 0 });
    const s = byStratum.get(source);
    const item = { state, firstPass: isFirstPass(task), stageCount: stages(task).length, task };
    if (state === 'stuck') { s.stuck += 1; const c = blockedClass(task); s.blockedClasses[c] = (s.blockedClasses[c] || 0) + 1; }
    if (validStamp(task)) { s.items.push(item); counts.stamped += 1; } else { s.unstampedItems.push(item); counts.unstamped += 1; }
  };

  for (const task of readDir(dirOf('done'), cutoff)) {
    if (!inWindow(task)) continue;
    if (!isShipped(task)) { counts.excludedDone += 1; continue; }
    counts.shipped += 1;
    add(task, 'done');
  }
  for (const [state, key] of [['blocked', 'blocked'], ['needs-clarification', 'needsClarification']]) {
    for (const task of readDir(dirOf(state), cutoff)) {
      if (!inWindow(task)) continue;
      counts[key] += 1;
      add(task, 'stuck');
    }
  }

  const strata = {};
  for (const source of [...byStratum.keys()].sort()) {
    const s = byStratum.get(source);
    const cells = {};
    for (const [feature, bucketOf] of Object.entries(FEATURES)) {
      const groups = {};
      for (const item of s.items) {
        const b = bucketOf(item.task.contextProvenance);
        if (b === null) continue;
        (groups[b] = groups[b] || []).push(item);
      }
      cells[feature] = Object.fromEntries(Object.keys(groups).sort().map((b) => [b, cell(groups[b])]));
    }
    strata[source] = {
      stamped: s.items.length,
      unstamped: cell(s.unstampedItems),
      stuck: s.stuck,
      blockedClasses: s.blockedClasses,
      cells,
    };
  }

  return { window: { sinceMs, nowMs }, minCellN: MIN_CELL_N, counts, strata, caveats: CAVEATS.slice() };
}

function parseSince(text) {
  const m = /^(\d+(?:\.\d+)?)(d|h|m)?$/.exec(String(text || '').trim());
  if (!m) return DEFAULT_SINCE_MS;
  const unit = m[2] === 'h' ? 60 * 60 * 1000 : m[2] === 'm' ? 60 * 1000 : DAY_MS;
  return Math.round(Number(m[1]) * unit);
}

function main(argv = process.argv.slice(2), env = process.env, out = (s) => process.stdout.write(`${s}\n`)) {
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const pipelineDir = flag('--pipeline-dir') || env.AGENT_MANAGER_PIPELINE_DIR || env.AGENT_MANAGER_REPO_ROOT || process.cwd();
  out(JSON.stringify(joinContextOutcomes({ pipelineDir, sinceMs: parseSince(flag('--since')) }), null, 2));
  return 0;
}

module.exports = { joinContextOutcomes, parseSince, defaultReadDir, isFirstPass, blockedClass, MIN_CELL_N, CAVEATS };

if (require.main === module) process.exit(main());
