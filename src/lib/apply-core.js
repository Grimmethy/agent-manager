'use strict';

// apply-core.js -- extracted from src/apply-task.js ([[hub-task-integration]] node-module decompose).

const { getRegisteredSource, resolveSourceName } = require('../task-source-registry.js');
const { getCandidateSplitHubFiler } = require('../candidate-split-hub-route.js');
const { applySecondBrainNote, applyProjectSearchFindings, applyDeepDiveFindings, applyBrainDumpSort, applyPathPrefetchResolve, closeBrainDumpEntryResolved, applyResearchTask, isEffectivelyEmptyResponse, applyArchDiscoveryCandidates } = require('../apply-group-a.js');
const { applyGroupB, batchContainsDeleteMode } = require('../apply-group-b.js');
require('../task-sources.js');

function coAuthorTrailer(task) {
  const draftModel = task.draftModel || '';
  if (draftModel.startsWith('claude:')) {
    return `Co-Authored-By: Claude (${draftModel.slice('claude:'.length)}) <noreply@anthropic.com>`;
  }
  // 2026-08-24 (Grimmethy: "Ornith is no longer the default model... reference local
  // instead") -- this used to hardcode "Ornith" as the local drafting model's identity,
  // which was already stale per this function's own comment above (dashboard-settings.json
  // pins qwen3.8:27b-q4_K_M, not literally "ornith"). Names whichever local model actually
  // drafted it instead of assuming a fixed brand.
  if (draftModel && draftModel !== 'ornith' && draftModel !== 'local') {
    return `Co-Authored-By: Local Model (${draftModel}) <noreply@agent-manager.local>`;
  }
  return 'Co-Authored-By: Local Model <noreply@agent-manager.local>';
}

function usesGroupB(task) {
  const source = getRegisteredSource(resolveSourceName(task));
  return !(source && typeof source.apply === 'function');
}

function applyCandidateSplit(task, source) {
  if (!source || typeof source.candidatesPath !== 'function') {
    throw new Error(`task ${task.id} has candidateSplitProposals but its source ("${resolveSourceName(task)}") has no registered candidatesPath to write them back to`);
  }
  // AC-1, AC-2, ... placeholder numbering -- parseArchDiscoveryCandidates (apply-group-a.js)
  // requires a real digit after "AC-" just to recognize a block boundary at all
  // (`/(?=^#{1,6}\s*AC-\d+)/m`); applyArchDiscoveryCandidates re-derives the REAL id from
  // whatever already exists in the target doc regardless of what's written here (same
  // "the real numbering is assigned when this is written to the doc" convention
  // backlogDecompositionImplementPrompt already tells the model directly), so these only
  // need to be valid enough to parse, never actually correct.
  const markdown = task.candidateSplitProposals.map((c, i) => [
    `### AC-${i + 1} · ${c.title}`,
    'Strength: Strong',
    // Split-Depth: N -- nextCandidateFulfillmentTask refuses to pre-split a candidate at
    // depth >= 1, the hard one-level recursion stop for the deterministic pre-split gate.
    c.splitDepth ? `Split-Depth: ${c.splitDepth}` : '',
    c.files ? `Files: ${c.files}` : '',
    // Placeholder, index-space local to THIS split batch -- candidate-docs.js's
    // applyArchDiscoveryCandidates resolves it to the sibling's REAL AC-NNN id (known
    // only once ids are actually assigned, in the same pass) and rewrites this into a
    // real `Depends-On: AC-NNN` line before the doc is ever saved. See
    // prompts.js's candidateSplitInstructions for the incident this fixes.
    Number.isInteger(c.dependsOn) ? `Depends-On-Index: ${c.dependsOn}` : '',
    '',
    'Problem:', c.problem,
    '',
    'Solution:', c.solution,
    '',
    'Benefits:', c.benefits || '(not specified)',
  ].join('\n')).join('\n\n');
  const result = applyArchDiscoveryCandidates({
    implementResponse: markdown,
    candidatesPath: source.candidatesPath(),
    ...(source.candidateDocTitle ? { docTitle: source.candidateDocTitle } : {}),
  });
  if (result.skipped) {
    // parseArchDiscoveryCandidates found nothing parseable -- parseCandidateSplit already
    // validated title/problem/solution are non-empty strings, so this would mean a
    // markdown-escaping edge case, not a legitimately-empty split.
    throw new Error(`candidate split approved but produced no parseable sub-candidate(s): ${result.reason}`);
  }
  // Same shape applyArchDiscoveryCandidates always returns ({file, candidateCount,
  // candidateIds}) -- identical to what arch_discovery's own registered `apply` hands
  // back for the exact same appender, so the generic "Group A returns {file: '...'}"
  // handling a few lines below this function's own caller already has picks it up with
  // no special-casing needed.
  return result;
}

