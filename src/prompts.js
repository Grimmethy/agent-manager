'use strict';

// Builds the actual prompt text handed to the local model for each task domain/source.
// Kept in Node (not shell string interpolation) deliberately: prompts embed raw file
// content of unknown shape, and shell here-string interpolation/delimiter rules are the
// wrong tool for splicing in arbitrary text safely. The orchestration script only shells
// out to this file and treats the result as an opaque string.
//
// Per-source prompt-building logic lives in the task-source registry (see
// task-source-registry.js) -- a registered source supplies its own buildPlanPrompt/
// buildImplementPrompt. require('./task-sources.js') below is loaded purely for its side
// effect of populating the registry with this package's 10 built-in sources.
const { getRegisteredSource, updateTaskSource, resolveSourceName } = require('./task-source-registry.js');
const { pendingBlock, filledBlock } = require('./product-spec-assembly.js');
const { anchorFilesPromptBlock } = require('./task-anchor-files.js');
const { CANONICAL_TOP_LEVEL } = require('./brain-dump-sort-classify.js');
require('./task-sources.js');

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}\n...[truncated]` : str;
}

// Real, byte-exact file content embedded into a prompt for the model to read/quote/
// find-replace against (arch_discovery, deep_dive, arch_import, pipeline_self_audit) --
// centralized here (2026-08-21) both to de-duplicate the identical inline expression this
// replaced at 4 call sites, and to fence each file's content in a real markdown code
// block. The fence isn't cosmetic: a live TokenFold compression-proxy test the same night
// found that content embedded WITHOUT a fence gets treated as ordinary prose and silently
// loses exact whitespace/wording (confirmed: "AT APPLY TIME from what was actually on
// disk" became "...from what was on disk", real code lost all indentation) -- TokenFold's
// own protected-region detector only recognizes fenced code blocks, nothing else. This
// pipeline's exact-match apply path (apply-group-b.js's find/replace) has zero tolerance
// for that kind of loss regardless of whether TokenFold or any other prompt-compression
// layer is in front of Ollama, so fencing real file content is worth doing unconditionally
// -- it costs nothing when no compression proxy is in the path, and is the one thing that
// actually protects this content when one is.
function formatFileContents(files) {
  return (files || []).map((f) => {
    const tag = f.context
      ? ` ---   (shown for REFERENCE -- the candidate's prose names this file; it is not on the Files: line, so only edit it if the change genuinely requires it)`
      : '';
    return `--- ${f.path} ---${tag}\n\`\`\`\n${f.content}\n\`\`\``;
  }).join('\n\n');
}

// Shared by every "real code change" source (arch_review, trouble_log, adhoc/manual): the
// apply step is a fully deterministic script (apply-group-b.js) with no LLM involved -- it
// consumes JSON shaped like exactly one of create/edit/delete, applied via a grammar-
// constrained decode. A single object covers a one-file change; a JSON ARRAY of them covers
// a change spanning multiple files.
const groupBJsonInstructions = [
  'Now output ONLY JSON describing the concrete file change(s) your corrected plan calls for -- nothing else, no explanation before or after the JSON, no markdown code fences.',
  '',
  'If the change touches exactly ONE file with exactly one logical edit, output a single JSON object. Otherwise output a JSON ARRAY of these objects instead -- one per logically distinct edit, including MULTIPLE edits against the SAME file when the change has more than one independent part there (they apply in the order listed, each against the result of the one before it) -- do not cram unrelated edits into one object\'s find/replace just to keep the output to one item.',
  '',
  'Each object must be shaped like exactly ONE of these three forms:',
  '  {"mode": "create", "file": "relative/path/from/repo/root.js", "content": "full file content"}',
  '  {"mode": "edit", "file": "relative/path/from/repo/root.js", "find": "exact existing substring", "replace": "new substring"}',
  '  {"mode": "delete", "file": "relative/path/from/repo/root.js"}',
  '',
  'Example of a single-file change (illustrative only -- do not reuse this content, it is not from this repo):',
  '  {"mode": "edit", "file": "backend/utils/example.js", "find": "return value * 1.0;", "replace": "return value * 1.05;"}',
  '',
  'Example of a multi-file change:',
  '  [{"mode": "create", "file": "backend/utils/shared.js", "content": "..."}, {"mode": "edit", "file": "backend/utils/caller.js", "find": "...", "replace": "..."}]',
  '',
  '"find" must be an EXACT substring that appears in the real current file content shown in your plan above -- copy it character for character, do not paraphrase or reformat it, or the edit will fail to apply. "file" must be a real path relative to the repository root. Stay inside exactly the files and scope the plan named -- do not touch anything the plan did not call out, even if it looks related.',
  '',
  'If the finding is a false positive (the code is already correct, the concern is not actionable, or the change would be a no-op), do NOT output a file-change JSON object. Output exactly this single line instead: FALSE POSITIVE -- <one-line justification>. Do NOT output meta-commentary, hedging, or prose descriptions of code in place of the JSON; the only valid outputs are the file-change JSON described above or the FALSE POSITIVE line.',
].join('\n');

// 2026-08-26, Grimmethy: "how do we make that split happen the moment it realizes the
// scope is too large... should split it into smaller parts" -- root-caused live via
// arch-review-ac-4 (extract git vs. direct-write apply paths into separate functions):
// two attempts in a row either produced a disconnected fragment or correctly extracted
// ONLY the smaller half of the ask, because the full candidate genuinely doesn't fit
// safely into one atomic JSON edit for a model this size -- and there was no escape
// hatch other than silently under-delivering or retrying the exact same oversized ask
// until it exhausted. Modeled directly on adhoc-agentic-draft.js's own RESOLUTION:
// decompose (the identical problem for agentic adhoc tasks), adapted to this shape's
// JSON-only output contract instead of a free-text RESOLUTION line. local-draft.js
// detects this shape before critique (there's no diff to critique, same reasoning
// decompose already established); review-task.js judges it on completeness/coverage,
// not "does it contain code"; apply-task.js writes the sub-candidates back into the
// SAME candidates doc the original came from (reusing applyArchDiscoveryCandidates,
// the exact appender arch_discovery already uses) instead of applying a diff -- each
// sub-candidate then flows through the normal pickup loop on a later tick, small enough
// to land as one atomic edit on its own.
const candidateSplitInstructions = [
  'If the change above genuinely does not fit safely into one or a few JSON file-change objects -- e.g. it requires extracting multiple independent functions, updating call sites in several places, or otherwise more surface than a handful of edits can capture correctly in one atomic pass -- do NOT force it into an incomplete or fragile diff. Output this instead:',
  '',
  '{"mode": "split", "candidates": [',
  '  {"title": "...", "files": "comma, separated, paths", "problem": "...", "solution": "...", "benefits": "..."},',
  '  {"title": "...", "files": "comma, separated, paths", "problem": "...", "solution": "...", "benefits": "..."}',
  ']}',
  '',
  'Requirements: at least 2 sub-candidates; together they must cover the FULL original scope with nothing dropped; each must be independently small enough to land as its own single JSON file-change object later, on its own; write each one as a real, self-contained Problem/Solution/Benefits write-up (a future drafting pass will only ever see the sub-candidate\'s own text, not this one). Do NOT use this escape hatch for anything that genuinely fits in the file-change JSON below -- splitting a change that didn\'t need it just adds review overhead for no reason.',
  '',
  'EVERY sub-candidate must be a concrete code change. NEVER emit a sub-candidate whose job is to read, inspect, confirm, document, or analyze the code first -- the full file content is already above, and the pass that implements each sub-candidate gets it too. "Understand / document the current structure", "identify the exact text", "record the current behaviour" and the like are NOT valid sub-candidates and will be rejected. If you cannot yet name the exact functions, lines, or identifiers a sub-candidate would touch, the split is not ready: output the single-diff file-change JSON below instead of a split.',
].join('\n');

// Sources whose candidates are ALREADY a decomposition and must never be re-split (a split
// just files more candidates of the same kind, which get re-split, forever). Reads the
// `noCandidateSplit` flag straight off the registration -- same pattern as
// isCandidateFulfillmentSource / isEmptyApprovalSource in local-draft.js.
function isNoCandidateSplitSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.noCandidateSplit);
}

// ---- Per-source plan-prompt builders ----

function troubleLogPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are drafting a plan to resolve this issue.',
    '',
    `TICKET: ${ctx.ticketId} - ${ctx.title}`,
    '',
    ctx.body,
    '',
    'Write a numbered PLAN (no code). State assumptions explicitly; say UNKNOWN rather ' +
      'than inventing facts not given above.',
  ].join('\n');
}

function archReviewPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are drafting a plan for a narrow architecture-improvement change to this project.',
    '',
    `CANDIDATE: ${ctx.candidateId} -- ${ctx.title}`,
    '',
    'Full candidate write-up (Problem / Solution / Benefits, already vetted -- do not second-guess ' +
      'whether this is worth doing, only how to do it safely):',
    ctx.body,
    '',
    `Files involved: ${ctx.files.join(', ') || '(not specified -- infer from the write-up)'}`,
    '',
    'Write a numbered PLAN (no code) for EXACTLY this change and nothing broader -- do not expand ' +
      'scope to adjacent cleanup even if you notice something else that looks wrong nearby. State ' +
      'assumptions explicitly; say UNKNOWN rather than inventing facts not given above. If the ' +
      'write-up references a file you were not given the content of, say so instead of guessing ' +
      'its contents.',
  ].join('\n');
}

function archDiscoveryPlanPrompt(task) {
  const ctx = task.promptContext;
  const fileList = ctx.files.map((f) => `- ${f.path} (link-degree ${f.degree})`).join('\n');
  const fileContents = formatFileContents(ctx.files);
  return [
    'You are looking for real architectural friction in ONE community of files from this project.',
    '',
    `COMMUNITY: ${ctx.communityName} (id ${ctx.communityId})`,
    '',
    'Files in this community, most-connected first (full content included below):',
    fileList || '(none)',
    '',
    fileContents || '(no file content available)',
    '',
    'Candidates already proposed for OTHER communities (for context only -- do not duplicate an ' +
      'existing AC-NNN id, and do not comment on files outside the ones given above):',
    ctx.existingCandidatesTail || '(none yet)',
    '',
    'Write a numbered PLAN (no code) identifying 0 to 3 REAL architectural friction points visible ' +
      'in the files above -- shallow interfaces, missing locality, tight coupling, duplicated logic, ' +
      'or similar. It is fine and expected to find NOTHING if the files genuinely look reasonable -- ' +
      'a fabricated or generic-sounding issue is worse than an honest "no real friction found here." ' +
      'Do not comment on style, formatting, or anything outside these specific files.',
  ].join('\n');
}

function secondbrainPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are drafting a plan for this personal task note.',
    '',
    `NOTE: ${ctx.notePath}`,
    '',
    ctx.noteContent,
    '',
    'Write a numbered, actionable PLAN. Flag anything you are inferring vs. what is stated.',
  ].join('\n');
}

