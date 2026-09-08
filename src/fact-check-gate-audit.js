'use strict';

// Closes the loop review-task.js's fact-check-audit.log (2026-09-08) opened: a persistent
// per-hard-block trail was step one, but a log nobody ever reads back against real
// outcomes is only half of DSPy's own Evaluate pattern (Second Brain [[dspy]] research --
// dspy.Evaluate returns a real, structured EvaluationResult of (example, prediction,
// score) triples, not just a log of what ran). fact-checker.js's own header comment calls
// its ungrounded-url/ungrounded-field gate "high-precision, almost never a false
// positive" -- this session found 4 confirmed false positives against that exact claim,
// discovered only by manually grepping every historical hard-block and hand-auditing
// each one against its real eventual outcome. This sweep automates exactly that join:
// for each hard-block this gate has ever logged, look up what ACTUALLY happened to that
// task afterward (findTaskAnywhere -- covers every live queue state, adhoc/, and both
// archive tiers) and bucket it, so the gate's own real precision is a number you can read,
// not something you re-derive by hand each time a new incident makes you suspicious.
//
// This does not correct anything automatically -- classification here is presumptive,
// not authoritative (a task that stayed blocked might be a correct catch OR a human just
// hasn't gotten to it yet; see CLASSIFICATION comment below). It is a reporting tool for
// a human to periodically run, same spirit as `npm run task-log-reconcile -- --report`.
//
// CLI: node fact-check-gate-audit.js [--report]
//   (no flags) -- prints the JSON summary to stdout
//   --report   -- prints a human-readable breakdown to stderr, JSON summary to stdout

const fs = require('fs');
const path = require('path');
const { findTaskAnywhere } = require('./task-anywhere.js');

function readAuditLines(pipelineDir) {
  const p = path.join(pipelineDir, 'instances', 'fact-check-audit.log');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const lines = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { /* skip a malformed line, don't fail the whole sweep */ }
  }
  return lines;
}

// CLASSIFICATION (presumptive, not authoritative -- see header):
//   laterSucceeded -- the task's CURRENT terminalDisposition/status shows real shipped
//     work (merged/applied-direct/pending-merge/approved) despite the hard block that
//     once fired on it. Strong evidence the flag was a false positive (or the exact
//     flagged content was fixed/overridden on a later attempt) -- this is the bucket
//     that would have surfaced this session's 4 confirmed false positives automatically.
//   presumedCorrect -- ended abandoned/dismissed/noop. Consistent with a correct catch,
//     but not PROOF -- a human archiving a task for an unrelated reason looks the same.
//   stillStuck -- still sitting blocked/needs-clarification. Undetermined either way.
//   unknown -- the task record could not be found anywhere findTaskAnywhere looks
//     (archived past its retention window, or the id was malformed).
const SUCCEEDED_DISPOSITIONS = new Set(['merged', 'applied-direct', 'pending-merge', 'approved']);
const PRESUMED_CORRECT_DISPOSITIONS = new Set(['abandoned', 'dismissed', 'noop']);
const STILL_STUCK_STATUSES = new Set(['blocked', 'needs-clarification', 'pending', 'review']);

function classifyOutcome(pipelineDir, taskId) {
  const found = findTaskAnywhere(pipelineDir, taskId);
  if (!found) return 'unknown';
  const disposition = found.data.terminalDisposition || found.data.status;
  if (SUCCEEDED_DISPOSITIONS.has(disposition)) return 'laterSucceeded';
  if (PRESUMED_CORRECT_DISPOSITIONS.has(disposition)) return 'presumedCorrect';
  if (STILL_STUCK_STATUSES.has(disposition)) return 'stillStuck';
  return 'unknown';
}

function blankTally() {
  return { total: 0, laterSucceeded: 0, presumedCorrect: 0, stillStuck: 0, unknown: 0 };
}

// Summarizes by flag TYPE (ungrounded-field vs ungrounded-url) and by SOURCE -- a source
// that's a repeat offender (arch_import_review this session) should stand out on its own,
// not just get averaged into one global number. Each log line is one hard-block EVENT
// (a task can appear more than once across retries); outcome lookup is per-taskId, done
// once and reused across that task's own repeated lines, so re-blocking the same task 3
// times doesn't look 3x more "resolved" than it is once it finally succeeds.
function auditFactCheckPrecision(pipelineDir) {
  const lines = readAuditLines(pipelineDir);
  const outcomeCache = new Map();
  const getOutcome = (taskId) => {
    if (!outcomeCache.has(taskId)) outcomeCache.set(taskId, classifyOutcome(pipelineDir, taskId));
    return outcomeCache.get(taskId);
  };

  const byType = {};
  const bySource = {};
  let totalEvents = 0;

  for (const line of lines) {
    const outcome = getOutcome(line.taskId);
    const flagTypes = new Set((line.flags || []).map((f) => f.type).filter(Boolean));
    if (flagTypes.size === 0) flagTypes.add('(unknown)');
    totalEvents += 1;

    if (!bySource[line.source]) bySource[line.source] = blankTally();
    bySource[line.source].total += 1;
    bySource[line.source][outcome] += 1;

    for (const type of flagTypes) {
      if (!byType[type]) byType[type] = blankTally();
      byType[type].total += 1;
      byType[type][outcome] += 1;
    }
  }

  return { totalEvents, uniqueTasks: outcomeCache.size, byType, bySource };
}

function formatReport(summary) {
  const lines = [];
  lines.push(`[fact-check-gate-audit] ${summary.totalEvents} hard-block event(s) across ${summary.uniqueTasks} unique task(s)`);
  const printTally = (label, tallies) => {
    lines.push(`\n-- by ${label} --`);
    for (const [key, t] of Object.entries(tallies)) {
      const pct = t.total > 0 ? Math.round((100 * t.laterSucceeded) / t.total) : 0;
      lines.push(`  ${key}: ${t.total} total -- laterSucceeded=${t.laterSucceeded} (${pct}%), presumedCorrect=${t.presumedCorrect}, stillStuck=${t.stillStuck}, unknown=${t.unknown}`);
    }
  };
  printTally('flag type', summary.byType);
  printTally('source', summary.bySource);
  return lines.join('\n');
}

module.exports = { auditFactCheckPrecision, classifyOutcome, readAuditLines, formatReport };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const { pipelineDir } = getConfig();
  const summary = auditFactCheckPrecision(pipelineDir);
  if (process.argv.includes('--report')) {
    process.stderr.write(`${formatReport(summary)}\n`);
  }
  process.stdout.write(JSON.stringify(summary));
}