function writeArtifact(task, repoRoot, pipelineDir) {
  if (Array.isArray(task.candidateSplitProposals) && task.candidateSplitProposals.length > 0) {
    // A split the draft routed to the hub system becomes real, ordered sub-tasks under a
    // coordinator instead of more candidate-doc entries. applyCandidateSplitAsHub itself
    // lives in the agent-manager-hub-tasks plugin (S4b of the hub-tasks extraction,
    // 2026-09-25) -- see candidate-split-hub-route.js for the swap point.
    if (task.candidateSplitRoute === 'hub') {
      const filer = getCandidateSplitHubFiler();
      if (!filer) {
        throw new Error(`task ${task.id}: candidate split routed to a coordinator hub, but no hub-task filer is registered -- load/register the agent-manager-hub-tasks plugin (AGENT_MANAGER_REGISTER_PATH)`);
      }
      return filer.applyCandidateSplitAsHub(task, pipelineDir);
    }
    return applyCandidateSplit(task, getRegisteredSource(resolveSourceName(task)));
  }
  if (!usesGroupB(task)) {
    const source = getRegisteredSource(resolveSourceName(task));
    return source.apply({ implementResponse: task.implementResponse, repoRoot, pipelineDir, task });
  }
  // Confirmed live 2026-08-22: several Group B sources (arch_review, observability_fix,
  // performance_fix, pipeline_self_audit, ...) are explicitly told to output the empty
  // string when there's genuinely nothing to change (see prompts.js's own instructions,
  // and review-task.js's EMPTY_APPROVAL_SOURCES, which already treats this exact case as
  // a legitimate approved outcome at REVIEW time) -- but this apply stage had no matching
  // check of its own, so an approved-empty task reached applyGroupB's JSON.parse
  // unconditionally and threw "Invalid JSON in Group B implementResponse: Unexpected end
  // of JSON input", landing the task in blocked/ instead of a clean, correct skip. Found
  // as a real 6-task cluster in queue/blocked/ this same session -- invisible to
  // pipeline_self_audit's own detector besides, since that error text matches none of its
  // REASON_CATEGORIES keywords. Same {skipped, reason} shape apply-group-a.js's own
  // applyVerdictOnly already uses for "nothing to write, that's a legitimate outcome."
  if (isEffectivelyEmptyResponse(task.implementResponse)) {
    return { skipped: true, reason: 'no code change needed (empty implement response, already approved at review)' };
  }
  // Same failure shape as the empty-response gap above, one layer further out: a Group B
  // source can legitimately answer with a plain-text refusal ("FALSE POSITIVE -- the real
  // file already contains the fix the candidate described") instead of a change. Review
  // can and does approve this prose as a genuinely correct answer -- unlike the
  // empty-string case, nothing marks it specially at review time, so it reaches here as
  // ordinary approved implementResponse text. Found live as a real 2-task cluster
  // (observability-fix-ac-45/ac-59) in queue/blocked/: both correctly explained the flagged
  // issue no longer exists, and both got "Invalid JSON in Group B implementResponse:
  // Unexpected token 'F', \"FALSE POSI\"..." instead of the clean skip they deserved.
  // Anchored to the START of the (trimmed) response -- real Group B JSON always begins
  // with `[` or `{`, so this can never misfire on a legitimate change whose diff content
  // happens to mention "false positive" somewhere inside a string value.
  if (/^false[\s-]?positive\b/i.test(String(task.implementResponse || '').trim())) {
    return { skipped: true, reason: `false positive (already fixed / no code change needed): ${String(task.implementResponse).trim().slice(0, 300)}` };
  }
  return applyGroupB({ implementResponse: task.implementResponse, repoRoot, pipelineDir });
}

function closeOriginatingBrainDumpEntry(task, brainDumpPath, note) {
  // research (Brain Dump #1 follow-up, 2026-08-17): same shape as adhoc -- a
  // brainDumpEntryId only ever appears on a task queued by applyBrainDumpSort's own
  // requiresResearch branch, so this is unambiguous the same way adhoc's own check is.
  if (task.domain !== 'adhoc' && task.domain !== 'research') return;
  const brainDumpEntryId = task.promptContext && task.promptContext.brainDumpEntryId;
  if (!brainDumpEntryId) return;
  try {
    closeBrainDumpEntryResolved({ brainDumpPath, brainDumpEntryId, note });
  } catch (e) {
    // Never let bookkeeping failure turn a real, already-applied fix into a reported
    // apply failure -- same "recording shouldn't break the real feature" contract
    // model_stats_client.py's own header states for its own best-effort writes.
  }
}

function assertStageableFiles(task, files) {
  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === 'string' && f.length > 0)) {
    throw new Error(`task ${task.id}: no target file path`);
  }
}

module.exports = { coAuthorTrailer, usesGroupB, applyCandidateSplit, writeArtifact, closeOriginatingBrainDumpEntry, assertStageableFiles };