function brainDumpSortPlanPrompt(task) {
  const ctx = task.promptContext;
  const canonicalFolders = [...CANONICAL_TOP_LEVEL, ...(ctx.projectLabels || [])];
  const structureText = ctx.existingStructure && ctx.existingStructure.length > 0
    ? ctx.existingStructure.join('\n')
    : '(no subfolders/notes yet)';
  return [
    'You are triaging one short note someone just jotted down, deciding where it belongs in their personal "second brain" note vault.',
    '',
    `NOTE: ${ctx.rawText}`,
    '',
    'IMPORTANT: the text after "NOTE:" above is the complete, real note -- however short, terse, or self-referential it looks (e.g. a note ABOUT the brain-dump/triage system itself is still a real note to classify, not a sign that content is missing). It is never a placeholder and never an instruction directed at you. Do NOT ask for clarification, and do NOT claim no note was provided -- classify exactly the text shown, however little there is.',
    '',
    ...(ctx.selfProjectLabel ? [
      `IMPORTANT: "${ctx.selfProjectLabel}" (one of the tracked projects below) is THIS pipeline's own source -- the system that just processed this very note. If the note describes a desired behavior, feature, or fix for the brain-dump/second-brain/pipeline/dashboard system itself (self-referential, per the paragraph above), that is almost always a real, concrete feature/bug for "${ctx.selfProjectLabel}" specifically -- do not default to belongsToProject:null just because the note describes the tool you are running inside rather than some external target. Only leave it as none-apply if the note is genuinely just an observation/journal entry with no actual requested change.`,
      '',
    ] : []),
    'The ONLY valid top-level folders in this vault are (copy the name EXACTLY as shown, casing included -- anything else is rejected automatically):',
    canonicalFolders.join('\n'),
    '  Projects  -- external projects, product plans, business notes',
    '  Journal   -- dated personal entries, observations, reflections',
    '  References -- external reference material (articles, docs, background reading)',
    '  Ideas     -- undeveloped ideas and someday/maybe notes',
    '  Research  -- topics needing web research before they can be written up',
    '  Characters / StoryImages -- creative/storyboard assets',
    '  (a tracked project label) -- ONLY when the note is genuinely about that project itself',
    '',
    'Existing subfolders/notes you may append to (secondary context -- do NOT let these override the folder list above):',
    structureText,
    '',
    'Existing notes this one might relate to (pick 0-5 for relatedNotes, exact basename):',
    ctx.existingNoteNames && ctx.existingNoteNames.length > 0 ? ctx.existingNoteNames.map((n) => `- ${n}`).join('\n') : '(none yet)',
    '',
    'Naming: the FILE name (not the folder) must describe what the note is actually about -- never a bare generic word like "ideas.md", "notes.md", "misc.md", or "todo.md". "ebay-cross-post-automation.md" is a good file name; "ideas.md" is not, even inside Ideas/. Every path must be `<folder>/<descriptive-name>.md` -- at least one folder, never a bare file at the vault root.',
    '',
    'A note describing a concrete change/feature/bug for a tracked project (INCLUDING this pipeline itself) is a WORK TASK, not a note: set belongsToProject + actionable:true and let it become a real queued task. Passive vault notes (category reference/idea/journal, belongsToProject null) are ONLY for observations, journal entries, and external reference material -- never for "the pipeline should do X" or "fix the dashboard Y".',
    '',
    'Tracked code projects (only relevant if this note is literally a feature/bug for one of these codebases):',
    ctx.projectLabels && ctx.projectLabels.length > 0 ? ctx.projectLabels.join('\n') : '(no tracked code projects)',
    '',
    // 2026-08-24 (pipeline hardening, Grimmethy: "duplicate-task detection before
    // filing") -- root-caused live: this session found 3 separate near-duplicate tasks
    // that each independently reached drafting and review before anyone noticed they
    // asked for the same thing (e.g. two differently-worded "/api/hardware endpoint"
    // tasks from two different brain dumps). Showing the classifier what's already
    // queued costs nothing extra (this call already runs regardless) and catches this
    // at the ONE point before any compute is spent drafting either one.
    'Already-queued task titles (only relevant if THIS note plainly asks for the same thing one of these already covers -- different wording for the same underlying feature/fix still counts as a duplicate, judge by what it actually asks for, not by matching words):',
    ctx.existingQueuedTitles && ctx.existingQueuedTitles.length > 0 ? ctx.existingQueuedTitles.map((t) => `- ${t}`).join('\n') : '(nothing currently queued)',
    '',
    'Think through, in a short numbered list: (1) what this note is actually about, (2) whether it is a task/reminder that needs someone to DO something, or just something to remember/reference, (3) which existing folder (or a new one, only if genuinely nothing fits) it belongs under, (4) a short relative file path within that folder to file it under (an existing note to append to, or a new one to create), (5) if this describes a concrete feature/bug IN one of the tracked code projects listed above (i.e. an edit to that project\'s own existing files), name which one -- otherwise say none apply, (6) if properly resolving this note means going out and finding NEW EXTERNAL information first (something on the public web -- a product, service, account, business, or public event) rather than just filing the note as stated, say so -- that makes it a real research task, independent of (5) (a research task is never a code change, and it never has real access to any tracked project\'s own repo -- see the CRITICAL note just below), and (7) does this note plainly ask for the same thing as one of the already-queued titles above -- if so, name that exact title; be conservative here, only flag a REAL match (same underlying feature/fix), not a vague topical overlap (e.g. two different tasks both mentioning "the dashboard" is not a duplicate), and (8) which existing notes from the list above does this note clearly relate to (0-5, exact basenames) -- used to wikilink them together.',
    '',
    'CRITICAL distinction for (6) (confirmed live 2026-08-23, a real stuck-task incident): "investigate X" / "look into Y" is NOT automatically a research task -- a research task means the answer lives on the PUBLIC WEB. A note asking to investigate/debug/fix something about a TRACKED PROJECT ITSELF (its own code, a feature it broke, a bug in its own dashboard/pipeline/UI -- the exact self-referential case (5) above already covers) is an in-repo investigation, not a web research topic, EVEN THOUGH the note\'s own wording uses "investigate" or "look into." A research task filed for a self-referential internal bug will search the public web for a private tool\'s name, find nothing, and permanently fail -- it has no git/file access to ever actually answer it. When a note describes something broken or in need of investigation IN one of the tracked projects listed above (including this pipeline itself, per selfProjectLabel below if set), route it via (5), never (6), regardless of which investigative verb the note happens to use.',
    '',
    'CRITICAL distinction for (5) (confirmed live 2026-08-20, a real stuck-task incident): "a feature/bug IN a tracked project" means an edit to files that ALREADY EXIST in that project. A note describing an entirely NEW, SEPARATE, standalone product or plugin (e.g. "Agent Manager plugin > X: I\'d like to build a plugin that...", or any note whose actual ask is "build a whole new [product/app/system]" even if it would eventually be hosted/managed by a tracked project) is NOT a feature/bug in that project\'s own codebase -- it needs its own new repository, which does not exist yet and cannot be created by an ordinary code-edit task. For these, say "none apply" for (5) regardless of which project\'s name appears in the note\'s own title, and note in your rationale that this describes a new standalone plugin/product idea, not an edit to the named project\'s existing code -- do NOT route it as if it were a normal in-repo feature request, even though it mentions a tracked project by name.',
    '',
    "If you're naming a tracked code project in (5), the note becomes a real queued task in that project's pipeline -- a downstream step tries to match keywords in your title/rationale against that project's own file structure to prefetch relevant paths, purely deterministic, no judgment call for you to make here. It just means: don't paraphrase away the concrete nouns already in the note (an actual file, module, or feature name) if they're there -- keep them recognizable in your title/rationale rather than replacing them with a vaguer summary phrase.",
  ].join('\n');
}

// path_prefetch_resolve (hybrid path-prefetch design, 2026-08-16): the deterministic
// pass in path-prefetch.js already tried and failed to match this task's text against
// the project's file list (either nothing matched at all, or a keyword matched more than
// one file with no way to pick automatically) -- this is the smart fallback for exactly
// those cases, not a first attempt. Same "judgment call, not a code-change task" framing
// as unusedExportPlanPrompt/observabilityReviewPlanPrompt above (assemblePrompt's
// stable/volatile split), since this is reasoning about which real file(s) a note
// describes, not writing any code.
function pathPrefetchResolvePlanPrompt(task) {
  const ctx = task.promptContext;
  const stable = [
    'A deterministic keyword match already ran against this note and could not confidently resolve it to a file in the project -- either nothing matched at all, or a keyword matched more than one file with no way to auto-pick. Your job is to look at the note and the real file list below and reason about which file(s), if any, this note is actually about.',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "confident match: <path(s)> -- here\'s why" (given the note and the real file list, these specific file(s) are clearly the right (or clearly the best) match -- you do not need to rule out every conceivable tangential file to call this confident, just be sure this is the one a human would pick too)',
    '- "best guess: <path(s)> -- here\'s the reasoning, but flag the uncertainty" (reserve this for real uncertainty -- e.g. the note is vague enough that two DIFFERENT files could equally be "the" answer, or the match relies on a stretch/assumption not actually stated in the note. If the note clearly identifies the feature/bug and one file is obviously its home, that\'s a confident match, not a best guess)',
    '- "no real match -- here\'s why nothing in the file list plausibly relates" (genuinely nothing fits; do not force a guess just to have an answer)',
    'Do not invent a file that is not in the list below. If the note is genuinely too vague (e.g. "fix the bug" with zero identifying detail), say so instead of guessing at random.',
    'If your choice comes down to a file and its own near-identical .test/.spec file (e.g. "foo.js" vs "foo.test.js") with nothing in the note pointing specifically at the test itself, default to the standard, non-test file.',
  ];
  const volatile = [
    `NOTE: ${ctx.rawText || ctx.taskTitle || '(no text)'}`,
    '',
    `Why the deterministic pass failed: ${ctx.reason === 'ambiguous' ? 'ambiguous -- one or more keywords matched multiple files' : 'no keyword in the note matched any file'}`,
    ctx.candidates ? `\nAmbiguous candidates already found (each keyword matched ALL of these -- your job is to pick which one(s), if any, are actually right):\n${Object.entries(ctx.candidates).map(([k, files]) => `  "${k}": ${files.join(', ')}`).join('\n')}` : '',
    '',
    `Real files in this project (pick ONLY from this list -- ${ctx.fileList.length} total):`,
    ctx.fileList.join('\n'),
  ];
  return assemblePrompt(stable, volatile);
}

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

// Fix (2026-08-31, bra-1788142124203): when a prior draft attempt on this SAME task
// already produced a real plan (runPlanPass surfaces it as task._seedPlan from
// task.draftAttempts[].plan.text / task.lastGoodPlan), hand it to the plan pass as a
// starting point instead of cold-rolling from scratch every retry -- a reject-retry or
// cross-repo requeue otherwise regenerates each time and can trade a good plan for a stub.
// Returns [] (no lines) when there is no seed. Kept as trailing lines so it never displaces
// the stable instruction text.
function seedPlanBlock(task) {
  const seed = task && typeof task._seedPlan === 'string' ? task._seedPlan.trim() : '';
  if (!seed) return [];
  return [
    '',
    'A PRIOR attempt on this exact task already produced this plan:',
    '',
    seed,
    '',
    'Use it as your starting point. Review it against the CURRENT repository: fix anything repo-specific, wrong, or missing, and tighten each step to name real files/functions. Produce an improved numbered PLAN — do NOT start from scratch and do NOT just restate it unchanged.',
  ];
}

// Real repo content for the adhoc plan pass (2026-09-04) -- the files the task names plus a
// grep on its identifiers, built deterministically by plan-grounding.js. Trailing, like
// seedPlanBlock, so the stable instruction prefix is never displaced. [] when ungrounded.
function planGroundingBlock(task) {
  const g = task && typeof task._planGrounding === 'string' ? task._planGrounding.trim() : '';
  if (!g) return [];
  return [
    '',
    'REAL REPOSITORY CONTENT for this task (read/greped from the repo just now — this pass has NO tools, this is the only file content you get):',
    '',
    g,
    '',
    'Ground every file path, function name and line number in your PLAN in the content above. Cite `path:line` where the content shows the relevant code. Where you extrapolate beyond what is shown, say so explicitly ("assuming X — verify"). Do NOT name a path or symbol that does not appear above unless the step is to CREATE it.',
  ];
}

function adhocPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are drafting a plan for this one-off task submitted directly by a human or an orchestrating agent.',
    '',
    `Title: ${task.title}`,
    '',
    truncate(JSON.stringify(ctx), 4000),
    '',
    'Write a numbered, actionable PLAN.',
    'IMPORTANT: This promptContext\'s shape is NOT standardized. Treat anything not explicitly stated in it as unknown — do not assume a field exists just because a similar-sounding one appeared in another kind of task.',
    ...seedPlanBlock(task),
    ...planGroundingBlock(task),
  ].join('\n');
}

// research_task never had a plan template registered here -- local-draft.js's main loop
// unconditionally calls buildPlanPrompt() before checking task.domain (the domain==='research'
// branch that skips straight to research-agentic-draft.js's own WebSearch/WebFetch call only
// kicks in at the IMPLEMENT stage, further down), so every research task fell through to
// genericFallbackPlanPrompt's throw and died on its very first tick, forever (found live
// 2026-08-17: 3 research tasks retried and failed identically every tick, up to 6+ hours).
//
// 2026-08-25, second incident, same underlying task type: this plan pass used to be
// "intentionally throwaway" (no tool access, output never even read by the implement
// pass) -- confirmed to be a REAL problem, not just an unused nicety, on a real blocked
// research_task (Toregem BioPharma tooth-regrowth trial lookup): with nothing to check
// itself against, the plan pass invented a plausible-looking-but-fake clinical trial
// registry ID and site before any real research had happened. That fabrication then
// leaked into review as ground truth (buildVerdictPrompt hands the reviewer
// task.planResponse directly, unconditionally, for every source), and three straight
// implement attempts got rejected for "failing" to reproduce a record that never
// existed -- no amount of redrafting implement could have fixed a bad premise living one
// stage upstream. Now grounded the same way draftResearchImplement() already is: given
// real WebSearch/WebFetch tool access (see local-draft.js's own research-domain branch
// wiring this in), and explicitly instructed to verify before stating anything specific.
function researchPlanPrompt(task) {
  const ctx = task.promptContext || {};
  return [
    'A note has been classified as requiring real web research (not a code change). You have real WebSearch/WebFetch tool access RIGHT NOW -- use it. Your job here is NOT to write the final report (a separate, more thorough research pass does that next) -- it is to scope the investigation and pin down anything specific enough to verify.',
    '',
    'Write a short PLAN (2-5 numbered points) for what the follow-up research pass should investigate and what a good write-up should cover.',
    '',
    'CRITICAL: do not state a specific identifier, registry number, date, name, or URL as a known fact unless you actually found it via a real search/fetch in this pass just now. If you looked and could not confirm something specific (an exact registry ID, an exact site, an exact date), say so explicitly ("the research pass should look for X; I could not confirm it") rather than guessing a plausible-looking value -- a guessed-but-wrong specific here becomes a false requirement the next pass gets graded against, not a helpful lead.',
    '',
    `Title: ${task.title || ''}`,
    '',
    `NOTE: ${ctx.rawText || '(no text)'}`,
    ctx.tags && ctx.tags.length ? `\nTags: ${ctx.tags.join(', ')}` : '',
  ].join('\n');
}

// Prompt assembly: stable (identity/rules) block first, volatile (per-task) block last --
// agent-engine's prompt-assembler.ts pattern (project idea shortlist, 2026-07-26),
// adapted here. Putting ALL static instructional text in one contiguous leading block,
// with every dynamic per-task value strictly after it, maximizes the shared prefix across
// repeated calls of the same task type -- a caching-aware backend (Ollama keeps a
// KV-cache keyed on matching leading tokens) can reuse that prefix's computation instead
// of reprocessing identical instructions from scratch on every single call. The old
// convention interleaved static instructions before AND after the dynamic block (e.g.
// "Write a numbered PLAN..." used to come after the file/rule details), which broke
// prefix-sharing the moment any dynamic content appeared -- nothing after that point
// could ever match a prior call's tokens exactly, no matter how similar the instructions
// were. Not yet applied to every prompt builder in this file -- rolled out first to the
// two "judgment call" plan prompts below as the initial adoption of the pattern.
function assemblePrompt(stableLines, volatileLines) {
  return [...stableLines, '', ...volatileLines].join('\n');
}

function unusedExportPlanPrompt(task) {
  const ctx = task.promptContext;
  const stable = [
    'This is a judgment call, NOT a code-change task. Determine whether the flagged symbol (defined in the given file, both shown below) is genuinely dead code or a false positive.',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "genuinely dead, safe to remove"',
    '- "keep — here\'s why the low call-site count is a false positive (e.g. barrel/re-export pattern the grep can\'t see)"',
    '- "uncertain — here\'s what would need to be checked that isn\'t given here"',
    'Do not default to removing without engaging with architectural patterns like factory/strategy where duplicate-looking names are correct by design.',
  ];
  const volatile = [
    `Symbol: ${ctx.symbol}`,
    `Defined in: ${ctx.definedIn}`,
    '',
    'CALL SITES FOUND:',
    ctx.callSites && ctx.callSites.length > 0 ? JSON.stringify(ctx.callSites, null, 2) : '(none found)',
    '',
    'NOTE (verbatim from task source):',
    ctx.note || '',
  ];
  return assemblePrompt(stable, volatile);
}


// unused_export's implement pass has the identical gap observability_review's just had
// fixed (2026-07-26) -- registered only a buildPlanPrompt, so it silently fell through to
// the same mismatched genericFallbackImplementPrompt. Never actually confirmed live
// (queue/dead-code-flags.json has never existed in this pipeline's real history, so no
// real unused_export task has ever been drafted) -- fixed anyway for consistency, since
// the design gap is identical and would hit the exact same failure the moment the scanner
// is ever actually run.
function unusedExportImplementPrompt(task, planText) {
  return [
    'Your plan above is the final REASONED VERDICT for this dead-code candidate -- there is no further code change to make in this task (removing genuinely dead code would be a separate follow-up task, not this one).',
    '',
    planText,
    '',
    'Write ONE short paragraph (2-4 sentences) recording the verdict for a human to read later: genuinely-dead/false-positive/uncertain, and why. Plain prose only -- no JSON, no code fence, no "steps".',
  ].join('\n');
}

// project_search's plan pass has a different JOB than every other source's plan pass: it
// doesn't plan a change, it proposes SEARCH QUERIES for the harness to execute against
// GitHub/Hugging Face between plan and implement (see local-worker.ps1's project_search
// branch and project-search-fetch.js). The local model has no internet access, so this is the one
// place its judgment actually adds value in this source's pipeline -- picking good queries
// from project context is a reasoning task, not something worth hardcoding as keyword
// extraction (see ADR-0018).
function projectSearchPlanPrompt(task) {
  const ctx = task.promptContext;
  const knownList = ctx.knownUrls && ctx.knownUrls.length > 0
    ? ctx.knownUrls.map((u) => `- ${u}`).join('\n')
    : '(none logged yet)';
  return [
    `You are looking for open-source projects (GitHub repos, Hugging Face models/datasets) that could inform or feed into the project "${ctx.projectTag}".`,
    '',
    'PROJECT CONTEXT (its own CONTEXT.md and/or CLAUDE.md, verbatim):',
    ctx.projectDocs,
    '',
    'Leads ALREADY LOGGED (do not propose queries aimed at re-finding these specific things):',
    knownList,
    '',
    'Propose 1 to 3 SHORT SEARCH QUERIES (a few words each, like you would type into a search box) ' +
      'that could surface genuinely useful external projects for this specific project -- not generic ' +
      'terms, and not just an echo of dependency names already in use. Think about what real gap or ' +
      'recurring need this project has, based on the context above.',
    '',
    'Output EXACTLY this format, one query per line, nothing else:',
    'QUERY: <search terms>',
    'QUERY: <search terms>',
  ].join('\n');
}

// ---- Per-source implement-prompt builders (unused_export has no dedicated implement
// branch -- it falls through to the generic fallback, so it intentionally gets NO
// buildImplementPrompt registered below) ----

// Grounding fix (2026-08-21, see task-sources.js's nextCandidateFulfillmentTask header for
// the full incident this closes): fetchedFiles is real, freshly-read file content for
// every path the candidate's own "Files:" line named -- a file that doesn't exist (a
// candidate proposing something brand-new, or a stale path) is simply absent from the
// list, not an error. Before this, the implement pass for arch_review/arch_import_review/
// observability_fix/performance_fix/backlog_fulfillment had NOTHING but the candidate's
// own prose write-up to work from -- confirmed live: a real task fabricated a plausible-
// looking `find` string that matched nothing in the actual file, because it was never
// shown the file at all.
function archReviewImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const fetched = ctx.fetchedFiles || [];
  const namedButMissing = (ctx.files || []).filter((f) => !fetched.some((ff) => ff.path === f));
  return [
    'Earlier you wrote this PLAN for a narrow architecture-improvement change:',
    '',
    planText,
    '',
    `The corrected plan is for: ${ctx.candidateId} -- ${ctx.title}.`,
    '',
    fetched.length > 0
      ? `Real, current content of the file(s) this candidate named (this is the ONLY source of truth for what the file actually contains right now -- the plan/candidate write-up above may be stale or approximate; this is not):\n\n${formatFileContents(fetched)}`
      : '(none of the file(s) this candidate named could be read -- see the note below before assuming why.)',
    '',
    namedButMissing.length > 0
      ? `NOTE: ${namedButMissing.join(', ')} named by this candidate could not be read (does not exist at that path, or is outside the repo). If your plan calls for creating this file, use mode "create". If your plan assumed this file already exists and you cannot proceed without seeing its real content, output the empty string instead of guessing at content you were never shown.`
      : '',
    '',
    'Ground every "find" value in the real file content shown above, character for character -- never in your own memory of the plan or candidate write-up. If the real content above does not actually contain what the plan assumed, the plan was wrong about the file\'s current state; do not force a `find` that only approximately matches.',
    '',
    // Deterministic one-level pre-split (2026-09-02): the reader (nextCandidateFulfillmentTask)
    // sets mustPreSplit for a candidate spanning >=2 files or >=3 numbered steps -- more
    // than the local model lands in one diff. Here it is REQUIRED to split, not offered the
    // choice. Its sub-candidates come back stamped Split-Depth: 1 and can never be pre-split
    // again (hard recursion stop), so the earlier "re-split forever" failure cannot recur.
    ctx.mustPreSplit
      ? `This candidate is too broad to land as one diff -- it ${(ctx.files || []).length >= 2 ? `spans ${ctx.files.length} files (${ctx.files.join(', ')})` : 'lays out several independent edit steps'}. You MUST decompose it. Output ONLY a {"mode": "split", ...} response -- do NOT attempt a single file-change diff.\n\n${candidateSplitInstructions}\n\nEach sub-candidate must touch ONE file and one logical concern, and be listed in the order it must be applied (if a later sub-candidate depends on code an earlier one adds, say so in its Problem). At least 2, covering the full original scope.`
      : (isNoCandidateSplitSource(task.source) ? null : candidateSplitInstructions),
    ctx.mustPreSplit || isNoCandidateSplitSource(task.source) ? null : '',
    ctx.mustPreSplit ? null : groupBJsonInstructions,
  ].filter((l) => l !== null).join('\n');
}

function archDiscoveryImplementPrompt(task, planText) {
  return [
    'Earlier you wrote this PLAN identifying architectural friction points (or none) in one community of files:',
    '',
    planText,
    '',
    'Now write ONLY the final candidate write-up(s) for the friction points your plan identified -- ' +
      '0 to 3 of them. If your plan found no real issues, output the empty string and nothing else; ' +
      'do not invent a candidate to have something to show.',
    '',
    'Each candidate MUST use exactly this format (this must match your project\'s architecture-' +
      'candidates doc\'s existing convention exactly, or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Title',
    'Strength: Strong',
    'Files: comma, separated, file, paths',
    '',
    'Problem:',
    'A paragraph describing the friction.',
    '',
    'Solution:',
    'A paragraph describing the fix.',
    '',
    'Benefits:',
    'A paragraph describing what improves.',
    '',
    '(Strength may instead be "Worth exploring" or "Speculative" if you are less confident.) ' +
      'Pick an AC-NNN number higher than any AC-NNN id already visible in the "Candidates already ' +
      'proposed for OTHER communities" section of your plan\'s input, so it does not collide with an ' +
      'existing one.',
  ].join('\n');
}

