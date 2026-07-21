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
// effect of populating the registry with this package's 6 built-in sources.
const { getRegisteredSource, updateTaskSource, resolveSourceName } = require('./task-source-registry.js');
require('./task-sources.js');

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}\n...[truncated]` : str;
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
  const fileContents = ctx.files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');
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

function unusedExportPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'This is a judgment call, NOT a code-change task. Determine whether `symbol` (defined in `definedIn`) is genuinely dead code or a false positive.',
    '',
    `Symbol: ${ctx.symbol}`,
    `Defined in: ${ctx.definedIn}`,
    '',
    'CALL SITES FOUND:',
    ctx.callSites && ctx.callSites.length > 0 ? JSON.stringify(ctx.callSites, null, 2) : '(none found)',
    '',
    'NOTE (verbatim from task source):',
    ctx.note || '',
    '',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "genuinely dead, safe to remove"',
    '- "keep — here\'s why the low call-site count is a false positive (e.g. barrel/re-export pattern the grep can\'t see)"',
    '- "uncertain — here\'s what would need to be checked that isn\'t given here"',
    'Do not default to removing without engaging with architectural patterns like factory/strategy where duplicate-looking names are correct by design.',
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

function archReviewImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  return [
    'Earlier you wrote this PLAN for a narrow architecture-improvement change:',
    '',
    planText,
    '',
    `The corrected plan is for: ${ctx.candidateId} -- ${ctx.title}.`,
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
  const fileContents = ctx.files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');
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

function adhocImplementPrompt(task, planText) {
  return [
    'Earlier you wrote this PLAN for a one-off task submitted directly by a human or an orchestrating agent:',
    '',
    planText,
    '',
    groupBJsonInstructions,
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
updateTaskSource('arch_discovery', { buildPlanPrompt: archDiscoveryPlanPrompt, buildImplementPrompt: archDiscoveryImplementPrompt });
updateTaskSource('secondbrain', { buildPlanPrompt: secondbrainPlanPrompt });
updateTaskSource('adhoc', { buildPlanPrompt: adhocPlanPrompt, buildImplementPrompt: adhocImplementPrompt });
updateTaskSource('unused_export', { buildPlanPrompt: unusedExportPlanPrompt });
updateTaskSource('project_search', { buildPlanPrompt: projectSearchPlanPrompt, buildImplementPrompt: projectSearchImplementPrompt });
updateTaskSource('deep_dive', { buildPlanPrompt: deepDivePlanPrompt, buildImplementPrompt: deepDiveImplementPrompt });

// ---- Thin lookup functions -- the real public API of this file ----

function buildPlanPrompt(task) {
  const sourceName = resolveSourceName(task);
  const source = getRegisteredSource(sourceName);
  if (source && typeof source.buildPlanPrompt === 'function') {
    return source.buildPlanPrompt(task);
  }
  return genericFallbackPlanPrompt(task);
}

function buildImplementPrompt(task, planText) {
  const sourceName = resolveSourceName(task);
  const source = getRegisteredSource(sourceName);
  if (source && typeof source.buildImplementPrompt === 'function') {
    return source.buildImplementPrompt(task, planText);
  }
  return genericFallbackImplementPrompt(task, planText);
}

// Independent second-opinion pass: a fresh model call reviews the drafter's own Implement
// output before it ever reaches the review queue. Catches issues earlier and cheaper than
// waiting for the review pass.
function buildCritiquePrompt(task, planText, implementText) {
  return [
    'IMPORTANT: You did NOT write this draft. Treat every claim in it as unverified — do not defer to it just because it reads confidently.',
    '',
    `TASK: ${task.title}`,
    `DOMAIN/SOURCE: ${task.domain}/${task.source}`,
    '',
    truncate(JSON.stringify(task.promptContext), 3000),
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

module.exports = { buildPlanPrompt, buildImplementPrompt, truncate, buildCritiquePrompt, buildRevisionPrompt, groupBJsonInstructions };

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
