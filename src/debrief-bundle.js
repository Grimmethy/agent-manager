'use strict';

// Deterministic evidence-bundle assembler for `pipeline_debrief` (2026-09-06, Grimmethy:
// "A whole phase where we go through actually completed work to analyze for patterns that
// can make it more efficient in the future. During debriefing, you explore three things:
// what happened (the What), why it happened (the So What) and what should happen in the
// future (the Now What)." -- see the "The Debrief" concept's research, which recommended
// this as Design option A: mirror pipeline_forensics.js/forensic-bundle.js's exact shape
// (a deterministic scan builds an evidence blob, a local reasoning pass writes the report),
// but scoped to a WINDOW of queue/done/ tasks that SHIPPED instead of a cluster of tasks
// that FAILED.
//
// The research also flagged the central risk directly: analysing only what worked, with no
// matched contrast to what did NOT, risks learning the wrong lesson (survivorship bias) --
// exactly the failure pipeline_forensics.js's own "winner" contrast set already avoids for
// the opposite case. This bundle mirrors that discipline in reverse: the window of
// COMPLETED tasks is the subject, and a small contrast set of tasks from the SAME sources
// that are still stuck in blocked/needs-clarification is included so the report can ask
// "is this pattern actually why the window tasks succeeded, or did the stuck ones just get
// unlucky in the same way?" instead of only ever admiring successes.
//
// Rendering is reused verbatim from forensic-bundle.js (gatherEvidenceForTask,
// readModelCallsForTasks, assembleText) rather than re-implemented -- same per-task shape
// (history, draftAttempts, worklog tail, model_calls), just applied to a different subject
// selection. Pure + config-free like forensic-bundle.js itself: the caller (task-sources.js's
// nextPipelineDebriefTask) passes pipelineDir + dbPath + the cursor timestamp.

const fs = require('fs');
const path = require('path');
const {
  gatherEvidenceForTask, readModelCallsForTasks, readStateDir, terminalTs,
} = require('./forensic-bundle.js');
const { readWorkLog } = require('./work-log.js');

const DEFAULT_BUDGET_CHARS = 28000;
// A debrief over 3-4 done tasks is just re-litigating one task's own history -- not a
// pattern. This floor matches pipeline_forensics's own CLARIFICATION_CLUSTER_THRESHOLD-style
// "confident it's systemic" reasoning, sized a bit larger since done/ accumulates faster
// than needs-clarification/ does.
const MIN_WINDOW_TASKS = 12;
// Caps the evidence blob (and the archive-on-confirm blast radius) to one bounded batch --
// the same reasoning as forensic-bundle.js's MAX_SUBJECTS/MAX_WINNERS: more tasks would just
// get dropped for budget anyway, and a smaller, well-evidenced batch produces a more
// specific, more actionable report than a sprawling one (the research's own finding: fewer,
// specific Now-What items complete at a far higher rate than a kitchen-sink list).
const MAX_WINDOW_TASKS = 25;
const MAX_CONTRAST_TASKS = 4;

// The done/ window: real, top-level queue/done/*.json tasks (readStateDir never descends
// into _archived/_archived_no_action -- same non-recursive readdirSync guarantee
// done-archive.js's own scan relies on) whose terminal timestamp is after `sinceIso`,
// oldest first (a debrief reads chronologically, like an AAR walking through what
// happened), capped at MAX_WINDOW_TASKS.
function collectDoneWindow(pipelineDir, sinceIso, maxWindow = MAX_WINDOW_TASKS) {
  const doneTasks = readStateDir(pipelineDir, 'done');
  const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
  const withTs = doneTasks
    .map((task) => ({ task, ts: Date.parse(terminalTs(task) || 0) }))
    .filter((r) => Number.isFinite(r.ts) && r.ts > (Number.isFinite(sinceMs) ? sinceMs : 0));
  withTs.sort((a, b) => a.ts - b.ts);
  return withTs.slice(0, maxWindow).map((r) => r.task);
}

// Contrast set: tasks from the SAME sources as the window that are still stuck (blocked /
// needs-clarification) as of `now` -- the survivorship-bias check. Newest first (the most
// recently-stuck sibling is the sharpest "did this pattern actually help, or just this
// batch" contrast).
function collectContrastTasks(pipelineDir, windowTasks, maxContrast = MAX_CONTRAST_TASKS) {
  if (!windowTasks.length) return [];
  const sources = new Set(windowTasks.map((t) => t.source).filter(Boolean));
  const pool = [
    ...readStateDir(pipelineDir, 'blocked').map((task) => ({ task, state: 'blocked' })),
    ...readStateDir(pipelineDir, 'needs-clarification').map((task) => ({ task, state: 'needs-clarification' })),
  ];
  const matched = pool.filter((r) => sources.has(r.task.source));
  matched.sort((a, b) => String(terminalTs(b.task)).localeCompare(String(terminalTs(a.task))));
  return matched.slice(0, maxContrast);
}

