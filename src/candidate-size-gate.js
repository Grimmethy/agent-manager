'use strict';
// Write-time size gate for triage candidates (ADR-0023 slice S1, brain-dump #1741).
//
// nextCandidateFulfillmentTask (sdk/lib/candidate-lifecycle.js) silently skips any candidate whose authored text exceeds
// MAX_ARCH_REVIEW_TASK_CHARS, so an oversize write-up that reaches the rolling triage branch can never become a task and a human only
// finds out after merging it (19 of 72 function-length candidates on master). This gate measures a draft the way fulfillment will, BEFORE
// it is appended, and hands the measured size back so the normal reject-retry loop can redraft it shorter.
//
// Pure and source-agnostic: it applies to any registered directToMain source whose response parses as candidate blocks, so a code diff or
// a non-triage source is never touched. Kill switch: AGENT_MANAGER_CANDIDATE_SIZE_GATE=false.
const { parseArchDiscoveryCandidates, renderCandidateSection } = require('./candidate-docs.js');
const { MAX_ARCH_REVIEW_TASK_CHARS, candidateGuardSize } = require('./sdk/lib/candidate-lifecycle.js');

// Headroom under the hard limit: the real id is assigned at apply time and is shorter or equal to the 4-digit placeholder, but a redraft
// that lands exactly on the limit would otherwise flip on one character of normalization.
const CANDIDATE_SIZE_MARGIN = 100;
const MAX_LISTED = 3;

// The reason deliberately avoids the words blocked-task-classifiers.js keys on (ungrounded, fabricat, truncat, empty, degenerate...):
// a size violation is deterministic and must not be bucketed as a stochastic gate flake.
function checkCandidateSize(task, implementResponse, { entry } = {}) {
  if (process.env.AGENT_MANAGER_CANDIDATE_SIZE_GATE === 'false') return { verdict: 'ok' };
  if (!entry || entry.directToMain !== true) return { verdict: 'ok' };
  const candidates = parseArchDiscoveryCandidates(implementResponse);
  if (!candidates || candidates.length === 0) return { verdict: 'ok' };

  const limit = MAX_ARCH_REVIEW_TASK_CHARS - CANDIDATE_SIZE_MARGIN;
  // Placeholder id and no Snippet: the harness adds the Snippet at apply time and candidateGuardSize excludes it anyway.
  const sizes = candidates.map((c) => ({
    title: String(c.title || '').slice(0, 60),
    size: candidateGuardSize(renderCandidateSection(c, 'AC-9999', { snippet: null, dependsOnId: null })),
  }));
  const over = sizes.filter((s) => s.size > limit);
  if (over.length === 0) return { verdict: 'ok', sizes };

  const listed = over.slice(0, MAX_LISTED).map((s) => `"${s.title}" is ${s.size} chars`).join('; ');
  const more = over.length > MAX_LISTED ? ` (+${over.length - MAX_LISTED} more)` : '';
  const reason = `${listed}${more}; the limit is ${limit} (hard limit ${MAX_ARCH_REVIEW_TASK_CHARS}) and a longer candidate is never turned into a task. Keep one narrow change and shorten Problem/Solution/Benefits.`;
  return { verdict: 'oversized', reason, sizes };
}

module.exports = { checkCandidateSize, CANDIDATE_SIZE_MARGIN };
