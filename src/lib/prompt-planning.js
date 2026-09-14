'use strict';

// prompt-planning.js -- extracted from src/prompts.js ([[hub-task-integration]] node-module decompose).

const { CANONICAL_TOP_LEVEL } = require('../brain-dump-sort-classify.js');
require('../task-sources.js');
const { assemblePrompt } = require('./prompt-assembly.js');

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

module.exports = { troubleLogPlanPrompt, secondbrainPlanPrompt, brainDumpSortPlanPrompt, pathPrefetchResolvePlanPrompt, researchPlanPrompt, pipelineSelfAuditPlanPrompt, pipelineHealthAuditPlanPrompt, uiVisibilityAuditPlanPrompt, stalenessAuditPlanPrompt, productSpecPlanPrompt, backlogDecompositionPlanPrompt };
