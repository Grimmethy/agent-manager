'use strict';

// Ghost-debt register (2026-09-09, concept-ghost-in-the-machine-0dbeea). When the pipeline
// concludes "a human must recover this; no automated path exists" -- needs-clarification-
// triage.js exhausts every bucket -> leave-for-human, or reject-retry-check.js escalates a
// task to needs-clarification/ because a blind retry cannot differ or the retry budget is
// spent -- that is a FAILURE CLASS with no deterministic recovery.
//
// fileGhostDebt() records it as a writeSideFindingInbox finding tagged to the concept,
// deduped by FAILURE SIGNATURE (not per task), so the backlog of re-admission mechanisms
// still to build is visible on the concept timeline (getConceptTimeline picks up any
// brain-dump entry whose raisedBy.conceptId matches) instead of being invisible. When
// someone builds the missing recovery -- the shape of needs-clarification-triage.js's
// buckets D/E/F/G, or reject-retry-check.js's forbidden-path re-admission -- that
// signature stops recurring and its state entry ages out.
//
// Best-effort, never throws past the caller -- same contract as writeSideFindingInbox /
// recordRequeueCause. A telemetry write must never break an escalation.

const fs = require('fs');
const path = require('path');
const { writeSideFindingInbox } = require('./side-finding.js');
const { buildSignature, structuredSignalCategory } = require('./requeue-attribution.js');

const GHOST_CONCEPT_ID = 'concept-ghost-in-the-machine-0dbeea';
const REFILE_DAYS = Number(process.env.AGENT_MANAGER_GHOST_DEBT_REFILE_DAYS) || 7;

function statePath(pipelineDir) {
  return path.join(pipelineDir, 'queue', 'ghost-debt-state.json');
}

function readState(pipelineDir) {
  try {
    const v = JSON.parse(fs.readFileSync(statePath(pipelineDir), 'utf8'));
    return (v && typeof v === 'object') ? v : {};
  } catch { return {}; }
}

function writeState(pipelineDir, state) {
  try {
    fs.mkdirSync(path.dirname(statePath(pipelineDir)), { recursive: true });
    fs.writeFileSync(statePath(pipelineDir), JSON.stringify(state, null, 2));
  } catch { /* best-effort -- see header */ }
}

// { task, reasonText, site, pipelineDir, now? } -> { filed, signature?, deduped? }.
// `task` needs an .id; `reasonText` is the failure reason (blockedReason / nc.openQuestions
// / a joined array); `site` names the escalation branch that filed it.
function fileGhostDebt({ task, reasonText, site, pipelineDir, now = Date.now() }) {
  try {
    if (!task || !task.id || !pipelineDir) return { filed: false };
    const category = structuredSignalCategory(task, reasonText || '') || 'unclassified';
    const signature = buildSignature(category, reasonText || '');

    const state = readState(pipelineDir);
    const last = state[signature] && Date.parse(state[signature]);
    if (Number.isFinite(last) && now - last < REFILE_DAYS * 24 * 3600 * 1000) {
      return { filed: false, deduped: 'signature', signature };
    }

    writeSideFindingInbox(
      {
        title: `Ghost debt: "${category}" failure class has no automated recovery`,
        body: [
          'A task reached a human-only escalation with no re-admission bucket or signature matching it.',
          '',
          `Site: ${site}`,
          `Task: ${task.id}`,
          `Reason: ${String(reasonText || '').slice(0, 1200)}`,
          '',
          'A human must requeue this class until a deterministic recovery path exists -- the shape of',
          "needs-clarification-triage.js buckets D/E/F/G, or reject-retry-check.js's forbidden-path",
          `re-admission. Failure signature: ${signature}.`,
        ].join('\n'),
      },
      { source: site, taskId: task.id, stage: 'ghost-debt', pipelineDir, conceptId: GHOST_CONCEPT_ID },
    );

    state[signature] = new Date(now).toISOString();
    writeState(pipelineDir, state);
    return { filed: true, signature };
  } catch {
    return { filed: false };
  }
}

module.exports = { fileGhostDebt, GHOST_CONCEPT_ID, statePath, REFILE_DAYS };