// deep_dive (ADR-0019) reuses arch_discovery's pre-fetched-community-context shape (see
// nextDeepDiveTask() in task-sources.js) but asks a different question: not "is this code
// architecturally sound" but "what here is worth taking for agent-manager itself." Modeled
// directly on archDiscoveryPlanPrompt/archDiscoveryImplementPrompt above -- same pre-fetch
// constraint (no live exploration), different judgment and output contract.
function deepDivePlanPrompt(task) {
  const ctx = task.promptContext;
  const fileList = ctx.files.map((f) => `- ${f.path} (link-degree ${f.degree})`).join('\n');
  const fileContents = formatFileContents(ctx.files);
  return [
    `You are reading ONE community of files from an external open-source project ("${ctx.projectName}"), looking for anything concretely useful to a DIFFERENT project called "agent-manager" (a local-LLM-driven task pipeline: drafting/review/apply queue, local-model-based workers, majority-vote review gates).`,
    '',
    `COMMUNITY: ${ctx.communityName} (id ${ctx.communityId}, from ${ctx.projectName})`,
    '',
    'Files in this community, most-connected first (full content included below):',
    fileList || '(none)',
    '',
    fileContents || '(no file content available)',
    '',
    'Write a numbered PLAN (no code) identifying 0 to 5 specific things in the files above that are worth a verdict for agent-manager: a pattern to use close to as-is, an idea worth adapting to agent-manager\'s own context, or something plausible-looking that turns out not to apply and should be explicitly marked to ignore (with why). Pick the 5 MOST worth flagging if more genuinely qualify -- do not pad the count. It is fine and expected to find NOTHING worth flagging if this community genuinely has nothing relevant -- a fabricated or generic-sounding item is worse than an honest "nothing useful here." Do not comment on files outside the ones given above, and do not describe what the code does in general -- describe specifically what agent-manager could take from it, or why it does not apply.',
    '',
    'When you cite a file, copy its path EXACTLY as it appears in the "Files in this community" list above (e.g. if the list shows "python/packages/autogen-ext/src/foo/_bar.py", cite that whole string, not a shortened guess like "src/foo/_bar.py") -- a downstream fact-check resolves your citation against the real repo, and a shortened or paraphrased path resolves to nothing and reads as fabrication even when the underlying claim is accurate.',
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

// arch_import (ADR-0020, docs/arch-import-pipeline.md): closes the loop project_search
// and deep_dive started. deep_dive already rated this item Use/Adapt against a real
// external project's files; arch_import's job is narrower -- find out where in
// agent-manager's OWN code this idea would actually land, then draft a real,
// agent-manager-grounded candidate. Same two-call shape as project_search (plan proposes
// search terms the local model itself can't run, the harness runs them, implement gets real
// results) but searching agent-manager's own repo instead of GitHub/Hugging Face -- see
// local-worker.ps1's arch_import branch and arch-import-fetch.js.
function archImportPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    `You are looking at ONE finding a previous deep-dive pass already made about an external project ("${ctx.sourceProject}"), rated ${ctx.rating} for agent-manager:`,
    '',
    `TITLE: ${ctx.itemTitle}`,
    `SOURCE FILES (in ${ctx.sourceProject}): ${ctx.itemFiles || '(none given)'}`,
    `RATIONALE: ${ctx.itemRationale}`,
    '',
    'Propose 1 to 3 SHORT search terms (function/variable/file names, or a few-word phrase) likely to find WHERE in agent-manager\'s own codebase this idea would actually apply -- e.g. an existing config module it could extend, or a pattern it would replace or sit alongside. Think about what agent-manager concept this maps to, not just keywords from the finding above.',
    '',
    'Output EXACTLY this format, one query per line, nothing else:',
    'QUERY: <search terms>',
    'QUERY: <search terms>',
  ].join('\n');
}

function archImportImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const hits = ctx.harnessHits || [];
  const files = ctx.harnessFiles || [];
  const hitsText = hits.length > 0
    ? hits.map((h) => `- ${h.file}:${h.line} (query "${h.query}"): ${h.text}`).join('\n')
    : '(no matches -- the searches found nothing in agent-manager\'s own code)';
  const filesText = files.length > 0
    ? formatFileContents(files)
    : '(no file content fetched)';
  return [
    `Earlier you proposed search terms to find where this deep-dive finding applies in agent-manager's own code:`,
    '',
    planText,
    '',
    `ORIGINAL FINDING (from ${ctx.sourceProject}, rated ${ctx.rating}): ${ctx.itemTitle} -- ${ctx.itemRationale}`,
    '',
    'The harness ran those searches against agent-manager\'s OWN repo. Real matches:',
    '',
    hitsText,
    '',
    'Full content of the matched file(s):',
    '',
    filesText,
    '',
    'Now write ONE architecture-import candidate grounded in the REAL agent-manager files above -- name real files the search actually found, not guessed or invented ones. If the searches found nothing that makes this finding concretely applicable to agent-manager\'s real code, output the empty string and nothing else; do not force a candidate onto files that do not actually fit.',
    '',
    'The candidate MUST use exactly this format (this must match the parser exactly or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Title',
    'Strength: Strong',
    `Source: ${ctx.sourceProject} — "${ctx.itemTitle}"`,
    'Files: comma, separated, agent-manager, file, paths (from the real matches above)',
    '',
    'Problem:',
    'A paragraph describing the friction in agent-manager\'s own code, grounded in the real files above.',
    '',
    'Solution:',
    'A paragraph describing the fix, informed by (but adapted for agent-manager, not copied verbatim from) the original finding.',
    '',
    'Benefits:',
    'A paragraph describing what improves.',
    '',
    '(Strength may instead be "Worth exploring" or "Speculative" if you are less confident.) Pick an AC-NNN number that looks reasonable; the harness re-derives the real one deterministically regardless of what you write here.',
  ].join('\n');
}

// pipeline_self_audit (2026-08-20, Grimmethy: "Is pipeline self audit dependent entirely
// on using the claude subscription? If so, change it to rely on the reasoning model
// itself, even if local"): same two-call shape as arch_import immediately above (plan
// proposes search terms the local model can't run itself, the harness greps agent-manager's own
// repo, implement gets real results) -- but unlike arch_import, this writes a REAL diff
// directly (groupBJsonInstructions, same as archReviewImplementPrompt) rather than a
// candidate for a separate fulfillment stage, since the goal here is closing the loop
// end-to-end on the local model with no second stage and no Claude dependency at all.
function pipelineSelfAuditPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'A deterministic scan of THIS PIPELINE\'S OWN queue/blocked/ found a cluster of tasks all failing the SAME way -- likely a bug in this pipeline\'s own code (a harness/fetch bug, a prompt gap, a broken tool), not each task independently being a bad idea. See the evidence below.',
    '',
    `Failure signature: ${ctx.signature} (${ctx.taskCount} tasks failing this exact way)`,
    '',
    ctx.evidenceText,
    '',
    'Propose 1 to 3 SHORT search terms (function/variable/file names, or a few-word phrase) likely to find the pipeline code responsible for this failure pattern -- think about which source file generates or processes tasks of the affected type, or which harness/tool the failure signature points at.',
    '',
    'Output EXACTLY this format, one query per line, nothing else:',
    'QUERY: <search terms>',
    'QUERY: <search terms>',
  ].join('\n');
}

// pipeline_health_audit (2026-08-24, Grimmethy: "that going looking needs to be an
// automated process. A task that happens just like any other hygiene task") -- same
// two-call harness-search shape as pipeline_self_audit right above (arguably worth
// consolidating into one shared helper someday; kept as its own explicit copy for now,
// consistent with how staleness_audit's identical branch was added the same way). The
// evidence here comes from pipeline-health-audit.js's live process/queue/log inspection
// instead of a blocked-task cluster -- a live-system incident (a broken model profile,
// orphaned processes holding a lock, a masked bash error) rather than a code-only bug a
// blocked-task pattern could point at, so the plan explicitly asks for BOTH: real code
// investigation AND an assessment of whether the anomaly is still ongoing right now.
function pipelineHealthAuditPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'A deterministic health check of THIS PIPELINE\'S OWN live daemons, queue throughput, and recent logs found something that looks anomalous -- see the evidence below. This may be a real bug in this pipeline\'s own code, a transient operational hiccup already resolved, or evidence a human already fixed by hand since this check ran.',
    '',
    ctx.evidenceText,
    '',
    'Propose 1 to 3 SHORT search terms (function/variable/file names, or a few-word phrase) likely to find the pipeline code responsible for whatever the evidence points at -- think about which daemon script, lock, or model-call path the anomaly implicates.',
    '',
    'Output EXACTLY this format, one query per line, nothing else:',
    'QUERY: <search terms>',
    'QUERY: <search terms>',
  ].join('\n');
}

function pipelineHealthAuditImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const hits = ctx.harnessHits || [];
  const files = ctx.harnessFiles || [];
  const hitsText = hits.length > 0
    ? hits.map((h) => `- ${h.file}:${h.line} (query "${h.query}"): ${h.text}`).join('\n')
    : '(no matches -- the searches found nothing in this pipeline\'s own code)';
  const filesText = files.length > 0
    ? formatFileContents(files)
    : '(no file content fetched)';
  return [
    'Earlier you proposed search terms to find the pipeline code behind this anomaly:',
    '',
    planText,
    '',
    'ORIGINAL EVIDENCE:',
    ctx.evidenceText,
    '',
    'The harness ran those searches against THIS PIPELINE\'S OWN repo. Real matches:',
    '',
    hitsText,
    '',
    'Full content of the matched file(s):',
    '',
    filesText,
    '',
    'If the real matches above clearly show a root cause worth fixing, write ONE small, safely-scoped fix for it -- grounded ONLY in the real file content shown above, never a guessed or invented file/line/symbol. Stay inside exactly the anomaly the evidence points at; do not expand scope to adjacent cleanup even if something else nearby looks wrong. If the anomaly looks like a transient/already-resolved hiccup rather than a real code bug (e.g. a since-restarted daemon, a since-cleared lock), or the searches did not find anything that clearly explains it, output the empty string and nothing else -- do not force a change onto files you have not actually seen grounded content for, and do not "fix" something that already fixed itself.',
    '',
    groupBJsonInstructions,
  ].join('\n');
}

// ui_visibility_audit (2026-08-24, Grimmethy: "How do we look for functions and code
// that should have a display in the ui?") -- same two-call harness-search shape as
// pipeline_health_audit right above. The evidence here is a route with no reference in
// any scanned frontend source file, which the implement pass must actively distinguish
// from "deliberately not a dashboard concern" (confirmed live on this exact codebase:
// /api/ping and /api/alerts's own docstrings say they're the companion Android app's
// endpoints, not this dashboard's) before treating it as a real gap.
function uiVisibilityAuditPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'A deterministic text-level scan cross-referenced every Flask route this dashboard defines against every frontend source file that could call it, and found route(s) with no reference anywhere -- see the evidence below. This is a CANDIDATE, not a confirmed gap: some backend endpoints are deliberately not meant to have a dashboard UI (e.g. a route documented as serving a different client entirely).',
    '',
    ctx.evidenceText,
    '',
    'Propose 1 to 3 SHORT search terms (function/variable/file names, or a few-word phrase) likely to find the route\'s own definition and docstring in app.py, plus whatever dashboard tab/panel would be the natural place to surface it if it genuinely needs one.',
    '',
    'Output EXACTLY this format, one query per line, nothing else:',
    'QUERY: <search terms>',
    'QUERY: <search terms>',
  ].join('\n');
}

function uiVisibilityAuditImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const hits = ctx.harnessHits || [];
  const files = ctx.harnessFiles || [];
  const hitsText = hits.length > 0
    ? hits.map((h) => `- ${h.file}:${h.line} (query "${h.query}"): ${h.text}`).join('\n')
    : '(no matches -- the searches found nothing in this pipeline\'s own code)';
  const filesText = files.length > 0
    ? formatFileContents(files)
    : '(no file content fetched)';
  return [
    'Earlier you proposed search terms to find the route(s) this candidate finding points at:',
    '',
    planText,
    '',
    'ORIGINAL EVIDENCE:',
    ctx.evidenceText,
    '',
    'The harness ran those searches against THIS PIPELINE\'S OWN repo. Real matches:',
    '',
    hitsText,
    '',
    'Full content of the matched file(s):',
    '',
    filesText,
    '',
    'First, using ONLY the real matched content above, decide whether this route is genuinely a dashboard gap or deliberately not a dashboard concern (read its docstring/comments -- a route documented as serving a different client, an internal-only endpoint, or a health check is NOT a gap). If it is deliberately non-dashboard, output the empty string and nothing else -- do not force a UI change onto a route that was never meant to have one. If it genuinely looks like backend logic a human would want to see and there is enough grounded context to know what to build, write ONE small, safely-scoped addition to the dashboard template that surfaces it -- grounded ONLY in the real file content shown above. If the route looks like a real gap but you cannot tell what the display should look like from the grounded content alone, output the empty string and nothing else rather than guessing at a UI design.',
    '',
    groupBJsonInstructions,
  ].join('\n');
}

function pipelineSelfAuditImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const hits = ctx.harnessHits || [];
  const files = ctx.harnessFiles || [];
  const hitsText = hits.length > 0
    ? hits.map((h) => `- ${h.file}:${h.line} (query "${h.query}"): ${h.text}`).join('\n')
    : '(no matches -- the searches found nothing in this pipeline\'s own code)';
  const filesText = files.length > 0
    ? formatFileContents(files)
    : '(no file content fetched)';
  return [
    'Earlier you proposed search terms to find the pipeline code behind this failure pattern:',
    '',
    planText,
    '',
    `FAILURE SIGNATURE: ${ctx.signature} (${ctx.taskCount} tasks failing this way)`,
    '',
    'The harness ran those searches against THIS PIPELINE\'S OWN repo. Real matches:',
    '',
    hitsText,
    '',
    'Full content of the matched file(s):',
    '',
    filesText,
    '',
    'If the real matches above clearly show the root cause, write ONE small, safely-scoped fix for it -- grounded ONLY in the real file content shown above, never a guessed or invented file/line/symbol. Stay inside exactly the bug the evidence points at; do not expand scope to adjacent cleanup even if something else nearby looks wrong. If the searches did not find anything that clearly explains this failure pattern, output the empty string and nothing else -- do not force a change onto files you have not actually seen grounded content for.',
    '',
    groupBJsonInstructions,
  ].join('\n');
}

// staleness_audit (2026-08-22, Grimmethy: "Build it now" -- see staleness-audit.js's own
// header for the full spec): same two-call harness-grounded shape as pipeline_self_audit
// immediately above (plan proposes search terms, the harness greps agent-manager's own
// repo, implement gets real results) -- but the goal here is different: pipeline_self_audit
// writes a real diff to FIX a systemic bug; this writes an ADVISORY REPORT recommending
// whether a specific stale/likely-fabricated blocked task is still worth pursuing. No
// groupBJsonInstructions -- there is no diff to produce, and apply-task.js's own
// applyVerdictOnly (same as unused_export/observability_review) is what actually "applies"
// this: it never writes anything, just records the verdict text and marks the task done.
function stalenessAuditPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    `A deterministic scan flagged an OLDER blocked/needs-clarification task (${ctx.originalTaskId}) as possibly stale -- either it has sat untouched for a long time, or it was rejected repeatedly for fabricating claims. See the evidence below.`,
    '',
    `Flagged because: ${(ctx.reasons || []).join(', ')}`,
    '',
    ctx.evidenceText,
    '',
    'Propose 1 to 3 SHORT search terms (function/file/config names, or a few-word phrase) likely to confirm whether the CONCERN described above still holds against the CURRENT state of this repo -- e.g. does the file/function it worried about still look the way it described, or has other work since changed that.',
    '',
    'Output EXACTLY this format, one query per line, nothing else:',
    'QUERY: <search terms>',
    'QUERY: <search terms>',
  ].join('\n');
}

function stalenessAuditImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const hits = ctx.harnessHits || [];
  const files = ctx.harnessFiles || [];
  const hitsText = hits.length > 0
    ? hits.map((h) => `- ${h.file}:${h.line} (query "${h.query}"): ${h.text}`).join('\n')
    : '(no matches -- the searches found nothing in this repo)';
  const filesText = files.length > 0
    ? formatFileContents(files)
    : '(no file content fetched)';
  return [
    'Earlier you proposed search terms to check whether an old blocked task\'s concern still holds:',
    '',
    planText,
    '',
    `ORIGINAL FLAGGED TASK (${ctx.originalTaskId}), flagged because: ${(ctx.reasons || []).join(', ')}`,
    '',
    ctx.evidenceText,
    '',
    'The harness ran those searches against THIS repo\'s CURRENT real content. Real matches:',
    '',
    hitsText,
    '',
    'Full content of the matched file(s):',
    '',
    filesText,
    '',
    'Write a short report (a few sentences, not a diff) covering exactly these three things, grounded ONLY in the real evidence above -- never a guessed or invented file/line/claim:',
    '1. Does the original concern still hold against current repo state, or has it already been resolved by other work?',
    '2. If the original task was flagged for repeated fabrication, does the evidence above suggest its claims were genuinely ungrounded, or does it hold up after all?',
    '3. An explicit RECOMMENDATION: either "archive" (the concern is resolved or was never grounded) or "worth a fresh investigation" (the concern still looks real and unaddressed) -- with one sentence of reasoning.',
    '',
    'Your RECOMMENDATION here has a real, automatic effect once this report passes review: "archive" moves the ORIGINAL flagged task out of the active queue for good; "worth a fresh investigation" takes no action at all and leaves it exactly as it is. This is no longer a human double-checking your read before anything happens -- get it right the first time.',
    '',
    'To recommend "archive" you MUST show one of these, concretely, from the evidence above -- NOT a vague "this is probably handled somewhere":',
    '  (a) name the specific commit (a real hash) that implemented what the original task asked for -- it will be fact-checked; or',
    '  (b) show the CURRENT code covers EVERY concrete thing the original task names -- each UI element, endpoint, data field, file, observable behavior -- each with a real file:symbol. A feature with a similar NAME that acts on a DIFFERENT object (e.g. a toggle that gates data vs. a request about images) is NOT resolution, and neither is "loosely-related code exists."',
    'A task flagged for repeated fabrication or exhausted retries means the PIPELINE could not build it -- that alone is never grounds to archive; it is only "already resolved" if (a) or (b) genuinely holds. If the evidence is thin or ambiguous, or the searches found nothing that pins this down, recommend "worth a fresh investigation." When uncertain, the safe default is "worth a fresh investigation," never "archive."',
  ].join('\n');
}

// pipeline_forensics (2026-09-01) -- deep root-cause study of why a class of pipeline
// tasks keeps failing. Two-call harness shape like stalenessAudit*: the plan pass proposes
// greps to locate the implicated pipeline code, the harness runs them against this repo's
// OWN src/, and the implement pass writes a RANKED prose report (no diff -- advisoryProse).
// The forensic evidence bundle (forensic-bundle.js) is already in ctx.evidenceText, incl.
// a contrast set of tasks that SUCCEEDED.
function pipelineForensicsPlanPrompt(task) {
  const ctx = task.promptContext || {};
  return [
    'A deterministic scan assembled the forensic evidence below about a class of pipeline tasks that keep FAILING. Your eventual job is to rank the root causes and recommend ONE pipeline fix -- but first, locate the real code.',
    '',
    `Subject: ${ctx.subjectKind || '?'} "${ctx.subjectKey || '?'}"  (signature: ${ctx.signature || '?'})`,
    '',
    ctx.evidenceText || '(no evidence text)',
    '',
    'Propose 1 to 3 SHORT search terms (a function name, a file name, a config key, or a few-word phrase) that would let you read the CURRENT code of the pipeline paths implicated above -- use the TIER -> SOURCE FILE map in the evidence to pick real targets (e.g. the tier where the failing tasks died, the tool the winners used that the losers did not).',
    '',
    'Output EXACTLY this format, one query per line, nothing else:',
    'QUERY: <search terms>',
    'QUERY: <search terms>',
  ].join('\n');
}

function pipelineForensicsImplementPrompt(task, planText) {
  const ctx = task.promptContext || {};
  const hits = ctx.harnessHits || [];
  const files = ctx.harnessFiles || [];
  const hitsText = hits.length > 0
    ? hits.map((h) => `- ${h.file}:${h.line} (query "${h.query}"): ${h.text}`).join('\n')
    : '(no matches -- the searches found nothing new in this repo; work from the draftAttempts evidence)';
  const filesText = files.length > 0 ? formatFileContents(files) : '(no file content fetched)';

  const stable = [
    'You are running a pipeline FORENSIC STUDY: figuring out why a class of agent-manager tasks keeps failing, so the PIPELINE can be fixed. This is analysis, not a code change -- output prose, never a diff.',
    '',
    'METHOD -- follow it exactly:',
    '1. Rank the candidate ROOT CAUSES by COUNTERFACTUAL impact. For each cause, state plainly: "if this cause alone were fixed, the failing case WOULD / WOULD NOT have gone through, because <reason grounded in the evidence>."',
    '2. CONTRAST the failing tasks with the WINNER tasks named in the evidence (same task source / same decomposition parent, but they succeeded). What did the winners do -- which tier reached, which tool called, at which turn -- that the failing tasks did not? The divergence point is usually the root cause.',
    '3. Cite REAL files: every file you name must be a real src/... path from the harness matches below or the "TIER -> SOURCE FILE" map in the evidence. Never invent a module or symbol name.',
    '4. The deliverable is a fix to THIS PIPELINE\'s code. NOT a re-attempt of the failed task. NOT a hand-built version of the feature the failed task was trying to build.',
    '',
    'End your report with EXACTLY these sections (prose, no JSON, no code fence), or the single line "NO CLEAR ROOT CAUSE" if the evidence genuinely does not support one:',
    '',
    'ROOT CAUSE RANKING',
    '1. <cause> -- Counterfactual: if fixed alone, WOULD / WOULD NOT have shipped, because <...>. Evidence: <src/file:line, draftAttempt tier X response, worklog call N>. Confidence: high|med|low.',
    '2. <cause> -- ...',
    '',
    'CONTRAST WITH SUCCESSFUL SIBLINGS',
    '<one short paragraph: what the winners did that the losers did not, and where their paths diverge>',
    '',
    'RECOMMENDED FOLLOW-UP FIX',
    'Strength: Strong | Worth exploring',
    'Files: src/<file>, ...',
    'Problem: <the ranked analysis, condensed to 2-4 sentences>',
    'Solution: <one concrete, safely-scoped change to the named files + a specific acceptance check that would prove it worked>',
    'Benefits: <what class of task stops failing>',
    '',
    'If instead the evidence does not support a confident root cause, output ONLY:',
    'NO CLEAR ROOT CAUSE -- <the one additional signal that would be needed>',
  ];
  const volatile = [
    'Earlier you proposed search terms to locate the implicated pipeline code:',
    '',
    planText,
    '',
    'FORENSIC EVIDENCE:',
    ctx.evidenceText || '(none)',
    '',
    `Failing tasks: ${(ctx.loserIds || []).join(', ') || '(see evidence)'}`,
    `Successful sibling tasks to contrast against: ${(ctx.winnerIds || []).join(', ') || '(see evidence)'}`,
    '',
    'The harness ran your searches against THIS repo\'s CURRENT src/. Real matches:',
    '',
    hitsText,
    '',
    'Full content of the matched file(s):',
    '',
    filesText,
  ];
  return assemblePrompt(stable, volatile);
}

