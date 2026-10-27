'use strict';

// Capability ledger (docs/design-notes/capability-routing-and-benchmarking.md, step 1): one NDJSON line per draft attempt -- which source ran on
// which lane/model, how it ended, how long it took -- written to the unified pipeline-history log as type 'attempt'. buildScorecard() folds those
// lines into a per-(source, model) success rate with a Wilson lower bound, so "does this task class fit on the small model" is answered by data.
// Nothing here changes routing; it only records and reports. Best-effort like every audit trail: a write failure never breaks the draft.

const { logPipelineEvent, readPipelineHistory } = require('./pipeline-history.js');

const LEDGER_TYPE = 'attempt';
const DEFAULT_WINDOW_DAYS = 14;
const Z95 = 1.96;

// Parameter count (billions) from a model tag: "qwen3-vl:8b-instruct" -> 8, "gemma3:27b" -> 27, "x:e4b" -> 4. null when the tag carries no size.
function tierFromModel(model) {
  const m = /(?:^|[:\-_ ])e?(\d+(?:\.\d+)?)b(?![a-z])/i.exec(String(model || ''));
  return m ? Number(m[1]) : null;
}

// ok | rejected | timeout | degenerate | error, from a finalized draft attempt record (draft-attempt-record.js).
function classifyOutcome(attempt) {
  const a = attempt || {};
  const text = `${a.reason || ''} ${a.blockedReason || ''}`;
  if (/OLLAMA_TIMEOUT|timed out|ETIMEDOUT|aborted due to timeout/i.test(text)) return 'timeout';
  if (/degenerate|truncated/i.test(text)) return 'degenerate';
  if (a.outcome === 'succeeded') return 'ok';
  if (a.outcome === 'blocked' || a.outcome === 'needs-clarification') return 'rejected';
  return 'error';
}

// Build the ledger entry for one finalized attempt. `ctx`: { source, taskId, env }.
function buildEntry(attempt, ctx = {}) {
  const env = ctx.env || process.env;
  const model = env.LOCAL_MODEL || null;
  const start = attempt && attempt.at ? new Date(attempt.at).getTime() : NaN;
  const end = attempt && attempt.finishedAt ? new Date(attempt.finishedAt).getTime() : NaN;
  const numCtx = Number(env.AGENT_MANAGER_LANE_NUM_CTX);
  return {
    taskId: ctx.taskId || null,
    source: ctx.source || (attempt && attempt.source) || null,
    lane: env.AGENT_MANAGER_INSTANCE_ID || null,
    model,
    tier: tierFromModel(model),
    numCtx: Number.isFinite(numCtx) && numCtx > 0 ? numCtx : null,
    outcome: classifyOutcome(attempt),
    attemptNo: attempt ? attempt.attemptNo || null : null,
    wallMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
    // Whether the prompt's TIME BUDGET line was on for this attempt (AGENT_MANAGER_PROMPT_BUDGET_BLOCK, brain-dump 1895), so
    // budgetBlockComparison can read its effect on timeouts instead of guessing from before/after dates.
    budgetBlock: ['on', '1', 'true'].includes(String(env.AGENT_MANAGER_PROMPT_BUDGET_BLOCK || '').trim().toLowerCase()),
    tps: ctx.throughput ? ctx.throughput.tps : null,
    evalTokens: ctx.throughput ? ctx.throughput.tokens : null,
    reason: attempt && (attempt.blockedReason || attempt.reason) ? String(attempt.blockedReason || attempt.reason).slice(0, 200) : null,
  };
}

function recordAttempt(pipelineDir, attempt, ctx) {
  try {
    if (!pipelineDir || !attempt) return;
    logPipelineEvent(pipelineDir, LEDGER_TYPE, buildEntry(attempt, ctx));
  } catch { /* best-effort */ }
}

