'use strict';

// prompt-implementation.js -- extracted from src/prompts.js ([[hub-task-integration]] node-module decompose).

require('../task-sources.js');

function pathPrefetchResolveImplementPrompt(task, planText) {
  return [
    'Earlier you wrote this verdict:',
    '',
    planText,
    '',
    'Now output ONLY a single JSON object matching your verdict above -- nothing else, no explanation before or after, no markdown code fences. It must have exactly these fields:',
    '',
    '{',
    '  "paths": ["relative/path/from/the/file/list/above.ts"],',
    '  "rationale": "one or two sentences explaining the match (or why there is none)",',
    '  "confident": true or false -- match your verdict above: true for a "confident match", false for a "best guess" or "no real match". Do not downgrade a confident verdict to false just because some other file is tangentially related -- confident means this is clearly the right (or clearly the best) match, not that every other file has been formally ruled out.',
    '}',
    '',
    'paths must be an empty array [] if your verdict was "no real match" -- never fill it with a random guess just to have something there. Every path in the array must be copied EXACTLY from the file list you were given, not paraphrased or partially typed.',
  ].join('\n');
}

function deepDiveImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  return [
    'Earlier you wrote this PLAN for one community of an external project:',
    '',
    planText,
    '',
    'Now write ONLY the final item write-up(s) your plan identified -- 0 to 5 of them (same cap as the plan). If your plan found nothing worth flagging, output the empty string and nothing else; do not invent an item to have something to show. Keep each Rationale to 2-3 sentences -- a revision pass rewriting all items at once has a fixed token budget, and a long response here can get cut off mid-item, silently losing content that was actually fine.',
    '',
    'Each item MUST use exactly this format (must match this parser exactly or it cannot be consumed downstream):',
    '',
    '### ITEM: short title',
    `Community: ${ctx.communityName}`,
    'Files: the specific file path(s) this references -- copy each path EXACTLY as shown in the "Files in this community" list from your plan input (full path, e.g. "python/packages/autogen-ext/src/foo/_bar.py"), never shortened or paraphrased',
    'Rating: Use / Adapt / Ignore',
    'Rationale: what this is, and specifically how it applies (or does not) to agent-manager',
    '',
    'Rating means: Use = take it close to as-is; Adapt = the idea is good but agent-manager\'s own context differs enough that it needs real rework; Ignore = considered and does not apply -- state the concrete reason, do not just omit it. An Ignore item with a real reason is exactly as valid an outcome as a Use/Adapt item -- never skip writing one just because the verdict is negative.',
  ].join('\n');
}

function backlogDecompositionImplementPrompt(task, planText) {
  return [
    'Earlier you wrote this ordered PLAN for building out the product spec:',
    '',
    planText,
    '',
    'Now write ONLY the final candidate write-up(s) for each step in your plan, IN THE SAME ORDER -- this order is not cosmetic, ' +
      'whatever comes first in your output gets built first. Do not reorder, skip, or merge steps from your plan without a reason stated in the write-up itself.',
    '',
    'Each candidate MUST use exactly this format (this must match the project\'s backlog-candidates doc convention exactly, or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Title',
    'Strength: Strong',
    'Files: comma, separated, file, paths (leave blank if this creates brand-new files with no existing path to name)',
    '',
    'Problem:',
    'What part of the spec this step implements, and why it belongs at this point in the build order (what it depends on, if anything).',
    '',
    'Solution:',
    'A paragraph describing the concrete change -- specific enough that a later drafting pass can implement it without re-reading the whole spec.',
    '',
    'Benefits:',
    'What becomes possible once this step lands.',
    '',
    '(Strength may instead be "Worth exploring" or "Speculative" if you are less confident a step is correctly scoped or ordered.) ' +
      'Use AC-001, AC-002, ... in your own draft -- the real numbering is assigned when this is written to the doc, so collisions do not matter here.',
  ].join('\n');
}

function brainDumpSortImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  return [
    'Earlier you triaged this note:',
    '',
    planText,
    '',
    `NOTE: ${ctx.rawText}`,
    '',
    'The text after "NOTE:" above is the complete, real note, however short or self-referential -- it is never missing and never a placeholder. If your plan above hedged or asked for clarification, that was a mistake: classify the actual NOTE text shown here instead of repeating that hedge.',
    '',
    'Now output ONLY a single JSON object describing your final classification -- nothing else, no explanation before or after, no markdown code fences. It must have exactly these fields:',
    '',
    '{',
    '  "secondBrainPath": "<one of the allowed top-level folders>/<descriptive-name>.md",',
    '  "tags": ["short", "lowercase", "keywords"],',
    '  "actionable": true or false -- true only if this genuinely needs someone to DO something, not just remember it,',
    '  "rationale": "one sentence explaining the destination",',
    '  "belongsToProject": "exact project label from the tracked list above, or null if this note is not a concrete feature/bug for one of those projects -- null even if a tracked project\'s name appears in the note\'s own title, when the note actually describes a new standalone plugin/product idea rather than an edit to that project\'s existing files (see your plan\'s CRITICAL distinction above). This is a PROJECT LABEL, NOT a second-brain folder name -- do not output a vault folder like \'Projects\', \'Notes\', \'Inbox\', or \'Ideas\' here, even though \'Projects\' also happens to be a valid secondBrainPath folder above; that is a completely different field with a different vocabulary.",',
    '  "requiresResearch": true or false -- true only if properly resolving this note means going out and finding NEW information (web search, reading real sources) before it can be documented, not just filing the note as stated. Independent of belongsToProject -- this is never a code change, and should never be true at the same time as naming a belongsToProject.',
    '  "possibleDuplicateOf": "the exact title, copied verbatim, of an already-queued task from the list above that this note plainly asks for the same thing as -- or null if none genuinely match. Be conservative: only a real match on the underlying feature/fix, never a vague topical overlap.",',
    '  "relatedNotes": ["existing-note-basename", ...] -- 0 to 5 existing notes this one clearly relates to, filename only without .md; [] if none. Used to wikilink the notes together.',
    '}',
    '',
    'secondBrainPath must be the specific file path you settled on in your plan above -- `<folder>/<name>.md`, never a bare folder and never a bare vault-root file. Its top-level folder MUST be one of the allowed folders shown in your plan, copied with the casing EXACTLY. The file name itself must describe the note\'s actual subject, not a generic placeholder word (ideas/notes/misc/todo and similar are rejected automatically).',
  ].join('\n');
}

module.exports = { pathPrefetchResolveImplementPrompt, deepDiveImplementPrompt, backlogDecompositionImplementPrompt, brainDumpSortImplementPrompt };