// adhoc harness-search tier (2026-08-22, Grimmethy: "expand the tooling capabilities so
// that the local reasoning model can handle the work... I'd like to see the automated
// work being handled entirely locally"): a FIRST, cheap attempt at an adhoc-domain task
// using the same proven harness-grounded pattern pipeline_self_audit/arch_import already
// use, tried before the existing real Claude agentic path (adhoc-agentic-draft.js). NOT
// registered via updateTaskSource('adhoc', ...) -- that registration is already taken by
// adhocPlanPrompt/adhocImplementPrompt just below (a different, ungrounded generic dispatch
// target with no live callers), and this tier is invoked directly by
// adhoc-harness-draft.js, not through buildPlanPrompt/buildImplementPrompt's registry
// dispatch. Output is groupBJsonInstructions (same as adhocImplementPrompt) because
// adhoc-harness-draft.js turns that into a real diff via group-b-worktree-diff.js, the
// exact same contract adhoc-agentic-draft.js's own Claude call already produces
// (task.rawDiff via applyAdhocDiff) -- this tier is a drop-in ALTERNATIVE producer of that
// same shape, not a new apply path.
function adhocHarnessSearchPlanPrompt(task) {
  const ctx = task.promptContext || {};
  return [
    'A human or an orchestrating agent submitted this one-off task directly.',
    '',
    `Title: ${task.title || ''}`,
    '',
    ctx.rawText || truncate(JSON.stringify(ctx), 4000),
    '',
    'Before anything else, propose 1 to 3 SHORT search terms (function/variable/file names, or a few-word phrase) likely to find the exact code this task is about in THIS repo -- think about which file(s) the task\'s own wording points at.',
    '',
    'Output EXACTLY this format, one query per line, nothing else:',
    'QUERY: <search terms>',
    'QUERY: <search terms>',
  ].join('\n');
}

function adhocHarnessSearchImplementPrompt(task, planText) {
  const ctx = task.promptContext || {};
  const hits = ctx.harnessHits || [];
  const files = ctx.harnessFiles || [];
  const hitsText = hits.length > 0
    ? hits.map((h) => `- ${h.file}:${h.line} (query "${h.query}"): ${h.text}`).join('\n')
    : '(no matches -- the searches found nothing in this repo)';
  const filesText = files.length > 0
    ? formatFileContents(files)
    : '(no file content fetched)';
  return [
    'Earlier you proposed search terms to find the code this task is about:',
    '',
    planText,
    '',
    `Title: ${task.title || ''}`,
    '',
    ctx.rawText || truncate(JSON.stringify(ctx), 4000),
    '',
    anchorFilesPromptBlock(task),
    'The harness ran those searches against THIS repo\'s real, current content. Real matches:',
    '',
    hitsText,
    '',
    'Full content of the matched file(s):',
    '',
    filesText,
    '',
    'If the real matches above clearly show you everything you need to make a small, safely-scoped fix, write it -- grounded ONLY in the real file content shown above, never a guessed or invented file/line/symbol. Stay inside exactly what the task asked for.',
    '',
    'If the searches did NOT find enough to confidently ground a real change -- e.g. this genuinely needs reading multiple files and reasoning across them, not just a keyword match, or it is not a code change at all -- output the empty string and nothing else. This is a legitimate outcome, not a failure: a deeper investigation pass will take over next.',
    '',
    groupBJsonInstructions,
  ].join('\n');
}

// product_spec GREENFIELD path (2026-08-20, see task-sources.js's nextProductSpecTask
// header for the full motivation): the request text and the current spec doc ARE the
// grounding, both handed over directly -- there is no code to read because the project
// doesn't exist yet, the spec INVENTS its entities. (The BROWNFIELD path -- an existing
// codebase -- skips these two prompts entirely; it goes through the local decompose ->
// fulfill lane, productSpecOutline*Prompt / productSpecSection*Prompt below.) The one
// thing this prompt insists on that a plain "write me
// a doc" prompt wouldn't: flag a real conflict with an EXISTING decision explicitly
// rather than silently overwriting it. A spec is the one artifact every later feature
// task gets grounded against -- a silently-resolved contradiction here is far more
// expensive than the same mistake in one throwaway code diff, since it propagates into
// everything built on top of it before anyone notices.
function productSpecPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are maintaining the product specification document for a software project this pipeline is building.',
    '',
    ctx.specExists
      ? 'CURRENT SPEC (the only decisions already made -- treat everything in it as settled unless the new request explicitly changes it):'
      : 'CURRENT SPEC: (none yet -- this is the first request filed for this project. You are creating the document, not editing one.)',
    '',
    ctx.specExists ? `\`\`\`\n${ctx.currentSpec}\n\`\`\`` : '(empty)',
    '',
    `NEW REQUEST: ${ctx.requestText}`,
    '',
    'Write a numbered PLAN (no doc text yet) for how the spec should change to incorporate this request. ' +
      'If the request contradicts something already in the current spec, say so explicitly and propose how ' +
      'to resolve it -- do not silently pick one side. If the request is genuinely ambiguous (multiple ' +
      'reasonable interpretations that would produce different specs), say UNKNOWN and list the ' +
      'interpretations rather than guessing one.',
  ].join('\n');
}

function productSpecImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  return [
    'Earlier you wrote this PLAN for updating the product spec:',
    '',
    planText,
    '',
    ctx.specExists
      ? 'CURRENT SPEC (full current content -- any "find" text in your JSON output below must be an exact substring of this):'
      : 'CURRENT SPEC: (none yet -- write the FIRST version of the document.)',
    '',
    ctx.specExists ? `\`\`\`\n${ctx.currentSpec}\n\`\`\`` : '(empty)',
    '',
    `The request being incorporated: ${ctx.requestText}`,
    '',
    `The spec doc's path (use exactly this for "file" below): ${ctx.specRelPath}`,
    '',
    ctx.specExists
      ? 'Now write ONLY the JSON change to the spec doc. Prefer "edit" mode with a small, precisely-anchored find/replace over rewriting the whole document -- an edit that only touches the section the request actually concerns is easier for a human to review and confirm than a full rewrite.'
      : 'Now write ONLY the JSON change to create the spec doc (mode "create"), with clear section headings a later request can find and edit against (e.g. "## Entities", "## API", "## Decisions").',
    '',
    groupBJsonInstructions,
  ].join('\n');
}

// product_spec BROWNFIELD path (2026-08-30 redesign): the target project already has a
// real codebase, so the request describes structure that already exists -- too big for one
// blind local pass. It runs on the LOCAL model in two stages, each grounded by
// harness-mediated grep (the plan pass proposes `QUERY:` terms, the harness greps the
// repo, the implement pass gets real file content). No subscription agent.
//
// Stage 1 (product_spec_outline): decompose the request into ordered `### AC-NNN` section
// candidates -- the SAME format backlog_decomposition uses, so the generic AC-NNN writer
// and consumer apply unchanged.
function productSpecOutlinePlanPrompt(task) {
  const ctx = task.promptContext || {};
  return [
    'You are scoping the SECTIONS of a product specification document for a project that ALREADY has a working codebase. The spec must describe how the system really works, grounded in the real code -- it does not invent anything.',
    '',
    'THE REQUEST (this is the whole scope -- cover only what it concerns, do not spec the entire app):',
    ctx.requestText || '',
    '',
    ctx.specExists
      ? 'A spec doc already exists; treat what is in it as settled unless this request changes it.'
      : 'No spec doc exists yet -- this request bootstraps it.',
    '',
    'First, propose 1 to 3 SHORT search terms (identifiers, file names, or a few-word phrase) that will find the code this request is about.',
    '',
    'Output the queries EXACTLY in this format, one per line, nothing else on those lines:',
    'QUERY: <search terms>',
    'QUERY: <search terms>',
    '',
    'Then, below the queries, write a numbered PLAN (no doc prose yet) of the sections the spec needs for this request, IN DOC ORDER: data model / entities first, then the operations and rules on that data, then anything built on those (APIs, CLI, UI, integrations). Each section must be ONE focused slice of the request -- small enough for a single later drafting pass -- and must correspond to real code. Do not pad the list with sections the request does not call for.',
  ].join('\n');
}

function productSpecOutlineImplementPrompt(task, planText) {
  const ctx = task.promptContext || {};
  const hits = ctx.harnessHits || [];
  const files = ctx.harnessFiles || [];
  const hitsText = hits.length > 0
    ? hits.map((h) => `- ${h.file}:${h.line} (query "${h.query}"): ${h.text}`).join('\n')
    : '(no matches -- the searches found nothing in this repo)';
  const filesText = files.length > 0 ? formatFileContents(files) : '(no file content fetched)';
  return [
    'Earlier you proposed search terms and an ordered section plan for this product-spec request:',
    '',
    planText,
    '',
    `THE REQUEST: ${ctx.requestText || ''}`,
    '',
    'The harness ran your searches against THIS repo\'s real, current content. Real matches:',
    '',
    hitsText,
    '',
    'Full content of the matched file(s):',
    '',
    filesText,
    '',
    'Now write ONE candidate per section from your plan, IN PLAN ORDER (whatever comes first is drafted first -- the order is the doc order and is not cosmetic). Ground every section in a real file shown above; name real paths, never a guessed or invented one. If the searches found nothing that lets you scope a real section, output the empty string and nothing else.',
    '',
    'Each candidate MUST use exactly this format (it is parsed downstream and must match):',
    '',
    '### AC-NNN · Section Title',
    'Strength: Strong',
    'Files: comma, separated, REAL paths from the matches above (leave blank only if this section genuinely names no existing file)',
    '',
    'Problem:',
    'Which part of the request this section documents, and why it belongs at this position in the doc (what it depends on).',
    '',
    'Solution:',
    'What the section\'s prose must state about how the system actually works -- specific and grounded in the real files above, enough that a later pass can write the section without re-reading everything.',
    '',
    'Benefits:',
    'What a reader or a downstream build task can rely on once this section exists.',
    '',
    '"Section Title" becomes a `## ` heading in the final doc: one short line of plain text, no "<", ">", or "-->". (Strength may instead be "Worth exploring" or "Speculative" if you are unsure a section is correctly scoped.) Number your candidates AC-001, AC-002, ...; the real numbering is assigned when they are written to the doc.',
  ].join('\n');
}

// Stage 2 (product_spec_section): a candidate-fulfillment consumer -- draft ONE section at
// a time and deliver it as a Group-B `edit` that fills that section's placeholder block in
// Docs/PRODUCT_SPEC.md. The `find` anchor is pendingBlock() verbatim, so the model only
// has to copy a 4-line block and supply prose -- never echo the whole document.
function productSpecSectionPlanPrompt(task) {
  const ctx = task.promptContext || {};
  const fetched = ctx.fetchedFiles || [];
  return [
    'You are drafting ONE section of a product specification document for a project with a working codebase. Everything the section states about how the system behaves must come from real code, not memory or guesswork.',
    '',
    'THE SECTION BRIEF (from the spec outline -- this is the whole scope of this task):',
    '',
    ctx.body || '',
    '',
    fetched.length > 0 ? 'Code the outline already attached for this section:' : 'The outline attached no code for this section.',
    fetched.length > 0 ? formatFileContents(fetched) : '',
    '',
    'Propose 1 to 3 more SHORT search terms for anything the brief points at that the code above does not already show.',
    '',
    'Output the queries EXACTLY in this format, one per line, nothing else on those lines:',
    'QUERY: <search terms>',
    'QUERY: <search terms>',
    '',
    'Then, below the queries, write a short numbered PLAN for the section\'s prose: the specific things it will state and the real file(s) each is grounded in. No prose yet.',
  ].join('\n');
}

