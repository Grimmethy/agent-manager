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
  return (files || []).map((f) => `--- ${f.path} ---\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
}

// Shared by every "real code change" source (arch_review, trouble_log, adhoc/manual): the
// apply step is a fully deterministic script (apply-group-b.js) with no LLM involved -- it
// consumes JSON shaped like exactly one of create/edit/delete, applied via a grammar-
// constrained decode. A single object covers a one-file change; a JSON ARRAY of them covers
// a change spanning multiple files.
const groupBJsonInstructions = [
  'Now output ONLY JSON describing the concrete file change(s) your corrected plan calls for -- nothing else, no explanation before or after the JSON, no markdown code fences.',
  '',
  'If the change touches exactly ONE file, output a single JSON object. If it touches MORE than one file, output a JSON ARRAY of these objects instead (one per file) -- do not combine multiple files into one object.',
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
].join('\n');

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
  const structureText = ctx.existingStructure && ctx.existingStructure.length > 0
    ? ctx.existingStructure.join('\n')
    : '(second brain is empty so far -- you are choosing the first structure)';
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
    'Existing top-level folders/files already in the second brain (reuse one of these when the note fits, rather than inventing a new top-level folder for a single note):',
    structureText,
    '',
    'Two naming rules, both non-negotiable: (1) if you reuse an existing top-level folder, copy its name EXACTLY as shown above, including capitalization -- "Projects" and "projects" are two different folders as far as the filesystem is concerned, and creating a case-variant of one that already exists silently splits it in two. (2) the FILE name (not the folder) must describe what the note is actually about -- never a bare generic word like "ideas.md", "notes.md", "misc.md", or "todo.md" that could just as easily be the name of every other note ever filed. "ebay-cross-post-automation.md" is a good file name; "ideas.md" is not, even inside an Ideas/ folder.',
    '',
    'Tracked code projects (only relevant if this note is literally a feature/bug for one of these codebases):',
    ctx.projectLabels && ctx.projectLabels.length > 0 ? ctx.projectLabels.join('\n') : '(no tracked code projects)',
    '',
    'Think through, in a short numbered list: (1) what this note is actually about, (2) whether it is a task/reminder that needs someone to DO something, or just something to remember/reference, (3) which existing folder (or a new one, only if genuinely nothing fits) it belongs under, (4) a short relative file path within that folder to file it under (an existing note to append to, or a new one to create), (5) if this describes a concrete feature/bug IN one of the tracked code projects listed above (i.e. an edit to that project\'s own existing files), name which one -- otherwise say none apply, and (6) if properly resolving this note means going out and finding NEW information first (e.g. "investigate X", "look into Y for later") rather than just filing the note as stated, say so -- that makes it a real research task, independent of (5) (a research task is never a code change).',
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
  ].join('\n');
}

// research_task never had a plan template registered here -- ornith-draft.js's main loop
// unconditionally calls buildPlanPrompt() before checking task.domain (the domain==='research'
// branch that skips straight to research-agentic-draft.js's own WebSearch/WebFetch call only
// kicks in at the IMPLEMENT stage, further down), so every research task fell through to
// genericFallbackPlanPrompt's throw and died on its very first tick, forever (found live
// 2026-08-17: 3 research tasks retried and failed identically every tick, up to 6+ hours).
// This plan is intentionally throwaway -- draftResearchImplement()/buildResearchPrompt()
// build their agentic prompt straight from task.promptContext/task.title, never from
// task.planResponse -- it only needs to be non-empty so the mandatory plan stage can pass
// and the task can reach the real research call.
function researchPlanPrompt(task) {
  const ctx = task.promptContext || {};
  return [
    'A note has been classified as requiring real web research (not a code change). You will not do the research yourself here -- a separate pass with real web-search tools handles that next. Just write a short PLAN (2-4 numbered points) for what that research pass should look into and what a good write-up should cover.',
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

// observability_review's plan pass (project idea "OpenTelemetry-Observability-Idea",
// 2026-07-26): same "judgment call, not a code-change" framing as unusedExportPlanPrompt
// above, since observability-scan.js's rules are heuristics (brace-matching, keyword
// windows), not a real parser -- every flagged `rule` is a candidate for Ornith to
// confirm or reject, not an assumed-true fact.
function observabilityReviewPlanPrompt(task) {
  const ctx = task.promptContext;
  const stable = [
    'This is a judgment call, NOT a code-change task (yet). A deterministic scanner flagged a possible observability-hygiene issue in a project this pipeline is reviewing (rule/project/file/snippet given below). Determine whether it is a GENUINE issue or a false positive.',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "genuine issue — here\'s the concrete risk (e.g. a real background-task error swallowed silently) and a proposed fix"',
    '- "false positive — here\'s why (e.g. the catch intentionally no-ops for a known-safe case, or the loop\'s health signal is emitted elsewhere the scanner\'s window missed)"',
    '- "uncertain — here\'s what would need to be checked that isn\'t given here"',
    'Do not assume the scanner is right just because it flagged something -- it is a heuristic, not a parser, and false positives are expected.',
  ];
  const volatile = [
    `Rule flagged: ${ctx.rule}`,
    `Project: ${ctx.projectSlug}`,
    ctx.file ? `File: ${ctx.file}:${ctx.line}` : '(repo-wide finding, not tied to one file)',
    `Scanner detail: ${ctx.detail}`,
    '',
    'SURROUNDING SOURCE (if available):',
    ctx.snippet || '(no snippet available for this finding)',
  ];
  return assemblePrompt(stable, volatile);
}

// observability_review's implement pass. REDIRECTED 2026-08-20 (Grimmethy: "What
// tangible benefits are we getting from the huge number of observability review tasks?"
// -> "Make sure it's fixing our project"): a genuine verdict now writes a real, fixable
// candidate in the SAME format arch_discovery's own implement pass uses
// (archDiscoveryImplementPrompt below), consumed by observability_fix
// (task-sources.js) into an actual code diff -- closing the gap the old prompt merely
// promised ("a genuine issue becomes a separate follow-up task later") but never had a
// mechanism for. A false-positive/uncertain verdict still gets the original short-prose
// treatment (2026-07-26 fix's own reasoning still applies: no numbered "steps" to
// implement for a non-finding, so don't ask for JSON/a diff on that path).
function observabilityReviewImplementPrompt(task, planText) {
  return [
    'Your plan above is the final REASONED VERDICT for this observability-hygiene finding in OUR OWN project.',
    '',
    planText,
    '',
    'If the verdict is FALSE POSITIVE or UNCERTAIN: write ONE short paragraph (2-4 sentences) recording why, for a human to read later. Plain prose only -- no JSON, no code fence, no "steps", no candidate block.',
    '',
    'If the verdict is GENUINE: write ONE fix candidate for it, in EXACTLY this format (must match this parser exactly or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Title',
    'Strength: Strong',
    `Files: ${task.promptContext.file || '(the file from the finding above)'}`,
    '',
    'Problem:',
    'A paragraph describing the concrete observability gap, grounded in the snippet you were given.',
    '',
    'Solution:',
    'A paragraph describing the specific fix (e.g. what to log, what to rethrow, what health signal to add) -- scoped to exactly this finding, nothing broader.',
    '',
    'Benefits:',
    'A paragraph describing what improves once fixed.',
    '',
    '(Pick an AC-NNN number that looks reasonable; the harness re-derives the real one deterministically regardless of what you write here.)',
  ].join('\n');
}

// performance_review's plan pass (Brain Dump #94, 2026-08-18: "our pretty little cpu is
// getting overloaded... we need to develop a performance review job for projects
// anyways"). Identical framing to observabilityReviewPlanPrompt above, same reason:
// performance-scan.js's rules are heuristics (brace-matching, keyword windows around a
// loop body), not real profiling -- a flagged sync-io-in-loop or sequential-await could
// easily be a false positive (a loop that only ever runs once, a deliberately
// rate-limited sequence), so every finding is a candidate for Ornith to judge, not an
// assumed-true fact.
function performanceReviewPlanPrompt(task) {
  const ctx = task.promptContext;
  const stable = [
    'This is a judgment call, NOT a code-change task (yet). A deterministic scanner flagged a possible performance issue in a project this pipeline is reviewing (rule/project/file/snippet given below). Determine whether it is a GENUINE issue or a false positive.',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "genuine issue — here\'s the concrete performance cost (e.g. blocking I/O per loop iteration, needless sequential network calls) and a proposed fix"',
    '- "false positive — here\'s why (e.g. the loop only ever runs a handful of times, the sequence is deliberately rate-limited/ordered, the sync call runs once at startup not in a hot path)"',
    '- "uncertain — here\'s what would need to be checked that isn\'t given here (e.g. real call frequency, profiling data)"',
    'Do not assume the scanner is right just because it flagged something -- it is a heuristic, not a profiler, and false positives are expected.',
  ];
  const volatile = [
    `Rule flagged: ${ctx.rule}`,
    `Project: ${ctx.projectSlug}`,
    ctx.file ? `File: ${ctx.file}:${ctx.line}` : '(repo-wide finding, not tied to one file)',
    `Scanner detail: ${ctx.detail}`,
    '',
    'SURROUNDING SOURCE (if available):',
    ctx.snippet || '(no snippet available for this finding)',
  ];
  return assemblePrompt(stable, volatile);
}

// performance_review's implement pass. REDIRECTED 2026-08-20, same treatment/reasoning
// as observabilityReviewImplementPrompt just above ("Do the same for performance_review"):
// a genuine verdict now writes a real, fixable candidate consumed by performance_fix
// (task-sources.js) into an actual code diff, instead of the old dead-end prose-only
// verdict. False-positive/uncertain still gets the short-prose no-op treatment.
function performanceReviewImplementPrompt(task, planText) {
  return [
    'Your plan above is the final REASONED VERDICT for this performance finding in OUR OWN project.',
    '',
    planText,
    '',
    'If the verdict is FALSE POSITIVE or UNCERTAIN: write ONE short paragraph (2-4 sentences) recording why, for a human to read later. Plain prose only -- no JSON, no code fence, no "steps", no candidate block.',
    '',
    'If the verdict is GENUINE: write ONE fix candidate for it, in EXACTLY this format (must match this parser exactly or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Title',
    'Strength: Strong',
    `Files: ${task.promptContext.file || '(the file from the finding above)'}`,
    '',
    'Problem:',
    'A paragraph describing the concrete performance cost, grounded in the snippet you were given.',
    '',
    'Solution:',
    'A paragraph describing the specific fix (e.g. batch the I/O, parallelize, cache the result) -- scoped to exactly this finding, nothing broader.',
    '',
    'Benefits:',
    'A paragraph describing what improves once fixed.',
    '',
    '(Pick an AC-NNN number that looks reasonable; the harness re-derives the real one deterministically regardless of what you write here.)',
  ].join('\n');
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
// GitHub/Hugging Face between plan and implement (see ornith-worker.ps1's project_search
// branch and project-search-fetch.js). Ornith has no internet access, so this is the one
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
    groupBJsonInstructions,
  ].join('\n');
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
    `You are reading ONE community of files from an external open-source project ("${ctx.projectName}"), looking for anything concretely useful to a DIFFERENT project called "agent-manager" (a local-LLM-driven task pipeline: drafting/review/apply queue, Ornith-based workers, majority-vote review gates).`,
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
// search terms Ornith itself can't run, the harness runs them, implement gets real
// results) but searching agent-manager's own repo instead of GitHub/Hugging Face -- see
// ornith-worker.ps1's arch_import branch and arch-import-fetch.js.
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
// proposes search terms Ornith can't run itself, the harness greps agent-manager's own
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

// product_spec (2026-08-20, see task-sources.js's nextProductSpecTask header for the full
// motivation): no harness search, unlike pipeline_self_audit/arch_import right above --
// the request text and the current spec doc ARE the grounding, both handed over directly.
// The one thing this prompt insists on that a plain "write me a doc" prompt wouldn't:
// flag a real conflict with an EXISTING decision explicitly rather than silently
// overwriting it. A spec is the one artifact every later feature task gets grounded
// against -- a silently-resolved contradiction here is far more expensive than the same
// mistake in one throwaway code diff, since it propagates into everything built on top of
// it before anyone notices.
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
// this session found Ornith substitutes a plausible-looking but WRONG version of exactly
// this kind of data on every attempt (4 separate redrafts of the same field-list array,
// 4 different wrong lists, none matching the one given verbatim in the prompt) -- not
// random hallucination, but confidently reaching for a generic prior over the specific
// given data, even under an explicit "copy these exact strings" instruction. Distinct
// from the preDrafted escape hatch above (ornith-worker.ps1) which skips generation for an
// ENTIRE already-known implementResponse -- this is for the more common case where only
// PART of a file is fixed/known and the surrounding logic still needs real generation.
// task.promptContext.fixedLiterals: optional array of { name, content } -- content is
// required to appear character-for-character in the final draft. Paired with a
// deterministic post-implement grep gate in review-runner.ps1 that verifies compliance
// before spending an Ornith review call, and gives a specific expected-vs-found diff back
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
    '  "category": "task | reference | idea | journal | question (pick the closest fit)",',
    '  "secondBrainPath": "relative/path/from/your/plan/above.md",',
    '  "tags": ["short", "lowercase", "keywords"],',
    '  "actionable": true or false -- true only if this genuinely needs someone to DO something, not just remember it,',
    '  "rationale": "one sentence explaining the category and destination",',
    '  "belongsToProject": "exact project label from the tracked list above, or null if this note is not a concrete feature/bug for one of those projects -- null even if a tracked project\'s name appears in the note\'s own title, when the note actually describes a new standalone plugin/product idea rather than an edit to that project\'s existing files (see your plan\'s CRITICAL distinction above)",',
    '  "requiresResearch": true or false -- true only if properly resolving this note means going out and finding NEW information (web search, reading real sources) before it can be documented, not just filing the note as stated. Independent of belongsToProject -- this is never a code change, and should never be true at the same time as naming a belongsToProject.',
    '}',
    '',
    'secondBrainPath must be the specific file path you settled on in your plan above (reusing an existing folder when one fits) -- not a bare folder name, and not something outside the second brain structure you were shown. If reusing an existing folder, its name must match the casing shown above EXACTLY. The file name itself must describe the note\'s actual subject, not a generic placeholder word (ideas/notes/misc/todo and similar are rejected automatically).',
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
updateTaskSource('arch_review', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });
// arch_import_review (ADR-0020): a real code-change fulfillment task, structurally
// identical to arch_review's (same promptContext shape from nextCandidateFulfillmentTask
// -- candidateId/title/body/files) -- reuses the exact same builders rather than a
// duplicate copy that would just drift, same reasoning as
// nextCandidateFulfillmentTask() itself being parameterized instead of copy-pasted.
updateTaskSource('arch_import_review', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });
// observability_fix (2026-08-20): identical promptContext shape (candidateId, title,
// files, body) from nextCandidateFulfillmentTask as arch_review/arch_import_review --
// same reuse, no new prompt needed.
updateTaskSource('observability_fix', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });
// performance_fix (2026-08-20): same reuse as observability_fix just above.
updateTaskSource('performance_fix', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });
updateTaskSource('arch_discovery', { buildPlanPrompt: archDiscoveryPlanPrompt, buildImplementPrompt: archDiscoveryImplementPrompt });
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
// task-sources.js instead. ornith-draft.js's draftTask() now bypasses
// buildPlanPrompt/buildImplementPrompt's generic implement pass for domain:'adhoc'
// entirely in favor of a real agentic implement (adhoc-agentic-draft.js) -- these two
// stay registered regardless, still a real, generic dispatch target (see this file's
// own CLI entry point at the bottom), just no longer reachable from the adhoc
// production path specifically.
updateTaskSource('adhoc', { buildPlanPrompt: adhocPlanPrompt, buildImplementPrompt: adhocImplementPrompt });
// No buildImplementPrompt -- domain==='research' bypasses buildImplementPrompt entirely
// (see ornith-draft.js's own domain==='research' branch), same as adhoc's agentic bypass
// just above. Only the mandatory plan stage needs a real template here.
updateTaskSource('research_task', { buildPlanPrompt: researchPlanPrompt });
updateTaskSource('unused_export', { buildPlanPrompt: unusedExportPlanPrompt, buildImplementPrompt: unusedExportImplementPrompt });
updateTaskSource('observability_review', { buildPlanPrompt: observabilityReviewPlanPrompt, buildImplementPrompt: observabilityReviewImplementPrompt });
updateTaskSource('performance_review', { buildPlanPrompt: performanceReviewPlanPrompt, buildImplementPrompt: performanceReviewImplementPrompt });
updateTaskSource('project_search', { buildPlanPrompt: projectSearchPlanPrompt, buildImplementPrompt: projectSearchImplementPrompt });
updateTaskSource('deep_dive', { buildPlanPrompt: deepDivePlanPrompt, buildImplementPrompt: deepDiveImplementPrompt });
updateTaskSource('arch_import', { buildPlanPrompt: archImportPlanPrompt, buildImplementPrompt: archImportImplementPrompt });
updateTaskSource('pipeline_self_audit', { buildPlanPrompt: pipelineSelfAuditPlanPrompt, buildImplementPrompt: pipelineSelfAuditImplementPrompt });
updateTaskSource('product_spec', { buildPlanPrompt: productSpecPlanPrompt, buildImplementPrompt: productSpecImplementPrompt });
updateTaskSource('backlog_decomposition', { buildPlanPrompt: backlogDecompositionPlanPrompt, buildImplementPrompt: backlogDecompositionImplementPrompt });
// backlog_fulfillment reuses arch_review's own prompt builders verbatim -- turning one
// AC-NNN candidate (candidateId/title/files/body) into a real diff is the same job
// regardless of which candidates doc it came from; see task-sources.js's
// registerTaskSource('backlog_fulfillment', ...) header for the full reasoning.
updateTaskSource('backlog_fulfillment', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });

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

module.exports = { buildPlanPrompt, buildImplementPrompt, truncate, buildCritiquePrompt, buildRevisionPrompt, groupBJsonInstructions, formatFileContents };

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
