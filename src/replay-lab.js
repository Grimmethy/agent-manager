'use strict';

// Replay lab (docs/design-notes/task-atomization-plugin.md): does a task source still hold up on a smaller model? Builds a corpus of RECORDED tasks of one
// source, replays each through src/dry-run.js against a chosen lane/model, and scores the outputs. It is the automated form of the hand-run 8B-vs-27B
// comparisons of 2026-10-17/18 (brain_dump_sort), which caught defects the format check missed.
//
// Why the scoring is split by what was recorded: hygiene sources mostly end in a NOOP ("nothing to flag"; change_review: 612 noop vs 33 merged). A model that
// always answers "nothing to flag" would agree with the record ~95% of the time and be useless. So every replay is classed by its recorded outcome --
// positive (the pipeline acted on it), noop (accepted "no finding"), dismissed (the pipeline rejected it) -- and the headline numbers are recall on
// POSITIVES and the false-positive rate on NOOPs, not overall agreement.
//
// Nothing here writes to the queue, ledger or repo: replays go through dryRunDraft, reports go to <pipelineDir>/replay-reports/.

const fs = require('fs');
const path = require('path');
const { dryRunDraft, freshTaskForReplay } = require('./dry-run.js');
const { wilsonLower, classifyOutcome } = require('./capability-ledger.js');

const POSITIVE = new Set(['merged', 'pending-merge', 'filed', 'applied', 'fixed']);
const DEFAULT_MIN_N = 30;
const DEFAULT_MARGIN = 0.10;
const DEFAULT_HUMAN_SAMPLE = 10;