function productSpecSectionImplementPrompt(task, planText) {
  const ctx = task.promptContext || {};
  const fetched = ctx.fetchedFiles || [];
  const hits = ctx.harnessHits || [];
  const files = ctx.harnessFiles || [];
  const hitsText = hits.length > 0
    ? hits.map((h) => `- ${h.file}:${h.line} (query "${h.query}"): ${h.text}`).join('\n')
    : '(no additional matches)';
  const grounding = [
    fetched.length > 0 ? formatFileContents(fetched) : '',
    files.length > 0 ? formatFileContents(files) : '',
  ].filter(Boolean).join('\n\n') || '(no file content available)';
  const find = pendingBlock(ctx.candidateId, ctx.title);
  const replaceShape = filledBlock(ctx.candidateId, ctx.title, '<your section prose here>');
  return [
    'Earlier you proposed search terms and a plan for this one spec section:',
    '',
    planText,
    '',
    'THE SECTION BRIEF:',
    '',
    ctx.body || '',
    '',
    'Additional harness matches for your follow-up searches:',
    '',
    hitsText,
    '',
    'Real file content available to ground this section:',
    '',
    grounding,
    '',
    'Write the section prose now. Every statement about how the system works MUST come from the code shown above, cited by its real relative path where it matters -- no preamble, no invented files or symbols. If the code shown genuinely does not let you write this section, output the empty string and nothing else.',
    '',
    `Deliver it as ONE Group-B "edit" against the spec doc "${ctx.specRelPath}". The "find" value must be EXACTLY this block (the section's current placeholder in the doc), copied character for character:`,
    '',
    find,
    '',
    'The "replace" value is that SAME block with your prose swapped in for the "_(pending)_" line -- keep both `<!-- section:... -->` marker lines and the `## ` heading line byte-for-byte unchanged:',
    '',
    replaceShape,
    '',
    groupBJsonInstructions,
  ].join('\n');
}

// backlog_decomposition (2026-08-20, see task-sources.js's nextBacklogDecompositionTask
// header): turns the confirmed spec into an ORDERED, dependency-aware sequence of real
// feature-implementation candidates -- same two-call shape as arch_discovery (plan
// identifies WHAT, implement writes the final AC-NNN candidate write-up(s)), reusing that
// exact candidate format so nextCandidateFulfillmentTask can consume the result with zero
// new code. The one thing this prompt insists on beyond arch_discovery's own instructions:
// ORDER matters here in a way it doesn't for arch_discovery's independent friction points --
// candidates must come out schema/data-model first, then core operations, then anything
// that depends on those, because the consumer drains them strictly top-to-bottom.
function backlogDecompositionPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are breaking a confirmed product specification down into an ORDERED backlog of real, buildable implementation steps.',
    '',
    'PRODUCT SPEC:',
    '',
    ctx.specText,
    '',
    'Write a numbered PLAN (no code, no candidate write-ups yet) listing the concrete implementation steps this spec calls for, IN BUILD ORDER: ' +
      'data model / schema first (the entities and their relationships), then core operations on that data (create/read/update, key business rules), ' +
      'then anything that depends on those (higher-level features, integrations, UI). Each step should be small enough to implement as one focused change, ' +
      'not "build the whole system." Do not invent requirements the spec does not state; if the spec leaves something as an explicit open question or ' +
      'deferred decision, do not plan a step for it -- note that it is blocked on a decision instead. Aim for the minimum ordered sequence that actually ' +
      'gets from nothing to the spec being real, not an exhaustive wish list.',
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

function projectSearchImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const resultsText = ctx.searchResults && ctx.searchResults.length > 0
    ? ctx.searchResults.map((r) => {
      if (r.error) return `(query "${r.query}", ${r.source}: search failed -- ${r.error})`;
      return `- [${r.source}] ${r.name} -- ${r.description || '(no description)'} (${r.stat || ''}) -- ${r.url} (found via query "${r.query}")`;
    }).join('\n')
    : '(no results -- the searches returned nothing usable)';
  return [
    `Earlier you proposed search queries for project "${ctx.projectTag}":`,
    '',
    planText,
    '',
    'The harness ran those queries against GitHub and Hugging Face. Real results:',
    '',
    resultsText,
    '',
    'Now write 0 to N findings from the REAL results above -- do not invent a project that is not ' +
      'listed. It is fine and expected to write nothing if none of the results are genuinely useful. ' +
      'For each finding you keep, rate it Strong or Weak: Strong means specifically, concretely useful ' +
      'to this project (say how); Weak means plausibly related but not clearly actionable.',
    '',
    'Every factual detail you state about a project -- star count, file names, what it does, what ' +
      'language/library it uses -- must come only from the description/stat text given above for that ' +
      'result, not from your own training-data knowledge of the name or URL, even if you recognize it. ' +
      'If the description above does not mention a detail (e.g. a specific file, an exact star count ' +
      'different from the one given), do not state that detail -- describe only what the result line ' +
      'above actually says. This has caused real rejections before (fabricated star counts, an invented ' +
      'missing file in a real repo) -- confirmed live 2026-08-19.',
    '',
    'Each finding MUST use exactly this format (must match this parser exactly or it cannot be consumed downstream):',
    '',
    '### PROJECT: name',
    'Source: github OR huggingface',
    'URL: the real url from the results above',
    'Description: one or two sentences',
    'Relevant to: ' + ctx.projectTag + ' -- specific reason',
    'Strength: Strong OR Weak',
    'Query: the query that found it (Strong findings only)',
    'Rationale: what specifically this could feed into (Strong findings only)',
  ].join('\n');
}

function troubleLogImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  return [
    `Earlier you wrote this PLAN for ticket ${ctx.ticketId || task.id}:`,
    '',
    planText,
    '',
    groupBJsonInstructions,
  ].join('\n');
}

// General pipeline pattern, added 2026-08-03: some data an implement pass needs is not
// something to GENERATE at all -- it's already fully known (an exact field list, an API
// call shape copied verbatim from real code, a connection-string pattern). Live testing
// this session found the local model substitutes a plausible-looking but WRONG version of exactly
// this kind of data on every attempt (4 separate redrafts of the same field-list array,
// 4 different wrong lists, none matching the one given verbatim in the prompt) -- not
// random hallucination, but confidently reaching for a generic prior over the specific
// given data, even under an explicit "copy these exact strings" instruction. Distinct
// from the preDrafted escape hatch above (local-worker.ps1) which skips generation for an
// ENTIRE already-known implementResponse -- this is for the more common case where only
// PART of a file is fixed/known and the surrounding logic still needs real generation.
// task.promptContext.fixedLiterals: optional array of { name, content } -- content is
// required to appear character-for-character in the final draft. Paired with a
// deterministic post-implement grep gate in review-runner.ps1 that verifies compliance
// before spending a local-model review call, and gives a specific expected-vs-found diff back
// to the next redraft attempt instead of vague prose criticism.
function fixedLiteralsBlock(task) {
  const literals = task.promptContext && Array.isArray(task.promptContext.fixedLiterals)
    ? task.promptContext.fixedLiterals
    : [];
  if (literals.length === 0) return [];
  const lines = [
    '',
    'The following block(s) are FIXED, already-verified content -- they are not something to write or improve, only to place. Copy each one character-for-character into your output at the point it belongs. Do NOT paraphrase, reorder, abbreviate, "correct," or substitute a different-but-similar version from your own knowledge -- any deviation, however minor, is a hard failure that will be mechanically detected and rejected before anyone even reads your reasoning.',
    '',
  ];
  for (const lit of literals) {
    lines.push(`--- FIXED BLOCK: ${lit.name} ---`);
    lines.push(lit.content);
    lines.push('--- END FIXED BLOCK ---');
    lines.push('');
  }
  return lines;
}

function adhocImplementPrompt(task, planText) {
  return [
    'Earlier you wrote this PLAN for a one-off task submitted directly by a human or an orchestrating agent:',
    '',
    planText,
    '',
    ...fixedLiteralsBlock(task),
    groupBJsonInstructions,
  ].join('\n');
}

// Distinct from groupBJsonInstructions above -- that shape is a file-change directive
// (create/edit/delete); this is a classification record, consumed by
// apply-group-a.js's applyBrainDumpSort (which appends rawText into secondBrainPath and
// marks the entry sorted), not applied to any repo file.
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
    '  "belongsToProject": "exact project label from the tracked list above, or null if this note is not a concrete feature/bug for one of those projects -- null even if a tracked project\'s name appears in the note\'s own title, when the note actually describes a new standalone plugin/product idea rather than an edit to that project\'s existing files (see your plan\'s CRITICAL distinction above)",',
    '  "requiresResearch": true or false -- true only if properly resolving this note means going out and finding NEW information (web search, reading real sources) before it can be documented, not just filing the note as stated. Independent of belongsToProject -- this is never a code change, and should never be true at the same time as naming a belongsToProject.',
    '  "possibleDuplicateOf": "the exact title, copied verbatim, of an already-queued task from the list above that this note plainly asks for the same thing as -- or null if none genuinely match. Be conservative: only a real match on the underlying feature/fix, never a vague topical overlap.",',
    '  "relatedNotes": ["existing-note-basename", ...] -- 0 to 5 existing notes this one clearly relates to, filename only without .md; [] if none. Used to wikilink the notes together.',
    '}',
    '',
    'secondBrainPath must be the specific file path you settled on in your plan above -- `<folder>/<name>.md`, never a bare folder and never a bare vault-root file. Its top-level folder MUST be one of the allowed folders shown in your plan, copied with the casing EXACTLY. The file name itself must describe the note\'s actual subject, not a generic placeholder word (ideas/notes/misc/todo and similar are rejected automatically).',
  ].join('\n');
}

// ---- Generic fallback (used when no registry entry matches, or a matched entry has no
// buildPlanPrompt/buildImplementPrompt of its own) ----

function genericFallbackPlanPrompt(task) {
  throw new Error(`no prompt template for domain=${task.domain} source=${task.source}`);
}

function genericFallbackImplementPrompt(task, planText) {
  return [
    'Earlier you wrote this PLAN:',
    '',
    planText,
    '',
    'Now write ONLY the concrete next step described by step 1 of that plan -- keep it small ' +
      'and specific, not the whole plan at once.',
  ].join('\n');
}

// ---- Wire this package's 6 built-in sources' prompt builders into the registry ----