function renderFraming(windowTasks, contrastRecords, windowStart, windowEnd) {
  const sourceCounts = new Map();
  for (const t of windowTasks) sourceCounts.set(t.source || 'unknown', (sourceCounts.get(t.source || 'unknown') || 0) + 1);
  const sourceLine = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}=${n}`).join(', ');
  return [
    `PIPELINE DEBRIEF — window ${windowStart} .. ${windowEnd} (${windowTasks.length} completed task(s): ${sourceLine})`,
    '',
    'Method -- What / So What / Now What, applied to work that actually SHIPPED:',
    '  WHAT:     a factual account of this batch -- what got built, which sources it came',
    '            from, roughly how it went (fast/clean vs. costly/many attempts).',
    '  SO WHAT:  WHY it went that way -- a real pattern in the evidence below (a plan/',
    '            implement shape that correlated with a fast first-pass ACCEPT, a source',
    '            that is consistently cheap or consistently expensive, a step that kept',
    '            costing turns/tokens without changing the outcome).',
    '  NOW WHAT: what should change going forward -- concrete, and BOUNDED. Prior research',
    '            on retrospectives found that 70-80% of action items from a typical review',
    '            never get implemented, and that FEWER, more specific, time-bound items',
    '            complete at a much higher rate than an exhaustive list. Recommend at most',
    '            2-3 concrete changes, each naming a real src/ file or config this pipeline',
    '            already has -- not a wish list.',
    '',
    'SURVIVORSHIP-BIAS CHECK (mandatory, do not skip): a pattern found ONLY by reading',
    'successes risks being a coincidence, not a cause. The CONTRAST TASKS below are still-',
    'stuck tasks from the SAME sources as this window. For each pattern you propose in SO',
    'WHAT, check it against the contrast tasks: did the stuck ones lack the very thing you',
    'are crediting for the win? If a contrast task ALSO has the pattern you are crediting,',
    'say so plainly -- the pattern is not the real cause, and the report should say what IS',
    'more likely, or that no confident cause was found. "No confident pattern found here" is',
    'a valid, correct outcome, exactly like pipeline_forensics\' "NO CLEAR ROOT CAUSE".',
    contrastRecords.length ? '' : '(No contrast tasks were found from these sources -- treat any SO WHAT claim with extra caution; there is nothing here to rule out coincidence.)',
  ].filter((l) => l !== undefined).join('\n');
}

function buildDebriefBundle({
  pipelineDir, dbPath, sinceIso, now = Date.now(), maxWindow = MAX_WINDOW_TASKS,
  maxContrast = MAX_CONTRAST_TASKS, budgetChars = DEFAULT_BUDGET_CHARS,
} = {}) {
  const windowTasks = collectDoneWindow(pipelineDir, sinceIso, maxWindow);
  if (windowTasks.length < MIN_WINDOW_TASKS) {
    return { evidenceText: null, taskIds: [], contrastIds: [], windowStart: null, windowEnd: null, stats: { windowCount: windowTasks.length } };
  }

  const contrastRecords = collectContrastTasks(pipelineDir, windowTasks, maxContrast);
  const windowStart = terminalTs(windowTasks[0]);
  const windowEnd = terminalTs(windowTasks[windowTasks.length - 1]);

  const taskIds = windowTasks.map((t) => t.id);
  const contrastIds = contrastRecords.map((r) => r.task.id);
  const allIds = [...taskIds, ...contrastIds];
  const callsById = readModelCallsForTasks(dbPath, allIds);
  const worklogById = new Map();
  for (const id of allIds) {
    const wl = readWorkLog(id, pipelineDir);
    if (wl) worklogById.set(id, wl);
  }

  const sections = [
    { text: renderFraming(windowTasks, contrastRecords, windowStart, windowEnd) },
  ];
  windowTasks.forEach((task, i) => {
    sections.push({
      text: gatherEvidenceForTask({ task, state: 'done' }, worklogById.get(task.id), callsById.get(task.id), { label: `COMPLETED ${i + 1}` }),
      dropTag: i < 2 ? 'keep' : 'oldCompleted',
    });
  });
  contrastRecords.forEach((rec, i) => {
    sections.push({
      text: gatherEvidenceForTask(rec, worklogById.get(rec.task.id), callsById.get(rec.task.id), { label: `CONTRAST ${i + 1} (STILL STUCK, same source)` }),
      dropTag: i === 0 ? 'contrastFirst' : 'contrastRest',
    });
  });

  const { assembleText } = require('./forensic-bundle.js');
  const { text, dropped } = assembleText(sections, budgetChars);

  return {
    evidenceText: text,
    taskIds,
    contrastIds,
    windowStart,
    windowEnd,
    stats: {
      windowCount: windowTasks.length,
      contrastCount: contrastRecords.length,
      callRows: [...callsById.values()].reduce((n, rows) => n + rows.length, 0),
      worklogs: worklogById.size,
      droppedForBudget: dropped,
      chars: text.length,
    },
  };
}

module.exports = {
  MIN_WINDOW_TASKS,
  MAX_WINDOW_TASKS,
  MAX_CONTRAST_TASKS,
  DEFAULT_BUDGET_CHARS,
  collectDoneWindow,
  collectContrastTasks,
  buildDebriefBundle,
};

// CLI (read-only): node src/debrief-bundle.js [--since <ISO>]
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? null : args[i + 1]; };
  const { getConfig } = require('./config.js');
  const cfg = getConfig();
  const dbPath = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH || path.join(cfg.pipelineDir, 'model-stats.db');
  const bundle = buildDebriefBundle({ pipelineDir: cfg.pipelineDir, dbPath, sinceIso: get('since') });
  if (!bundle.evidenceText) {
    console.log(JSON.stringify({ ready: false, stats: bundle.stats }, null, 2));
  } else {
    process.stdout.write(`${bundle.evidenceText}\n\n---\n${JSON.stringify({ taskIds: bundle.taskIds, contrastIds: bundle.contrastIds, stats: bundle.stats }, null, 2)}\n`);
  }
}