// The recorded outcome class of a finished task.
function classifyRecorded(task) {
  const d = task && task.terminalDisposition;
  if (POSITIVE.has(d)) return 'positive';
  if (d === 'noop') return 'noop';
  if (d === 'dismissed' || d === 'abandoned') return 'dismissed';
  return 'other';
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

function listDoneTasks(pipelineDir) {
  const dir = path.join(pipelineDir, 'queue', 'done');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
  return names.map((n) => readJson(path.join(dir, n))).filter(Boolean);
}

/**
 * buildCorpus({ pipelineDir, source, limit = 60, positiveShare = 0.5, seed = 'lab', tasks })
 * -> { source, entries: [{ id, klass, task, recorded }], counts }
 * Stratified so positives (the rare, valuable class) are over-represented: up to limit*positiveShare positives, the rest noop/dismissed. Ordering is a
 * seeded hash, so a corpus is reproducible for a given pool. `tasks` lets a caller/test supply the pool instead of reading queue/done.
 */
function buildCorpus({ pipelineDir, source, limit = 60, positiveShare = 0.5, seed = 'lab', tasks } = {}) {
  const { resolveSourceName } = require('./task-source-registry.js');
  const pool = (tasks || listDoneTasks(pipelineDir)).filter((t) => {
    if (!t || !t.promptContext) return false;
    let name = t.source;
    try { name = resolveSourceName(t) || t.source; } catch (_) { /* keep t.source */ }
    return name === source || t.source === source;
  });
  const byClass = { positive: [], noop: [], dismissed: [] };
  for (const t of pool) {
    const k = classifyRecorded(t);
    if (byClass[k]) byClass[k].push(t);
  }
  const order = (a) => a.sort((x, y) => hash32(`${seed}|${x.id}`) - hash32(`${seed}|${y.id}`));
  const wantPos = Math.min(byClass.positive.length, Math.ceil(limit * positiveShare));
  const positives = order(byClass.positive).slice(0, wantPos);
  const rest = order([...byClass.noop, ...byClass.dismissed]).slice(0, Math.max(0, limit - positives.length));
  const entries = [...positives, ...rest].map((t) => {
    const attempts = Array.isArray(t.draftAttempts) ? t.draftAttempts : [];
    const last = attempts[attempts.length - 1] || {};
    return {
      id: t.id,
      klass: classifyRecorded(t),
      task: freshTaskForReplay(t),
      recorded: {
        implementResponse: String(t.implementResponse || '').slice(0, 20000),
        disposition: t.terminalDisposition || null,
        lane: last.lane || null,
      },
    };
  });
  return { source, entries, counts: { pool: pool.length, positive: byClass.positive.length, noop: byClass.noop.length, dismissed: byClass.dismissed.length, selected: entries.length } };
}

// ---- comparing a replay to the record ---------------------------------------------------------------------------------------------------------

// "Nothing to flag": the very short / explicit-negative answers hygiene reviewers give (change_review's recorded noop is a 21-character line).
const NULLISH_RE = /^\s*(?:no\b[^\n]{0,60}|nothing\b[^\n]{0,60}|none\b[^\n]{0,40}|clean\b[^\n]{0,40}|ok\b[^\n]{0,40}|false positive\b[^\n]{0,200}|no confident[^\n]{0,200}|no clear[^\n]{0,200})\s*$/i;
function isNullish(text) {
  const t = String(text || '').trim();
  return t.length === 0 || t.length < 40 || NULLISH_RE.test(t);
}

function jsonOf(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch (_) { return null; }
}

function tokens(text) { return new Set(String(text || '').toLowerCase().match(/[a-z0-9_.\-/]{3,}/g) || []); }
function jaccard(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// Source-specific comparers. A source registration may carry its own `replayCompare(recordedText, replayedText) -> { fields }` (booleans); built-ins cover the
// sources the lab was proven on. Each returns a flat map of field -> boolean agreement.
const BUILTIN_COMPARERS = {
  brain_dump_sort(recorded, replayed) {
    const a = jsonOf(recorded); const b = jsonOf(replayed);
    if (!a || !b) return { parseable: !!b };
    const top = (j) => String(j.secondBrainPath || '').split('/')[0];
    return {
      parseable: true,
      actionable: !!a.actionable === !!b.actionable,
      belongsToProject: (a.belongsToProject || null) === (b.belongsToProject || null),
      topFolder: top(a) === top(b),
      requiresResearch: !!a.requiresResearch === !!b.requiresResearch,
    };
  },
};

function compareOutputs(source, recordedText, replayedText) {
  let fields = null;
  try {
    const reg = require('./task-source-registry.js').getRegisteredSource(source);
    if (reg && typeof reg.replayCompare === 'function') fields = reg.replayCompare(recordedText, replayedText);
  } catch (_) { fields = null; }
  if (!fields && BUILTIN_COMPARERS[source]) fields = BUILTIN_COMPARERS[source](recordedText, replayedText);
  const recNull = isNullish(recordedText);
  const repNull = isNullish(replayedText);
  return {
    sameVerdictShape: recNull === repNull,
    recordedNullish: recNull,
    replayedNullish: repNull,
    similarity: Math.round(jaccard(recordedText, replayedText) * 100) / 100,
    fields: fields || {},
  };
}

// ---- running and summarising ------------------------------------------------------------------------------------------------------------------

function scoreReplay(entry, dry) {
  const after = dry.task || {};
  const attempts = Array.isArray(after.draftAttempts) ? after.draftAttempts : [];
  const last = attempts[attempts.length - 1] || null;
  const replayedText = String(after.implementResponse || '');
  const drafted = !!(dry.ok && last && last.outcome === 'succeeded' && !dry.result.blocked);
  const cmp = compareOutputs(entry.task.source, entry.recorded.implementResponse, replayedText);
  return {
    id: entry.id,
    klass: entry.klass,
    drafted,
    failure: drafted ? null : (last ? classifyOutcome(last) : (dry.result && /timed out/.test(dry.result.reason || '') ? 'timeout' : 'error')),
    reason: drafted ? null : String((last && (last.reason || last.blockedReason)) || (dry.result && dry.result.reason) || '').slice(0, 160),
    durationMs: dry.durationMs,
    compare: cmp,
    replayedText: replayedText.slice(0, 4000),
  };
}

function pct(x, n) { return n ? Math.round((x / n) * 1000) / 1000 : null; }
function percentile(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null; }

function summarize(scores) {
  const n = scores.length;
  const drafted = scores.filter((s) => s.drafted);
  const pos = scores.filter((s) => s.klass === 'positive');
  const noop = scores.filter((s) => s.klass === 'noop');
  const walls = scores.map((s) => s.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
  const fieldTotals = {};
  for (const s of drafted) for (const [k, v] of Object.entries(s.compare.fields || {})) {
    fieldTotals[k] = fieldTotals[k] || { agree: 0, n: 0 };
    fieldTotals[k].n += 1; if (v === true) fieldTotals[k].agree += 1;
  }
  const failures = {};
  for (const s of scores) if (!s.drafted) failures[s.failure] = (failures[s.failure] || 0) + 1;
  // A source whose comparer scores concrete fields (brain_dump_sort: every output is a JSON classification, never "nothing to flag") has no meaningful
  // verdict-shape metrics: recall / false positives would read 1.0 / 1.0 for a perfect replay. Those apply to review-style sources only.
  const fieldScored = drafted.length > 0 && drafted.every((s) => Object.keys(s.compare.fields || {}).length > 0);
  const recallHits = pos.filter((s) => s.drafted && !s.compare.replayedNullish).length;
  const fpHits = noop.filter((s) => s.drafted && !s.compare.replayedNullish).length;
  return {
    n,
    gatePass: drafted.length,
    gatePassRate: pct(drafted.length, n),
    gatePassLower: Math.round(wilsonLower(drafted.length, n) * 1000) / 1000,
    positives: pos.length,
    recallOnPositives: fieldScored ? null : pct(recallHits, pos.length),
    noops: noop.length,
    falsePositiveRateOnNoops: fieldScored ? null : pct(fpHits, noop.length),
    verdictShapeAgreement: fieldScored ? null : pct(drafted.filter((s) => s.compare.sameVerdictShape).length, drafted.length),
    fieldScored,
    meanSimilarity: drafted.length ? Math.round((drafted.reduce((a, s) => a + s.compare.similarity, 0) / drafted.length) * 100) / 100 : null,
    fieldAgreement: Object.fromEntries(Object.entries(fieldTotals).map(([k, v]) => [k, { agree: v.agree, n: v.n, rate: pct(v.agree, v.n) }])),
    failures,
    p50Ms: percentile(walls, 0.5),
    p95Ms: percentile(walls, 0.95),
  };
}

/**
 * runReplay({ corpus, laneId, model, timeoutMs, dryRun, onProgress, resetHarness }) -> { source, lane, startedAt, scores, summary }
 * Sequential on purpose (one GPU lane). `dryRun` defaults to dryRunDraft; tests inject a stub.
 */
async function runReplay({ corpus, laneId, model, timeoutMs, dryRun = dryRunDraft, onProgress, resetHarness = false, lanes } = {}) {
  const scores = [];
  let lane = null;
  for (const entry of corpus.entries) {
    let dry;
    try {
      dry = await dryRun(entry.task, { laneId, model, timeoutMs, resetHarness, lanes });
    } catch (e) {
      dry = { ok: false, result: { succeeded: false, reason: String(e.message) }, task: null, durationMs: 0 };
    }
    lane = lane || dry.lane || null;
    const s = scoreReplay(entry, dry);
    scores.push(s);
    if (typeof onProgress === 'function') onProgress(s, scores.length, corpus.entries.length);
  }
  return { source: corpus.source, lane: lane || { id: laneId || null, model: model || null }, startedAt: new Date().toISOString(), corpusCounts: corpus.counts, scores, summary: summarize(scores) };
}

// ---- promotion gate (design note: "Promotion gate") ------------------------------------------------------------------------------------------

/**
 * evaluatePromotion({ candidate, baseline, minN, margin, humanSample }) -> { promote, reasons }
 * candidate / baseline: replay summaries (or objects with the same fields). baseline = the parent source's own replay on the larger lane. Absent baseline
 * falls back to absolute floors (gate pass lower bound 0.80, recall 0.80). humanSample: { reviewed, passed } -- a person must have read a sample.
 */
function evaluatePromotion({ candidate, baseline = null, minN = DEFAULT_MIN_N, margin = DEFAULT_MARGIN, humanSample = null, minHuman = DEFAULT_HUMAN_SAMPLE } = {}) {
  const reasons = [];
  if (!candidate) return { promote: false, reasons: ['no candidate summary'] };
  if (candidate.n < minN) reasons.push(`insufficient corpus: ${candidate.n} replays, need ${minN}`);
  const passFloor = baseline ? baseline.gatePassLower - margin : 0.80;
  if (candidate.gatePassLower < passFloor) reasons.push(`gate pass lower bound ${candidate.gatePassLower} < ${Math.round(passFloor * 1000) / 1000}`);
  const recallFloor = baseline && baseline.recallOnPositives != null ? baseline.recallOnPositives - margin : 0.80;
  if (candidate.fieldScored) {
    // Field-scored sources: the gate is per-field agreement with the record instead of recall.
    const worst = Object.entries(candidate.fieldAgreement || {}).filter(([, v]) => v.n > 0).sort((a, b) => a[1].rate - b[1].rate)[0];
    if (!worst) reasons.push('no field agreement data');
    else if (worst[1].rate < 0.85) reasons.push(`field "${worst[0]}" agrees only ${worst[1].rate} (< 0.85)`);
  } else if (candidate.positives > 0 && (candidate.recallOnPositives == null || candidate.recallOnPositives < recallFloor)) reasons.push(`recall on positives ${candidate.recallOnPositives} < ${Math.round(recallFloor * 1000) / 1000}`);
  else if (candidate.positives === 0) reasons.push('no positive examples in the corpus: recall cannot be judged');
  if (baseline && baseline.falsePositiveRateOnNoops != null && candidate.falsePositiveRateOnNoops != null && candidate.falsePositiveRateOnNoops > baseline.falsePositiveRateOnNoops + margin) reasons.push(`false-positive rate on noops ${candidate.falsePositiveRateOnNoops} > baseline ${baseline.falsePositiveRateOnNoops} + ${margin}`);
  const newFailures = Object.keys(candidate.failures || {}).filter((k) => !baseline || !(baseline.failures || {})[k]);
  if (baseline && newFailures.length) reasons.push(`failure classes the baseline does not have: ${newFailures.join(', ')}`);
  if (!humanSample || humanSample.reviewed < minHuman) reasons.push(`human sample not done: ${humanSample ? humanSample.reviewed : 0} reviewed, need ${minHuman}`);
  else if (humanSample.passed / humanSample.reviewed < 0.9) reasons.push(`human sample pass ratio ${humanSample.passed}/${humanSample.reviewed} < 0.9`);
  return { promote: reasons.length === 0, reasons };
}

// ---- reports ------------------------------------------------------------------------------------------------------------------------------------

function reportDir(pipelineDir) { return path.join(pipelineDir, 'replay-reports'); }

function writeReport(pipelineDir, report) {
  const dir = reportDir(pipelineDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const base = path.join(dir, `${report.source}-${(report.lane && report.lane.id) || 'lane'}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${base}.md`, renderMarkdown(report));
  return `${base}.json`;
}

function renderMarkdown(report) {
  const s = report.summary;
  const lines = [
    `# Replay: ${report.source} on ${report.lane && report.lane.id} (${report.lane && report.lane.model}, tier ${report.lane && report.lane.tier})`,
    '',
    `${report.startedAt} -- ${s.n} replays (${s.positives} recorded positives, ${s.noops} noops). Corpus pool: ${JSON.stringify(report.corpusCounts)}.`,
    '',
    `- gate pass: **${s.gatePass}/${s.n}** (${s.gatePassRate}, lower bound ${s.gatePassLower})`,
    ...(s.fieldScored
      ? ['- field-scored source: recall / false-positive metrics do not apply; see the per-field agreement below']
      : [`- recall on recorded positives: **${s.recallOnPositives}**; false-positive rate on recorded noops: **${s.falsePositiveRateOnNoops}**`, `- verdict-shape agreement ${s.verdictShapeAgreement}`]),
    `- mean text similarity ${s.meanSimilarity}`,
    `- time p50 ${s.p50Ms == null ? '-' : Math.round(s.p50Ms / 1000)}s, p95 ${s.p95Ms == null ? '-' : Math.round(s.p95Ms / 1000)}s`,
    `- failures: ${JSON.stringify(s.failures)}`,
  ];
  if (Object.keys(s.fieldAgreement).length) {
    lines.push('', '| field | agree | rate |', '|---|---|---|');
    for (const [k, v] of Object.entries(s.fieldAgreement)) lines.push(`| ${k} | ${v.agree}/${v.n} | ${v.rate} |`);
  }
  lines.push('', '## Worth reading', '', 'Failures and disagreements on recorded positives:');
  for (const sc of report.scores.filter((x) => !x.drafted || (x.klass === 'positive' && x.compare.replayedNullish)).slice(0, 15)) {
    lines.push(`- \`${sc.id}\` (${sc.klass}): ${sc.drafted ? 'replay said nothing to flag' : `${sc.failure}: ${sc.reason}`}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  classifyRecorded, buildCorpus, compareOutputs, isNullish, scoreReplay, summarize, runReplay, evaluatePromotion, writeReport, renderMarkdown, POSITIVE,
};

// CLI:
//   node src/replay-lab.js corpus <source> [--limit N]                    -- print the corpus selection
//   node src/replay-lab.js run <source> --lane <id> [--limit N] [--model tag] [--timeout-min N]   -- replay and write a report
//   node src/replay-lab.js gate <candidate-report.json> [<baseline-report.json>] [--human-reviewed N --human-passed N]
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? null : args[i + 1]; };
  const [cmd, arg1, arg2] = args;
  const pipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
  (async () => {
    if (cmd === 'gate') {
      const cand = JSON.parse(fs.readFileSync(arg1, 'utf8')).summary;
      const base = arg2 && !arg2.startsWith('--') ? JSON.parse(fs.readFileSync(arg2, 'utf8')).summary : null;
      const human = get('human-reviewed') ? { reviewed: Number(get('human-reviewed')), passed: Number(get('human-passed') || 0) } : null;
      console.log(JSON.stringify(evaluatePromotion({ candidate: cand, baseline: base, humanSample: human }), null, 2));
      return;
    }
    require('./task-sources.js'); // registers sources (and the plugin)
    const corpus = buildCorpus({ pipelineDir, source: arg1, limit: Number(get('limit')) || 60 });
    if (cmd === 'corpus') {
      console.log(JSON.stringify({ counts: corpus.counts, ids: corpus.entries.map((e) => `${e.klass}:${e.id}`) }, null, 2));
      return;
    }
    if (cmd === 'run') {
      const report = await runReplay({
        corpus, laneId: get('lane'), model: get('model'), timeoutMs: (Number(get('timeout-min')) || 15) * 60000,
        onProgress: (s, i, n) => console.error(`[${i}/${n}] ${s.id.slice(-40)} ${s.klass} ${s.drafted ? (s.compare.replayedNullish ? 'nullish' : 'finding') : `FAILED ${s.failure}`} ${Math.round((s.durationMs || 0) / 1000)}s`),
      });
      console.log(writeReport(pipelineDir, report));
      console.log(renderMarkdown(report));
      return;
    }
    console.error('usage: node src/replay-lab.js corpus|run <source> [--lane id] [--limit N] [--model tag] | gate <candidate.json> [baseline.json]');
    process.exit(2);
  })().catch((e) => { console.error(e); process.exit(1); });
}