updateTaskSource('trouble_log', { buildPlanPrompt: troubleLogPlanPrompt, buildImplementPrompt: troubleLogImplementPrompt });
// arch_review / arch_import_review / arch_discovery / arch_import / unused_export prompt
// wiring moved to the agent-manager-hygiene plugin (2026-08-27); their builder bodies stay
// exported from this file. backlog_fulfillment still reuses archReview* below.
// observability_fix/performance_fix -- moved to src/maintenance/observability-review.js
// and src/maintenance/performance-review.js (2026-08-23), each with its own small
// plan/implement prompt pair now instead of reaching for archReviewPlanPrompt here.
updateTaskSource('secondbrain', { buildPlanPrompt: secondbrainPlanPrompt });
updateTaskSource('brain_dump_sort', { buildPlanPrompt: brainDumpSortPlanPrompt, buildImplementPrompt: brainDumpSortImplementPrompt });
updateTaskSource('path_prefetch_resolve', { buildPlanPrompt: pathPrefetchResolvePlanPrompt, buildImplementPrompt: pathPrefetchResolveImplementPrompt });
// apply is NOT set here (unlike most of this file's other updateTaskSource calls) --
// 'adhoc' already got apply: applyAdhocDiff at its own registerTaskSource() call in
// task-sources.js, same file unused_export's own apply:applyVerdictOnly is attached in.
// apply-task.js requires task-sources.js directly but never requires this file at all,
// so a custom apply attached only here would be invisible to it -- confirmed live
// 2026-08-17 testing this exact feature (Brain Dump #67): drafting/review worked (both
// go through this file), but apply fell through to the generic Group B JSON-diff path
// and failed parsing a real unified diff as JSON, every time, until apply moved to
// task-sources.js instead. local-draft.js's draftTask() now bypasses
// buildPlanPrompt/buildImplementPrompt's generic implement pass for domain:'adhoc'
// entirely in favor of a real agentic implement (adhoc-agentic-draft.js) -- these two
// stay registered regardless, still a real, generic dispatch target (see this file's
// own CLI entry point at the bottom), just no longer reachable from the adhoc
// production path specifically.
updateTaskSource('adhoc', { buildPlanPrompt: adhocPlanPrompt, buildImplementPrompt: adhocImplementPrompt });
// No buildImplementPrompt -- domain==='research' bypasses buildImplementPrompt entirely
// (see local-draft.js's own domain==='research' branch), same as adhoc's agentic bypass
// just above. Only the mandatory plan stage needs a real template here.
updateTaskSource('research_task', { buildPlanPrompt: researchPlanPrompt });
// observability_review/performance_review -- moved to src/maintenance/ (2026-08-23),
// each with its own plan/implement prompt pair now instead of living here.
updateTaskSource('project_search', { buildPlanPrompt: projectSearchPlanPrompt, buildImplementPrompt: projectSearchImplementPrompt });
updateTaskSource('deep_dive', { buildPlanPrompt: deepDivePlanPrompt, buildImplementPrompt: deepDiveImplementPrompt });
updateTaskSource('pipeline_self_audit', { buildPlanPrompt: pipelineSelfAuditPlanPrompt, buildImplementPrompt: pipelineSelfAuditImplementPrompt });
updateTaskSource('pipeline_health_audit', { buildPlanPrompt: pipelineHealthAuditPlanPrompt, buildImplementPrompt: pipelineHealthAuditImplementPrompt });
updateTaskSource('ui_visibility_audit', { buildPlanPrompt: uiVisibilityAuditPlanPrompt, buildImplementPrompt: uiVisibilityAuditImplementPrompt });
updateTaskSource('staleness_audit', { buildPlanPrompt: stalenessAuditPlanPrompt, buildImplementPrompt: stalenessAuditImplementPrompt });
updateTaskSource('pipeline_forensics', { buildPlanPrompt: pipelineForensicsPlanPrompt, buildImplementPrompt: pipelineForensicsImplementPrompt });
updateTaskSource('product_spec', { buildPlanPrompt: productSpecPlanPrompt, buildImplementPrompt: productSpecImplementPrompt });
updateTaskSource('product_spec_outline', { buildPlanPrompt: productSpecOutlinePlanPrompt, buildImplementPrompt: productSpecOutlineImplementPrompt });
updateTaskSource('product_spec_section', { buildPlanPrompt: productSpecSectionPlanPrompt, buildImplementPrompt: productSpecSectionImplementPrompt });
updateTaskSource('backlog_decomposition', { buildPlanPrompt: backlogDecompositionPlanPrompt, buildImplementPrompt: backlogDecompositionImplementPrompt });
// backlog_fulfillment reuses arch_review's own prompt builders verbatim -- turning one
// AC-NNN candidate (candidateId/title/files/body) into a real diff is the same job
// regardless of which candidates doc it came from; see task-sources.js's
// registerTaskSource('backlog_fulfillment', ...) header for the full reasoning.
updateTaskSource('backlog_fulfillment', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });
updateTaskSource('pipeline_forensics_fix', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });

// ---- Thin lookup functions -- the real public API of this file ----

// Added 2026-08-03: queue-watchdog.ps1 has carefully tracked WHY every past attempt on
// this task was rejected (task.priorRejectionFeedback, one string per attempt) since it
// first existed -- but until now nothing ever read it back out. Confirmed live this
// session: a task redrafted 3 times in a row made a DIFFERENT wrong thing each time
// (missing field list -> then a different content bug -> then a wrong Prisma property
// name) rather than fixing the specific thing it was just told about, because it never
// saw that feedback -- each redraft was a blind fresh roll, not an informed retry.
// Domain-agnostic (lives in the two thin lookup functions below, not per-source
// builders) so every task source benefits, not just adhoc.
function priorRejectionBlock(task) {
  const feedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
  if (feedback.length === 0) return '';
  const lines = [
    '',
    `This task has been attempted ${feedback.length} time(s) before and rejected each time. Do NOT repeat any of these specific mistakes -- read each one and make sure your new attempt genuinely avoids it, not just avoids restating it:`,
    '',
  ];
  feedback.forEach((reason, i) => lines.push(`${i + 1}. ${reason}`));
  lines.push('');
  return lines.join('\n');
}

function buildPlanPrompt(task) {
  const sourceName = resolveSourceName(task);
  const source = getRegisteredSource(sourceName);
  const prior = priorRejectionBlock(task);
  const base = source && typeof source.buildPlanPrompt === 'function'
    ? source.buildPlanPrompt(task)
    : genericFallbackPlanPrompt(task);
  return prior ? prior + base : base;
}

function buildImplementPrompt(task, planText) {
  const sourceName = resolveSourceName(task);
  const source = getRegisteredSource(sourceName);
  const prior = priorRejectionBlock(task);
  const base = source && typeof source.buildImplementPrompt === 'function'
    ? source.buildImplementPrompt(task, planText)
    : genericFallbackImplementPrompt(task, planText);
  return prior ? prior + base : base;
}

// Independent second-opinion pass: a fresh model call reviews the drafter's own Implement
// output before it ever reaches the review queue. Catches issues earlier and cheaper than
// waiting for the review pass.
// 40000, not the old 3000: deep_dive/arch_discovery/arch_import already cap real file
// content at a 24000-char budget (DEEP_DIVE_CONTEXT_BUDGET_CHARS / ARCH_DISCOVERY_CONTEXT_
// BUDGET_CHARS in task-sources.js) before it ever reaches a prompt, and hand that FULL,
// untruncated content to plan/implement. This function re-serializes the whole
// promptContext (not just file content) and used to truncate it at 3000 -- 8x smaller than
// what the drafting stages already saw -- guaranteeing critique's own view was cut off
// mid-file for nearly any real community. Reproduced live 2026-07-21
// (deep-dive-autogen-microsoft-7/-20): critique saw a truncated source, concluded it
// "cannot verify" the plan's claims, flagged that as an issue, and the resulting revision
// pass produced hedging/refusal text citing that same truncation -- text review then
// correctly rejects for being unverifiable meta-commentary, but the actual defect was this
// prompt handing critique less context than the draft itself was written from. 40000 gives
// headroom above the 24000-char budget for JSON-escaping overhead and non-file metadata
// while still bounding domains (adhoc, etc.) with unbounded promptContext shapes.
function buildCritiquePrompt(task, planText, implementText) {
  return [
    'IMPORTANT: You did NOT write this draft. Treat every claim in it as unverified — do not defer to it just because it reads confidently.',
    '',
    `TASK: ${task.title}`,
    `DOMAIN/SOURCE: ${task.domain}/${task.source}`,
    '',
    truncate(JSON.stringify(task.promptContext), 40000),
    '',
    '=== PLAN ===',
    planText,
    '',
    '=== IMPLEMENT DRAFT (the one you are reviewing) ===',
    implementText,
    '',
    'Output contract: if the draft has NO real problems against the given inputs, output exactly and ONLY the literal string `NO ISSUES FOUND`. If it DOES have problems, list each as a separate numbered point. Each point must state (a) what is wrong and (b) which specific fact/input/requirement it contradicts or fails to meet — vague stylistic nitpicks do not count.',
    '',
    'Do NOT invent a problem just to have something to say. If the draft genuinely looks fine against the given inputs, output must be `NO ISSUES FOUND` and nothing else.',
  ].join('\n');
}

// Targeted-correction pattern: fed back only when buildCritiquePrompt flagged real issues.
function buildRevisionPrompt(task, planText, implementText, critiqueText) {
  return [
    'Your earlier draft (below) was independently reviewed by a second call. Specific problems were flagged in the CRITIQUE section below.',
    '',
    'Produce ONE corrected version that addresses every flagged problem. If you believe a specific flag is itself mistaken or inapplicable, leave that part of the draft unchanged — but add exactly one short line at the very end starting with `NOTE:` explaining briefly why that particular flag was not applied.',
    '',
    '=== ORIGINAL IMPLEMENT DRAFT ===',
    implementText,
    '',
    '=== CRITIQUE (flagged problems) ===',
    critiqueText,
  ].join('\n');
}

module.exports = {
  buildPlanPrompt, buildImplementPrompt, truncate, buildCritiquePrompt, buildRevisionPrompt, groupBJsonInstructions, candidateSplitInstructions, formatFileContents,
  adhocHarnessSearchPlanPrompt, adhocHarnessSearchImplementPrompt, seedPlanBlock, planGroundingBlock,
  pipelineForensicsPlanPrompt, pipelineForensicsImplementPrompt,
  // Exported for the out-of-tree hygiene plugin (agent-manager-hygiene), which owns the
  // arch_* / unused_export task sources and does their updateTaskSource() wiring itself.
  // Bodies stay here; archReview{Plan,Implement}Prompt also stay wired below for core
  // backlog_fulfillment.
  archReviewPlanPrompt, archReviewImplementPrompt,
  archDiscoveryPlanPrompt, archDiscoveryImplementPrompt,
  archImportPlanPrompt, archImportImplementPrompt,
  unusedExportPlanPrompt, unusedExportImplementPrompt,
  productSpecOutlinePlanPrompt, productSpecOutlineImplementPrompt,
  productSpecSectionPlanPrompt, productSpecSectionImplementPrompt,
};

if (require.main === module) {
  const fs = require('fs');
  // Loads the consumer's own registration file (project-specific sources like this
  // pipeline's state_targets/field_map_gap) -- without this, buildPlanPrompt/
  // buildImplementPrompt would throw "no prompt template" for any non-built-in source,
  // since this CLI process starts fresh per task with only the 6 built-ins registered.
  const { ensureRegistered } = require('./config.js');
  ensureRegistered();
  const [, , taskPath, pass, planTextPath, implementTextPath, critiqueTextPath] = process.argv;
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));

  if (pass === 'plan') {
    process.stdout.write(buildPlanPrompt(task));
  } else if (pass === 'implement') {
    const planText = fs.readFileSync(planTextPath, 'utf8');
    process.stdout.write(buildImplementPrompt(task, planText));
  } else if (pass === 'critique') {
    const planText = fs.readFileSync(planTextPath, 'utf8');
    const implementText = fs.readFileSync(implementTextPath, 'utf8');
    process.stdout.write(buildCritiquePrompt(task, planText, implementText));
  } else if (pass === 'revise') {
    const planText = fs.readFileSync(planTextPath, 'utf8');
    const implementText = fs.readFileSync(implementTextPath, 'utf8');
    const critiqueText = fs.readFileSync(critiqueTextPath, 'utf8');
    process.stdout.write(buildRevisionPrompt(task, planText, implementText, critiqueText));
  } else {
    console.error('usage: node prompts.js <task.json> [plan|implement|critique|revise] [<planText>|<implementText>|<critiqueText>]...');
    process.exit(1);
  }
}
