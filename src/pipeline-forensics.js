'use strict';

// Detector half of `pipeline_forensics` -- the deep, report-producing sibling of
// pipeline_self_audit (2026-09-01, Grimmethy: "We've done a forensic study multiple times
// that has produced good results. Can we break this down into a formal task agent-manager
// can reproduce?"). Where pipeline_self_audit clusters queue/blocked/ by a coarse
// blockedReason keyword and asks for a one-pass fix diff, this one:
//   - clusters queue/needs-clarification/ (nothing else does -- these are tasks that
//     already exhausted the fast retry path and a human bounced them),
//   - flags a whole task SOURCE that is burning cost with little shipped value (this
//     supersedes the never-built pipeline_value_audit),
//   - or takes an on-demand "study X" request,
// then hands forensic-bundle.js's evidence blob (incl. a contrast set of tasks that
// SUCCEEDED) to a local reasoning pass that produces a RANKED root-cause report. The
// report is held at awaiting-confirm for a human before it files a pipeline-fix candidate.
//
// Config-free like pipeline-self-audit.js's pure functions; nextPipelineForensicsTask()
// (the one function that touches getConfig()) lives in task-sources.js.

const {
  hasZeroHitHarnessSearch, categorizeBlockedReason, signatureForTask,
} = require('./pipeline-self-audit.js');

// A needs-clarification cluster is small (a handful of tasks that each already burned the
// full retry budget), so the "confident it's systemic" bar is lower than
// pipeline_self_audit's CLUSTER_THRESHOLD of 5. The user's own framing is that *nothing*
// groups these today.
const CLARIFICATION_CLUSTER_THRESHOLD = 3;

// Low-value-source trigger.
const VALUE_WINDOW_DAYS = 7;
const VALUE_MIN_TASKS = 5;
const VALUE_COST_FLOOR_USD = 3;         // hypothetical (API-equivalent) cost in the window
const VALUE_BENEFIT_RATIO_MAX = 0.15;   // benefit-classified done tasks / terminal tasks
const VALUE_SHIPPED_MAX = 1;            // tasks with a real mergedAt
const VALUE_COOLDOWN_DAYS = 21;         // a source flagged once is re-eligible after this

// needs-clarification tasks mostly carry a generic blockedReason ("...after 3 attempts"),
// so signatureForTask() alone returns null for nearly all of them (confirmed live). Widen
// the signal: the zero-hit-harness history marker, then the same keyword buckets applied to
// needsClarification.reason AND the detail of the terminal exhausted/needs-clarification
// history entry, then the botched-decompose / turn-budget markers this pipeline stamps.
function signatureForClarificationTask(task) {
  const source = task.source || 'unknown';
  if (hasZeroHitHarnessSearch(task)) return `${source}::harness-search-zero-results`;

  const nc = task.needsClarification || {};
  const hist = Array.isArray(task.history) ? task.history : [];
  const terminal = [...hist].reverse().find((h) => h.stage === 'needs-clarification' || h.stage === 'exhausted');
  const haystacks = [
    task.blockedReason,
    nc.reason && nc.reason !== 'design-decision' ? nc.reason : null,
    nc.openQuestions,
    terminal && terminal.detail,
  ].filter(Boolean);

  for (const text of haystacks) {
    const cat = categorizeBlockedReason(text);
    if (cat) return `${source}::${cat}`;
  }
  const joined = haystacks.join(' ').toLowerCase();
  if (/decompose/.test(joined) && /(malformed|did not follow|json)/.test(joined)) return `${source}::botched-decompose`;
  if (/turn budget|made zero edits|without making any edits|out of turns/.test(joined)) return `${source}::turn-budget-exhausted`;
  if (task.turnBudgetExhausted === true) return `${source}::turn-budget-exhausted`;
  if (task.retryableDraftBlock === true) return `${source}::retryable-draft-block`;

  // A genuinely unique clarification is a human's judgment call, not a pattern -- skip it,
  // same discipline as signatureForTask().
  return null;
}

// coverage: { [key]: { reportedAt, taskId, triggerType, eligibleAgainAt? } }
// A signature key is reported once forever (systemic). A `value::<source>` key carries an
// eligibleAgainAt and becomes re-eligible after the cooldown.
function coverageEntryActive(entry, now) {
  if (!entry) return false;
  if (entry.eligibleAgainAt && new Date(entry.eligibleAgainAt).getTime() <= now) return false;
  return true;
}

// Group needs-clarification records by signature; return clusters at/above threshold that
// aren't already covered, largest first. records: [{ task }].
function findClarificationClusters(records, coverage = {}, now = Date.now(), sigFn = signatureForClarificationTask) {
  const bySig = new Map();
  for (const r of records) {
    const sig = sigFn(r.task);
    if (!sig) continue;
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(r.task);
  }
  const clusters = [];
  for (const [signature, tasks] of bySig.entries()) {
    if (tasks.length < CLARIFICATION_CLUSTER_THRESHOLD) continue;
    if (coverageEntryActive(coverage[signature], now)) continue;
    clusters.push({ signature, tasks });
  }
  clusters.sort((a, b) => b.tasks.length - a.tasks.length);
  return clusters;
}

// tasks: scanTaskActivity() output (each { source, classification, queueState, ... }).
// mergedById: Set of task ids that have a real mergedAt (from a parallel done/ scan).
// acctBySource: computeTimeAccounting().hypotheticalCostBySource ([{ source, costUsd }]).
// Returns the worst offender { source, hypCost, benefitRatio, shipped, taskCount } or null.
function findLowValueSource(tasks, mergedIds, acctBySource, coverage = {}, now = Date.now()) {
  const costOf = new Map((acctBySource || []).map((e) => [e.source, e.costUsd]));
  const bySource = new Map();
  for (const t of tasks) {
    const s = t.source || 'unknown';
    if (!bySource.has(s)) bySource.set(s, { total: 0, benefit: 0, shipped: 0 });
    const agg = bySource.get(s);
    agg.total += 1;
    if (t.classification === 'benefit' && t.queueState === 'done') agg.benefit += 1;
    if (mergedIds && mergedIds.has(t.id)) agg.shipped += 1;
  }
  const flagged = [];
  for (const [source, agg] of bySource.entries()) {
    if (agg.total < VALUE_MIN_TASKS) continue;
    if (coverageEntryActive(coverage[`value::${source}`], now)) continue;
    const hypCost = costOf.get(source) || 0;
    const benefitRatio = agg.total ? agg.benefit / agg.total : 0;
    if (hypCost >= VALUE_COST_FLOOR_USD && benefitRatio < VALUE_BENEFIT_RATIO_MAX && agg.shipped <= VALUE_SHIPPED_MAX) {
      flagged.push({ source, hypCost, benefitRatio, shipped: agg.shipped, taskCount: agg.total });
    }
  }
  flagged.sort((a, b) => b.hypCost - a.hypCost);
  return flagged[0] || null;
}

module.exports = {
  CLARIFICATION_CLUSTER_THRESHOLD,
  VALUE_WINDOW_DAYS, VALUE_MIN_TASKS, VALUE_COST_FLOOR_USD, VALUE_BENEFIT_RATIO_MAX,
  VALUE_SHIPPED_MAX, VALUE_COOLDOWN_DAYS,
  signatureForClarificationTask,
  coverageEntryActive,
  findClarificationClusters,
  findLowValueSource,
};
