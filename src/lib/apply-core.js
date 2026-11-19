'use strict';

// apply-core.js -- extracted from src/apply-task.js ([[hub-task-integration]] node-module decompose).

const { getRegisteredSource, resolveSourceName, registerTaskSource } = require('../task-source-registry.js');
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

// Apply-only registry entries (AC-212): writeArtifact is a single getRegisteredSource -> source.apply
// dispatch. These entries carry applyOnly:true so getRegisteredSources() (task generation, priority
// maps, domains, topology) never enumerates them as real task sources.
function applyHubCandidateSplit({ task, pipelineDir }) {
  // A split the draft routed to the hub system becomes real, ordered sub-tasks under a coordinator.
  // applyCandidateSplitAsHub lives in the agent-manager-hub-tasks plugin; see candidate-split-hub-route.js.
  // Never falls back to the plain split path.
  const filer = getCandidateSplitHubFiler();
  if (!filer) {
    throw new Error(`task ${task.id}: candidate split routed to a coordinator hub, but no hub-task filer is registered -- load/register the agent-manager-hub-tasks plugin (AGENT_MANAGER_REGISTER_PATH)`);
  }
  return filer.applyCandidateSplitAsHub(task, pipelineDir);
}

function applyPlainCandidateSplit({ task }) {
  return applyCandidateSplit(task, getRegisteredSource(resolveSourceName(task)));
}

function applyGroupBEntry({ implementResponse, repoRoot, pipelineDir }) {
  // Several Group B sources are told to answer with the empty string when there is nothing to change;
  // review already approves that, so apply must skip cleanly instead of failing in JSON.parse.
  if (isEffectivelyEmptyResponse(implementResponse)) {
    return { skipped: true, reason: 'no code change needed (empty implement response, already approved at review)' };
  }
  // A plain-text refusal ("FALSE POSITIVE -- ...") is a legitimate approved answer too. Anchored to the
  // start of the trimmed response: real Group B JSON always begins with [ or {.
  if (/^false[\s-]?positive\b/i.test(String(implementResponse || '').trim())) {
    return { skipped: true, reason: `false positive (already fixed / no code change needed): ${String(implementResponse).trim().slice(0, 300)}` };
  }
  return applyGroupB({ implementResponse, repoRoot, pipelineDir });
}

const APPLY_ONLY_ENTRIES = {
  'hub-candidate-split': applyHubCandidateSplit,
  'candidate-split': applyPlainCandidateSplit,
  'group-b': applyGroupBEntry,
};

function ensureApplyEntries() {
  for (const [name, apply] of Object.entries(APPLY_ONLY_ENTRIES)) {
    if (!getRegisteredSource(name)) registerTaskSource(name, { applyOnly: true, apply });
  }
}
ensureApplyEntries();

// The only place that inspects candidateSplitProposals / candidateSplitRoute / task group.
// Most protected case first: a split must reach its proposals writer even when the origin source has its own apply.
function applyEntryName(task) {
  ensureApplyEntries(); // idempotent; survives clearRegistry() in tests
  if (Array.isArray(task.candidateSplitProposals) && task.candidateSplitProposals.length > 0) {
    return task.candidateSplitRoute === 'hub' ? 'hub-candidate-split' : 'candidate-split';
  }
  return usesGroupB(task) ? 'group-b' : resolveSourceName(task);
}

function writeArtifact(task, repoRoot, pipelineDir) {
  const name = applyEntryName(task);
  const source = getRegisteredSource(name);
  if (!source || typeof source.apply !== 'function') {
    throw new Error(`task ${task.id}: no registered apply entry "${name}"`);
  }
  try {
    return source.apply({ implementResponse: task.implementResponse, repoRoot, pipelineDir, task });
  } catch (e) {
    if (e && typeof e.message === 'string') e.message = `[apply entry "${name}", task ${task.id}] ${e.message}`;
    throw e;
  }
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

module.exports = { coAuthorTrailer, usesGroupB, applyCandidateSplit, applyEntryName, writeArtifact, closeOriginatingBrainDumpEntry, assertStageableFiles };