function wilsonLower(ok, n) {
  if (!n) return 0;
  const p = ok / n;
  const z2 = Z95 * Z95;
  return (p + z2 / (2 * n) - Z95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Fold ledger entries into rows keyed by (source, model): { source, model, tier, lane(s), n, ok, okRate, lower, p50WallMs, p95WallMs, outcomes }.
// Window and entries are the caller's choice; passing `entries` keeps this pure for tests.
function buildScorecard(entries) {
  const rows = new Map();
  for (const e of entries || []) {
    if (!e || !e.source || !e.model) continue;
    const key = `${e.source}\u0000${e.model}`;
    let r = rows.get(key);
    if (!r) {
      r = { source: e.source, model: e.model, tier: e.tier == null ? tierFromModel(e.model) : e.tier, lanes: new Set(), n: 0, ok: 0, outcomes: {}, walls: [], tpss: [], failStreak: 0 };
      rows.set(key, r);
    }
    r.n += 1;
    if (e.outcome === 'ok') { r.ok += 1; r.failStreak = 0; } else r.failStreak += 1; // entries arrive oldest-first, so this ends as the trailing run of failures
    r.outcomes[e.outcome] = (r.outcomes[e.outcome] || 0) + 1;
    if (e.lane) r.lanes.add(e.lane);
    if (Number.isFinite(e.wallMs)) r.walls.push(e.wallMs);
    if (Number.isFinite(e.tps) && e.tps > 0) r.tpss.push(e.tps);
  }
  return [...rows.values()].map((r) => {
    const walls = r.walls.sort((a, b) => a - b);
    const tpss = r.tpss.sort((a, b) => a - b);
    return {
      source: r.source, model: r.model, tier: r.tier, lanes: [...r.lanes].sort(), n: r.n, ok: r.ok,
      okRate: r.n ? r.ok / r.n : 0, lower: wilsonLower(r.ok, r.n),
      p50WallMs: percentile(walls, 0.5), p95WallMs: percentile(walls, 0.95), outcomes: r.outcomes, failStreak: r.failStreak, tpsP50: percentile(tpss, 0.5),
    };
  }).sort((a, b) => a.source.localeCompare(b.source) || (a.tier ?? 1e9) - (b.tier ?? 1e9) || a.model.localeCompare(b.model));
}

// Adds `variantOf` (the root parent source, or null) to each row, given a `parentOf(sourceName)` lookup; rows keep their own (source, model) identity.
function annotateVariants(rows, parentOf) {
  return rows.map((r) => ({ ...r, variantOf: (typeof parentOf === 'function' && parentOf(r.source)) || null }));
}

// Per lane: attempts with the prompt budget block on vs off -- n, ok, timeout counts and rates, median wall time. Only entries that carry the
// budgetBlock field count (older lines are neither on nor off), so the comparison is never padded with attempts that predate the switch.
function budgetBlockComparison(entries) {
  const lanes = new Map();
  for (const e of entries || []) {
    if (!e || typeof e.budgetBlock !== 'boolean') continue;
    const lane = e.lane || '-';
    const row = lanes.get(lane) || { lane, on: { n: 0, ok: 0, timeout: 0, walls: [] }, off: { n: 0, ok: 0, timeout: 0, walls: [] } };
    const side = e.budgetBlock ? row.on : row.off;
    side.n += 1;
    if (e.outcome === 'ok') side.ok += 1;
    if (e.outcome === 'timeout') side.timeout += 1;
    if (Number.isFinite(e.wallMs)) side.walls.push(e.wallMs);
    lanes.set(lane, row);
  }
  const fin = (s) => {
    const walls = s.walls.sort((a, b) => a - b);
    return { n: s.n, ok: s.ok, timeout: s.timeout, okRate: s.n ? s.ok / s.n : null, timeoutRate: s.n ? s.timeout / s.n : null, p50WallMs: percentile(walls, 0.5) };
  };
  return [...lanes.values()].map((r) => ({ lane: r.lane, on: fin(r.on), off: fin(r.off) })).sort((a, b) => a.lane.localeCompare(b.lane));
}

function readBudgetBlockComparison(pipelineDir, { windowDays = DEFAULT_WINDOW_DAYS, now = Date.now() } = {}) {
  const since = new Date(now - windowDays * 86400000).toISOString();
  return budgetBlockComparison(readPipelineHistory(pipelineDir, { type: LEDGER_TYPE, since }));
}

function readScorecard(pipelineDir, { windowDays = DEFAULT_WINDOW_DAYS, now = Date.now() } = {}) {
  const since = new Date(now - windowDays * 86400000).toISOString();
  return buildScorecard(readPipelineHistory(pipelineDir, { type: LEDGER_TYPE, since }));
}

module.exports = { annotateVariants, LEDGER_TYPE, tierFromModel, classifyOutcome, buildEntry, recordAttempt, wilsonLower, buildScorecard, readScorecard, budgetBlockComparison, readBudgetBlockComparison };

if (require.main === module) {
  const dir = process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
  const days = Number(process.argv[2]) || DEFAULT_WINDOW_DAYS;
  if (process.argv.includes('--budget-block')) {
    const cmp = readBudgetBlockComparison(dir, { windowDays: days });
    if (process.argv.includes('--json')) console.log(JSON.stringify(cmp, null, 2));
    else {
      const pct = (x) => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);
      console.log('lane'.padEnd(16) + 'block'.padEnd(6) + 'n'.padStart(5) + '  timeout%  ok%  p50s');
      for (const r of cmp) {
        for (const k of ['off', 'on']) {
          const s = r[k];
          console.log(r.lane.padEnd(16) + k.padEnd(6) + String(s.n).padStart(5) + `  ${pct(s.timeoutRate).padStart(8)}  ${pct(s.okRate).padStart(4)}  ${s.p50WallMs == null ? '-' : Math.round(s.p50WallMs / 1000)}`);
        }
      }
    }
    process.exit(0);
  }
  let rows = readScorecard(dir, { windowDays: days });
  // --with-variants loads the source registry (heavy: needs AGENT_MANAGER_REPO_ROOT) to tag each row with its variantOf parent.
  if (process.argv.includes('--with-variants')) {
    try {
      require('./task-sources.js');
      rows = annotateVariants(rows, require('./task-source-registry.js').variantParentOf);
    } catch (e) { console.error(`--with-variants: registry unavailable (${e.message}); rows left unannotated`); }
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(`source`.padEnd(30) + `model`.padEnd(26) + `n`.padStart(4) + `  ok%  lower  p50s`);
    for (const r of rows) {
      console.log(r.source.padEnd(30) + r.model.padEnd(26) + String(r.n).padStart(4) + `  ${(r.okRate * 100).toFixed(0).padStart(3)}  ${r.lower.toFixed(2)}  ${r.p50WallMs == null ? '-' : Math.round(r.p50WallMs / 1000)}`);
    }
  }
}
