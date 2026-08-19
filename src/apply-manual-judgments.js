'use strict';

// Backfills a judge grade onto already-saved benchmark responses when the automated judge
// (claude-client.js, gated on the Claude subscription's own weekly limit -- see
// reasoning-bench.js's gradeJudge()) couldn't run at benchmark time. 2026-08-19,
// Grimmethy: "Can you perform the judgments yourself and log them into the system?" -- the
// interactive assistant conversing with the user is a SEPARATE quota from the pipeline's
// own `claude -p` subprocess calls, so it can grade a response against the exact same
// rubric (reasoning-bench-cases.js's own `expected` text) by hand and log the result the
// same way the automated path would have, rather than leaving those responses permanently
// ungraded.
//
// Patches THREE places per judgment, matching exactly what a real judge call would have
// written at benchmark time:
//   1. The individual response .json (grade field + a new history entry) -- what the
//      dashboard's task-detail modal reads.
//   2. The individual response .md (grade line in the header) -- the human-readable note.
//   3. That run's _summary.json: the matching results[] entry's grade, AND the whole
//      `summary` block recomputed via summarize() (the same function reasoning-bench.js's
//      own CLI run uses) so aggregate figures (avgJudgeScore, objectivePassRate, etc.) and
//      the Models tab's per-case best/worst stats (app.py's _compute_case_stats, which
//      reads straight off these results[] entries) stay consistent -- not just the one
//      response looking graded while the run-level rollup still shows it ungraded.
//
// CLI: node apply-manual-judgments.js <judgments.json>
// judgments.json: array of { runId, model, caseId, runIndex, score, reason }
//   score: 0.0-1.0, same scale/pass threshold (>=0.6) gradeJudge() already uses.

const fs = require('fs');
const path = require('path');
const { summarize, slugify } = require('./reasoning-bench.js');
const { CASES } = require('./reasoning-bench-cases.js');

function benchDir(secondBrainDir, runId) {
  return path.join(secondBrainDir, 'Model Benchmarks', runId);
}

function responseId(model, caseId, runIndex) {
  return `${slugify(model)}__${caseId}__run${runIndex}`;
}

function patchResponseFile(dir, id, score, reason, judgedBy) {
  const jsonPath = path.join(dir, `${id}.json`);
  const task = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const pass = score >= 0.6;
  task.grade = { pass, score, reason };
  task.blockedReason = pass ? null : reason;
  const now = new Date().toISOString();
  // Replace the placeholder "judge unavailable" grade-stage entry (added at benchmark
  // time) rather than stacking a duplicate -- there is exactly one real grade per
  // response, this just arrived later than usual.
  task.history = (task.history || []).filter((h) => h.stage !== 'grade');
  task.history.push({ stage: 'grade', at: now, detail: `${pass ? 'PASS' : 'FAIL'} -- ${reason}` });
  task.history.push({ stage: 'grade-source', at: now, detail: `Manually judged by ${judgedBy} (Claude subscription weekly limit blocked the automated judge call at benchmark time).` });
  fs.writeFileSync(jsonPath, JSON.stringify(task, null, 2));

  const mdPath = path.join(dir, `${id}.md`);
  if (fs.existsSync(mdPath)) {
    let md = fs.readFileSync(mdPath, 'utf8');
    md = md.replace(/\*\*Result:\*\* .+/, `**Result:** ${pass ? 'PASS' : 'FAIL'} -- ${reason} (manually judged by ${judgedBy})`);
    fs.writeFileSync(mdPath, md);
  }
  return task;
}

function applyJudgments(secondBrainDir, judgments, judgedBy = 'Claude (interactive session)') {
  const byRun = {};
  for (const j of judgments) (byRun[j.runId] = byRun[j.runId] || []).push(j);

  const patchedRunIds = [];
  for (const [runId, entries] of Object.entries(byRun)) {
    const dir = benchDir(secondBrainDir, runId);
    const summaryPath = path.join(dir, '_summary.json');
    const summaryDoc = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

    for (const j of entries) {
      const id = responseId(j.model, j.caseId, j.runIndex);
      patchResponseFile(dir, id, j.score, j.reason, judgedBy);

      const resultRow = summaryDoc.results.find((r) => r.model === j.model && r.caseId === j.caseId && r.runIndex === j.runIndex);
      if (!resultRow) throw new Error(`no matching results[] entry for ${runId} ${id}`);
      resultRow.grade = { pass: j.score >= 0.6, score: j.score, reason: j.reason };
    }

    const cases = CASES.filter((c) => summaryDoc.caseIds.includes(c.id));
    summaryDoc.summary = summarize(summaryDoc.results, summaryDoc.models, cases, summaryDoc.modelTimings || {});
    fs.writeFileSync(summaryPath, JSON.stringify(summaryDoc, null, 2));
    patchedRunIds.push(runId);
  }
  return patchedRunIds;
}

module.exports = { applyJudgments, responseId };

if (require.main === module) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('usage: node apply-manual-judgments.js <judgments.json>');
    process.exit(1);
  }
  const secondBrainDir = process.env.SECOND_BRAIN_DIR;
  if (!secondBrainDir) {
    console.error('SECOND_BRAIN_DIR must be set.');
    process.exit(1);
  }
  const judgments = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const runIds = applyJudgments(secondBrainDir, judgments);
  console.log(`Patched ${judgments.length} judgment(s) across ${runIds.length} run(s): ${runIds.join(', ')}`);
}
