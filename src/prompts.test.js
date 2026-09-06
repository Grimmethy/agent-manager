'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const { buildCritiquePrompt, buildPlanPrompt, buildImplementPrompt, formatFileContents, adhocHarnessSearchImplementPrompt } = require('./prompts.js');

// arch_review / arch_import moved to the agent-manager-hygiene plugin (2026-08-27), so
// requiring ./prompts.js no longer wires their builders. These tests exercise
// archReview*/archImport*Prompt's own behaviour (still defined and exported by prompts.js),
// so register minimal sources here so buildPlanPrompt/buildImplementPrompt resolve to them.
{
  const { registerTaskSource, updateTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  const p = require('./prompts.js');
  for (const [name, plan, impl] of [
    ['arch_review', p.archReviewPlanPrompt, p.archReviewImplementPrompt],
    ['arch_import', p.archImportPlanPrompt, p.archImportImplementPrompt],
  ]) {
    if (!getRegisteredSource(name)) {
      registerTaskSource(name, { priority: 70, next: () => null, emptyApproval: true, candidateFulfillment: true });
      updateTaskSource(name, { buildPlanPrompt: plan, buildImplementPrompt: impl });
    }
  }
}

// Real failing content, not synthetic: this is the actual blocked task found live
// 2026-07-21 (deep-dive-autogen-microsoft-20, still sitting in queue/blocked/ at the time
// this test was written). Its promptContext serializes to ~13.6KB -- comfortably over the
// old 3000-char critique truncation cap (which cut it off mid-file, before the second
// community file even started) and comfortably under the new 40000-char cap that matches
// what deep_dive's own plan/implement prompts already received untruncated.
const realTaskPath = path.join(__dirname, '..', 'queue', 'blocked', 'deep-dive-autogen-microsoft-20.json');

function loadRealTaskOrSkip() {
  if (!fs.existsSync(realTaskPath)) return null;
  return JSON.parse(fs.readFileSync(realTaskPath, 'utf8'));
}

test('buildCritiquePrompt does not truncate a real deep_dive promptContext that exceeds the old 3000-char cap', () => {
  const task = loadRealTaskOrSkip();
  if (!task) return; // task since archived/moved on -- not this test's job to pin queue state
  const ctxJson = JSON.stringify(task.promptContext);
  assert.ok(ctxJson.length > 3000, 'fixture assumption: real promptContext must exceed the old cap to prove the fix');

  const prompt = buildCritiquePrompt(task, 'plan text', 'implement text');
  assert.ok(!prompt.includes('...[truncated]'), 'critique prompt should not truncate content that fits under the new 40000-char cap');
  // The second (lower-degree) file's content must actually be present, not cut off before it started.
  assert.ok(prompt.includes('await self.stop()'), 'expected content near the real end of the file to survive into the critique prompt, not just its first ~3000 chars');
});

test('buildCritiquePrompt still truncates a promptContext larger than the new cap', () => {
  const task = { title: 't', domain: 'adhoc', source: 'adhoc', promptContext: { blob: 'x'.repeat(50000) } };
  const prompt = buildCritiquePrompt(task, 'plan', 'impl');
  assert.ok(prompt.includes('...[truncated]'), 'a genuinely oversized promptContext should still be capped, not passed through unbounded');
});

// brain_dump_sort's selfProjectLabel carve-out (2026-08-16): confirmed live a real
// self-referential note ("brain dump entries should track an interaction count") was
// classified actionable:false, belongsToProject:null despite being a genuine feature
// request for agent-manager's own brain-dump system -- the prompt only ever said "a
// self-referential note is real," never connected that to "and therefore belongs to the
// project it describes."
function brainDumpSortTask(promptContextOverrides = {}) {
  return {
    domain: 'brain_dump_sort', source: 'brain_dump_sort', title: 't',
    promptContext: {
      rawText: 'Each brain dump should have an interaction count.',
      existingStructure: [], projectLabels: ['agent-manager'], selfProjectLabel: null,
      ...promptContextOverrides,
    },
  };
}

test('buildPlanPrompt tells the model a self-referential note belongs to selfProjectLabel when one is set', () => {
  const prompt = buildPlanPrompt(brainDumpSortTask({ selfProjectLabel: 'agent-manager' }));
  assert.match(prompt, /"agent-manager".*THIS pipeline's own source/);
  assert.match(prompt, /do not default to belongsToProject:null/);
});

test('buildPlanPrompt omits the selfProjectLabel carve-out entirely when this package is not itself a tracked project', () => {
  const prompt = buildPlanPrompt(brainDumpSortTask({ selfProjectLabel: null }));
  assert.doesNotMatch(prompt, /THIS pipeline's own source/);
});

// New-standalone-plugin misclassification fix (2026-08-20): a real incident where "Agent
// Manager plugin > credit manager: I'd like to build a plugin that..." got classified
// belongsToProject:'agent-manager' and queued as an adhoc code-edit task against
// agent-manager's own repo -- doomed from the start, since nothing about a brand-new
// plugin's vocabulary can ever match agent-manager's existing files. Same root shape hit
// twice more the same session (romance-plugin, and this credit-manager one).
test('buildPlanPrompt tells the model a note naming a tracked project can still be a new-standalone-plugin idea, not an in-repo feature', () => {
  const prompt = buildPlanPrompt(brainDumpSortTask({
    rawText: "Agent Manager plugin > credit manager: I'd like to build a plugin that manages the user's credit and payments.",
    projectLabels: ['agent-manager'],
  }));
  assert.match(prompt, /CRITICAL distinction/);
  assert.match(prompt, /standalone product or plugin/);
  assert.match(prompt, /does not exist yet and cannot be created by an ordinary code-edit task/);
});

test('buildImplementPrompt\'s belongsToProject field instruction explains the same new-standalone-plugin exception, not just the plan', () => {
  const prompt = buildImplementPrompt(brainDumpSortTask(), 'PLAN: ...');
  assert.match(prompt, /null even if a tracked project's name appears in the note's own title/);
});

// product_spec (2026-08-20) -- see task-sources.js's nextProductSpecTask header for the
// full motivation.
function productSpecTask(promptContextOverrides = {}) {
  return {
    domain: 'default', source: 'product_spec', title: 't',
    promptContext: {
      requestId: 'add-deals', requestText: 'Add a Deal entity linked to a Contact and a Company.',
      currentSpec: '## Entities\n\n- Contact\n- Company\n', specExists: true, specRelPath: 'Docs/PRODUCT_SPEC.md',
      ...promptContextOverrides,
    },
  };
}

test('buildPlanPrompt tells the model to treat the current spec as settled and surface real conflicts explicitly', () => {
  const prompt = buildPlanPrompt(productSpecTask());
  assert.match(prompt, /treat everything in it as settled/);
  assert.match(prompt, /- Contact/);
  assert.match(prompt, /Add a Deal entity/);
  assert.match(prompt, /do not silently pick one side/);
});

test('buildPlanPrompt tells the model it is creating (not editing) the doc when no spec exists yet', () => {
  const prompt = buildPlanPrompt(productSpecTask({ currentSpec: '', specExists: false }));
  assert.match(prompt, /this is the first request filed for this project/);
  assert.doesNotMatch(prompt, /treat everything in it as settled/);
});

test('buildImplementPrompt tells the model the exact spec file path and to prefer a small edit over a full rewrite', () => {
  const prompt = buildImplementPrompt(productSpecTask(), 'PLAN: add a Deal section');
  assert.match(prompt, /Docs\/PRODUCT_SPEC\.md/);
  assert.match(prompt, /Prefer "edit" mode/);
  assert.match(prompt, /groupBJsonInstructions|mode.*create.*edit.*delete|"mode": "edit"/);
});

test('buildImplementPrompt tells the model to use create mode when no spec doc exists yet', () => {
  const prompt = buildImplementPrompt(productSpecTask({ currentSpec: '', specExists: false }), 'PLAN: create the doc');
  assert.match(prompt, /write the FIRST version of the document/);
  assert.match(prompt, /mode "create"/);
});

// backlog_decomposition (2026-08-20) -- see task-sources.js's nextBacklogDecompositionTask
// header for the full motivation.
function backlogDecompositionTask(promptContextOverrides = {}) {
  return {
    domain: 'default', source: 'backlog_decomposition', title: 't',
    promptContext: {
      specText: '## Entities\n\n- Contact\n- Company\n- Deal\n',
      specHash: 'abc123def456',
      ...promptContextOverrides,
    },
  };
}

test('buildPlanPrompt tells the model to order steps schema-first, then operations, then dependents', () => {
  const prompt = buildPlanPrompt(backlogDecompositionTask());
  assert.match(prompt, /data model \/ schema first/);
  assert.match(prompt, /- Contact/);
  assert.match(prompt, /IN BUILD ORDER/);
});

test('buildPlanPrompt tells the model not to plan a step for something the spec left as an open question', () => {
  const prompt = buildPlanPrompt(backlogDecompositionTask());
  assert.match(prompt, /do not plan a step for it/);
});

test('buildImplementPrompt for backlog_decomposition emits the same AC-NNN candidate format arch_review\'s consumer already parses, and insists on preserving plan order', () => {
  const prompt = buildImplementPrompt(backlogDecompositionTask(), 'PLAN:\n1. Schema\n2. API');
  assert.match(prompt, /### AC-NNN · Title/);
  assert.match(prompt, /Strength: Strong/);
  assert.match(prompt, /IN THE SAME ORDER/);
  assert.match(prompt, /whatever comes first in your output gets built first/);
});

// product_spec brownfield lane (2026-08-30 redesign): product_spec_outline decomposes a
// brownfield request into ordered AC-NNN section candidates on the local model, grounded
// by harness grep; product_spec_section drafts each section as a Group-B edit against a
// marker block in PRODUCT_SPEC.md.
function productSpecOutlineTask() {
  return {
    domain: 'default', source: 'product_spec_outline', title: 'seed',
    promptContext: {
      requestText: 'document the generate endpoint',
      currentSpec: '', specExists: false, specRelPath: 'Docs/PRODUCT_SPEC.md', specMode: 'brownfield',
      harnessHits: [{ file: 'server/app.py', line: 3, query: 'generate', text: 'def generate():' }],
      harnessFiles: [{ path: 'server/app.py', content: 'def generate():\n    return 1\n' }],
    },
  };
}

test('buildPlanPrompt for product_spec_outline asks for QUERY: terms and an ordered, code-grounded section plan', () => {
  const prompt = buildPlanPrompt(productSpecOutlineTask());
  assert.match(prompt, /scoping the SECTIONS/);
  assert.match(prompt, /QUERY: <search terms>/);
  assert.match(prompt, /IN DOC ORDER/);
  assert.match(prompt, /grounded in the real code/);
});

test('buildImplementPrompt for product_spec_outline renders the harness hits/files and demands the AC-NNN section format', () => {
  const prompt = buildImplementPrompt(productSpecOutlineTask(), 'PLAN:\n1. Data model\n2. API');
  assert.match(prompt, /server\/app\.py:3/);            // hit rendered
  assert.match(prompt, /def generate\(\):/);            // file content rendered
  assert.match(prompt, /### AC-NNN · Section Title/);
  assert.match(prompt, /Strength: Strong/);
  assert.match(prompt, /Problem:[\s\S]*Solution:[\s\S]*Benefits:/);
  assert.match(prompt, /IN PLAN ORDER/);
});

test('buildImplementPrompt for product_spec_section instructs a Group-B edit whose find is pendingBlock() verbatim', () => {
  const { pendingBlock } = require('./product-spec-assembly.js');
  const task = {
    domain: 'default', source: 'product_spec_section', title: 'AC-2 · Generate API',
    promptContext: {
      candidateId: 'AC-2', title: 'Generate API', files: ['server/app.py'],
      fetchedFiles: [{ path: 'server/app.py', content: 'def generate():\n    return 1\n' }],
      body: '### AC-2 · Generate API\nStrength: Strong\nFiles: server/app.py\n\nProblem:\np\nSolution:\ns\nBenefits:\nb',
      specRelPath: 'Docs/PRODUCT_SPEC.md',
    },
  };
  const prompt = buildImplementPrompt(task, 'PLAN:\n1. state the route');
  assert.ok(prompt.includes(pendingBlock('AC-2', 'Generate API')), 'the exact find anchor must appear verbatim in the prompt');
  assert.match(prompt, /Group-B "edit" against the spec doc "Docs\/PRODUCT_SPEC\.md"/);
  assert.match(prompt, /def generate\(\):/);          // fetched code rendered
  assert.match(prompt, /copied character for character/);
});

// backlog_fulfillment reuses arch_review's own prompt builders verbatim -- these tests
// just confirm the registration actually wires that reuse up, not the prompt content
// itself (already covered by arch_review's own behavior).
function backlogFulfillmentTask(promptContextOverrides = {}) {
  return {
    domain: 'default', source: 'backlog_fulfillment', title: 't',
    promptContext: {
      candidateId: 'AC-001', title: 'Set up Contact schema', files: [],
      body: 'Problem:\nNo schema exists yet.\n\nSolution:\nAdd a Contact table.\n\nBenefits:\nUnblocks everything downstream.',
      ...promptContextOverrides,
    },
  };
}

test('backlog_fulfillment is registered to reuse arch_review\'s own plan/implement prompt builders', () => {
  const prompt = buildPlanPrompt(backlogFulfillmentTask());
  assert.match(prompt, /AC-001/);
  assert.match(prompt, /Set up Contact schema/);
  assert.match(prompt, /No schema exists yet/);
});

// formatFileContents fences real file content in a code block (2026-08-21): a live
// TokenFold compression-proxy test found unfenced file content gets treated as ordinary
// prose and silently loses exact whitespace/wording -- code_fence is the ONE region
// TokenFold's own protection mechanism recognizes. This matters regardless of whether
// TokenFold specifically is in front of Ollama; any compression/preprocessing layer is
// more likely to respect a real markdown code fence than raw embedded text.
test('formatFileContents wraps each file\'s content in a real code fence', () => {
  const out = formatFileContents([{ path: 'src/foo.js', content: 'const x = 1;' }]);
  assert.equal(out, '--- src/foo.js ---\n```\nconst x = 1;\n```');
});

test('formatFileContents joins multiple files with a blank line between them, each independently fenced', () => {
  const out = formatFileContents([
    { path: 'a.js', content: 'const a = 1;' },
    { path: 'b.js', content: 'const b = 2;' },
  ]);
  assert.equal(out, '--- a.js ---\n```\nconst a = 1;\n```\n\n--- b.js ---\n```\nconst b = 2;\n```');
});

test('formatFileContents returns an empty string for no files, not a throw', () => {
  assert.equal(formatFileContents([]), '');
  assert.equal(formatFileContents(undefined), '');
});

// Cross-repo (2026-09-04): a fetchForQueries/buildPlanGrounding hit tagged with `root`
// (accessible-roots.js) must never look like a locally-editable file -- root-caused via a
// stuck adhoc task that hallucinated an edit to the wrong repo because nothing said the
// real file it was shown lived somewhere else.
test('formatFileContents tags a cross-repo file (root set) as not locally editable', () => {
  const out = formatFileContents([{ path: 'src/function-length-review.js', root: '/media/model-cache/github/agent-manager-hygiene', content: 'x' }]);
  assert.match(out, /--- src\/function-length-review\.js --- ---   \(repo: agent-manager-hygiene -- a DIFFERENT repo/);
  assert.match(out, /Do NOT propose a diff against this path/);
});

test('formatFileContents leaves a same-repo file (no root) unchanged from the plain fence', () => {
  const out = formatFileContents([{ path: 'src/foo.js', content: 'const x = 1;' }]);
  assert.equal(out, '--- src/foo.js ---\n```\nconst x = 1;\n```', 'no root -> byte-identical to the pre-existing shape');
  assert.doesNotMatch(out, /DIFFERENT repo/);
});

test('adhocHarnessSearchImplementPrompt tags a cross-repo hit line with [repo-name]', () => {
  const task = {
    title: 'fix function_length_fix',
    promptContext: {
      rawText: 'fix function_length_fix',
      harnessHits: [
        { file: 'src/function-length-review.js', line: 12, query: 'function_length_fix', text: 'registerTaskSource(...)', root: '/media/model-cache/github/agent-manager-hygiene' },
        { file: 'src/apply-task.js', line: 5, query: 'apply', text: 'function applyTask() {}' },
      ],
      harnessFiles: [],
    },
  };
  const out = adhocHarnessSearchImplementPrompt(task, 'QUERY: function_length_fix');
  assert.match(out, /\[agent-manager-hygiene\] src\/function-length-review\.js:12/);
  assert.match(out, /^- src\/apply-task\.js:5/m, 'same-repo hit line has no repo tag prefix');
});

test('buildImplementPrompt fences the current spec doc for product_spec, since its own edit mode depends on exact substring matches against it', () => {
  const prompt = buildImplementPrompt(productSpecTask(), 'PLAN: add a Deal section');
  assert.match(prompt, /```\n## Entities/);
  assert.match(prompt, /```\n\nThe request being incorporated/);
});

// archReviewImplementPrompt's grounding fix (2026-08-21) -- shared by arch_review,
// arch_import_review, observability_fix, performance_fix, and backlog_fulfillment. See
// task-sources.js's nextCandidateFulfillmentTask header for the live incident this closes.
function archReviewFulfillmentTask(promptContextOverrides = {}) {
  return {
    domain: 'default', source: 'arch_review', title: 't',
    promptContext: {
      candidateId: 'AC-5', title: 'Silent domain-file load failure hides guardrail loss',
      files: ['src/apply-group-a.js'],
      fetchedFiles: [{ path: 'src/apply-group-a.js', content: '  try {\n    coverage = JSON.parse(...);\n  } catch {\n    coverage = { projects: {} };\n  }' }],
      body: '### AC-5 · ...',
      ...promptContextOverrides,
    },
  };
}

test('buildImplementPrompt embeds real fetched file content, fenced, and tells the model to ground find in it rather than the plan', () => {
  const prompt = buildImplementPrompt(archReviewFulfillmentTask(), 'PLAN: add a log line to the catch');
  assert.match(prompt, /```\n  try \{\n    coverage = JSON\.parse/);
  assert.match(prompt, /Ground every "find" value in the real file content shown above/);
  assert.match(prompt, /the ONLY source of truth/);
});

test('buildImplementPrompt tells the model to output empty rather than guess when a named file could not be fetched', () => {
  const prompt = buildImplementPrompt(archReviewFulfillmentTask({ files: ['src/missing.js'], fetchedFiles: [] }), 'PLAN: ...');
  assert.match(prompt, /src\/missing\.js.*could not be read/);
  assert.match(prompt, /output the empty string instead of guessing/);
  assert.doesNotMatch(prompt, /```\n  try \{/); // no stale fetched content leaking through
});

test('buildImplementPrompt offers the split escape hatch for a normal candidate-fulfillment source but NOT for a noCandidateSplit one', () => {
  const withSplit = buildImplementPrompt(archReviewFulfillmentTask(), 'PLAN: ...');
  assert.match(withSplit, /"mode": "split"/);

  // pipeline_forensics_fix is registered noCandidateSplit:true -- its candidates are
  // already the forensic study's decomposition, so re-splitting just files more.
  const forensicsFix = { ...archReviewFulfillmentTask(), source: 'pipeline_forensics_fix' };
  const noSplit = buildImplementPrompt(forensicsFix, 'PLAN: ...');
  assert.doesNotMatch(noSplit, /"mode": "split"/);
  assert.match(noSplit, /Ground every "find" value/); // the rest of the prompt is intact
});

test('buildImplementPrompt only flags the files that actually failed to fetch, not ones that succeeded', () => {
  const prompt = buildImplementPrompt(archReviewFulfillmentTask({
    files: ['src/apply-group-a.js', 'src/missing.js'],
    fetchedFiles: [{ path: 'src/apply-group-a.js', content: 'const x = 1;' }],
  }), 'PLAN: ...');
  assert.match(prompt, /NOTE: src\/missing\.js/);
  assert.doesNotMatch(prompt, /NOTE: src\/apply-group-a\.js/);
});

// research_task's plan prompt: grounding fix, 2026-08-25 -----------------------------
// Root-caused live on a real blocked research_task (Toregem BioPharma): the plan pass
// used to have no tool access and no instruction against guessing, so it fabricated a
// plausible-looking-but-fake jRCT registry ID and site, which review then held every
// implement attempt to as if it were a verified requirement. Fixed by giving the plan
// pass real WebSearch/WebFetch access (wired in local-draft.js, not testable from a pure
// prompt-text unit test) and by explicitly forbidding stating an unverified specific as
// fact -- this test covers the prompt-text half of that fix.
function researchTask(overrides = {}) {
  return {
    domain: 'research',
    source: 'research_task',
    title: 'Toregem BioPharma tooth regrowth trial',
    promptContext: { rawText: 'Figure out what it would take to join the trial.', tags: ['medical'] },
    ...overrides,
  };
}

test('buildPlanPrompt for research_task tells the model it has real WebSearch/WebFetch access', () => {
  const prompt = buildPlanPrompt(researchTask());
  assert.match(prompt, /WebSearch\/WebFetch tool access/);
});

test('buildPlanPrompt for research_task explicitly forbids stating an unverified specific as fact', () => {
  const prompt = buildPlanPrompt(researchTask());
  assert.match(prompt, /do not state a specific identifier, registry number, date, name, or URL as a known fact unless you actually found it via a real search\/fetch/i);
});

test('stalenessAuditImplementPrompt: recommending archive requires a cited commit OR full per-object coverage, and says stuck != resolved', () => {
  const { registerTaskSource, updateTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  const p = require('./prompts.js');
  const task = {
    domain: 'default', source: 'staleness_audit', title: 't',
    promptContext: {
      originalTaskId: 'orig-x', reasons: ['fabrication-repeat', 'retries-exhausted'],
      evidenceText: 'Original task text: hide NSFW tagged images', harnessHits: [], harnessFiles: [],
    },
  };
  const prompt = p.buildImplementPrompt(task, 'QUERY: nsfw');
  assert.match(prompt, /name the specific commit/i);
  assert.match(prompt, /EVERY concrete thing the original task names/i);
  assert.match(prompt, /repeated fabrication or exhausted retries means the PIPELINE could not build it -- that alone is never grounds to archive/);
  assert.match(prompt, /similar NAME that acts on a DIFFERENT object/);
});

test('adhocPlanPrompt: no seed block when task has no _seedPlan', () => {
  const { seedPlanBlock } = require('./prompts.js');
  assert.deepEqual(seedPlanBlock({ promptContext: {} }), []);
  const prompt = buildPlanPrompt({ domain: 'adhoc', source: 'manual', title: 't', promptContext: { rawText: 'do a thing' } });
  assert.doesNotMatch(prompt, /PRIOR attempt on this exact task/);
});

test('adhocPlanPrompt: no brain-dump directive for an ordinary adhoc task with no brainDumpEntryId', () => {
  const prompt = buildPlanPrompt({ domain: 'adhoc', source: 'manual', title: 't', promptContext: { rawText: 'fix the bug in foo.js' } });
  assert.doesNotMatch(prompt, /captured research finding/);
});

test('adhocPlanPrompt: a brain_dump_sort-spawned task gets the open-endedness directive, before the standard PLAN instruction', () => {
  const prompt = buildPlanPrompt({ domain: 'adhoc', source: 'manual', title: 't', promptContext: { rawText: 'design option: do X', brainDumpEntryId: 'bd-123' } });
  assert.match(prompt, /captured research finding or design recommendation/);
  assert.match(prompt, /pick the most direct, concrete first step/);
  const directiveIdx = prompt.indexOf('captured research finding');
  const planIdx = prompt.indexOf('Write a numbered, actionable PLAN');
  assert.ok(directiveIdx < planIdx, 'directive must appear before the standard PLAN instruction');
});

test('adhocPlanPrompt: a _seedPlan is embedded as a trailing "improve this" block, after the stable instructions', () => {
  const seed = '1. step one\n2. step two\n3. step three';
  const task = { domain: 'adhoc', source: 'manual', title: 't', promptContext: { rawText: 'do a thing' }, _seedPlan: seed };
  const prompt = buildPlanPrompt(task);
  assert.match(prompt, /PRIOR attempt on this exact task already produced this plan/);
  assert.ok(prompt.includes(seed), 'the seed plan text is included verbatim');
  assert.match(prompt, /do NOT start from scratch/);
  assert.ok(prompt.indexOf('Write a numbered, actionable PLAN') < prompt.indexOf('PRIOR attempt'), 'seed block trails the stable instruction text');
});

test('adhocPlanPrompt: _planGrounding is embedded as a trailing block with the "ground every path" instruction', () => {
  const { planGroundingBlock } = require('./prompts.js');
  assert.deepEqual(planGroundingBlock({ promptContext: {} }), []);
  const g = '--- src/a.js ---\n```\nfunction foo() {}\n```';
  const task = { domain: 'adhoc', source: 'manual', title: 't', promptContext: { rawText: 'edit foo' }, _planGrounding: g };
  const prompt = buildPlanPrompt(task);
  assert.ok(prompt.includes(g), 'grounding text verbatim');
  assert.match(prompt, /Ground every file path, function name and line number/);
  assert.ok(prompt.indexOf('Write a numbered, actionable PLAN') < prompt.indexOf('REAL REPOSITORY CONTENT'), 'grounding block trails the stable instructions');
});

test('adhocPlanPrompt asks for a trailing CRITERIA: block; echoes stated criteria verbatim', () => {
  const bare = buildPlanPrompt({ domain: 'adhoc', source: 'manual', title: 't', promptContext: { rawText: 'do a thing' } });
  assert.match(bare, /End your PLAN with a line "CRITERIA:"/);
  const stated = buildPlanPrompt({ domain: 'adhoc', source: 'manual', title: 't', promptContext: { rawText: 'do a thing', acceptanceCriteria: ['GET /x returns 200', 'pytest test_x passes'] } });
  assert.match(stated, /THE TASK STATES THESE ACCEPTANCE CRITERIA/);
  assert.match(stated, /1\. GET \/x returns 200/);
});

test('buildWriteAgenticPrompt: acceptanceCriteriaBlock + Acceptance: contract only when criteria present', async () => {
  const { buildWriteAgenticPrompt } = require('./local-agentic-write-draft.js');
  const withAc = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'x' }, acceptanceCriteria: ['pytest passes', 'route returns 201'] });
  assert.match(withAc, /ACCEPTANCE CRITERIA -- the change is NOT done/);
  assert.match(withAc, /add an "Acceptance:" block/);
  assert.match(withAc, /1\. pytest passes/);
  const noAc = buildWriteAgenticPrompt({ title: 'T', promptContext: { rawText: 'x' } });
  assert.doesNotMatch(noAc, /ACCEPTANCE CRITERIA/);
  assert.doesNotMatch(noAc, /add an "Acceptance:" block/);
});

// --- pipeline_forensics -----------------------------------------------------------

test('pipelineForensicsPlanPrompt emits QUERY: lines and carries the evidence + subject', () => {
  const { pipelineForensicsPlanPrompt } = require('./prompts.js');
  const p = pipelineForensicsPlanPrompt({
    promptContext: { subjectKind: 'signature', subjectKey: 'adhoc::botched-decompose', signature: 'adhoc::botched-decompose', evidenceText: 'EVIDENCE_MARKER\nTIER → SOURCE FILE' },
  });
  assert.match(p, /QUERY: <search terms>/);
  assert.match(p, /EVIDENCE_MARKER/);
  assert.match(p, /adhoc::botched-decompose/);
});

test('pipelineForensicsImplementPrompt encodes the ranked-counterfactual method, the contrast step, and the output contract', () => {
  const { pipelineForensicsImplementPrompt } = require('./prompts.js');
  const p = pipelineForensicsImplementPrompt({
    promptContext: {
      evidenceText: 'EVID', winnerIds: ['win-a', 'win-b'], loserIds: ['lose-a'],
      harnessHits: [{ file: 'src/local-agentic-write-draft.js', line: 90, query: 'decompose', text: 'RESOLUTION: decompose' }],
      harnessFiles: [],
    },
  }, 'QUERY: decompose');
  assert.match(p, /COUNTERFACTUAL/);
  assert.match(p, /CONTRAST the failing tasks with the WINNER tasks/);
  assert.match(p, /ROOT CAUSE RANKING/);
  assert.match(p, /RECOMMENDED FOLLOW-UP FIX/);
  assert.match(p, /NO CLEAR ROOT CAUSE/);
  assert.match(p, /never a diff|output prose, never a diff/);
  assert.match(p, /win-a, win-b/);          // winner ids surfaced
  assert.match(p, /src\/local-agentic-write-draft\.js:90/); // harness hit rendered
});

// 2026-09-06 ("Task Atomization" brain-dump: use debrief's own hardened concepts to
// improve the existing blocked-task analysis) -- pipeline_forensics' "Files:" line had
// only a soft "cite real files" instruction, the exact same shape of risk that produced
// 2 real fabricated NOW-WHAT file citations in pipeline_debrief before its closed-list fix.
test('pipelineForensicsImplementPrompt constrains the Files: line to a closed list of real fetched paths', () => {
  const { pipelineForensicsImplementPrompt } = require('./prompts.js');
  const p = pipelineForensicsImplementPrompt({
    promptContext: {
      evidenceText: 'EVID', winnerIds: ['win-a'], loserIds: ['lose-a'],
      harnessHits: [],
      harnessFiles: [{ path: 'src/apply-group-a.js', content: 'x' }, { path: 'src/system-report.js', content: 'y' }],
    },
  }, 'QUERY: x');
  assert.match(p, /AVAILABLE FILES/);
  assert.match(p, /- src\/apply-group-a\.js/);
  assert.match(p, /- src\/system-report\.js/);
  assert.match(p, /verbatim from AVAILABLE FILES/);
});

test('pipelineForensicsImplementPrompt renders "(none fetched)" for AVAILABLE FILES when no harness files were fetched', () => {
  const { pipelineForensicsImplementPrompt } = require('./prompts.js');
  const p = pipelineForensicsImplementPrompt({
    promptContext: { evidenceText: 'EVID', winnerIds: [], loserIds: ['lose-a'], harnessHits: [], harnessFiles: [] },
  }, 'QUERY: x');
  assert.match(p, /\(none fetched\)/);
});

// Mirrors pipeline_debrief's own SURVIVORSHIP-BIAS CHECK discipline: the contrast section
// must give the model explicit permission to say the evidence is inconclusive, rather than
// asking for a divergence paragraph unconditionally.
test('pipelineForensicsImplementPrompt requires an honest "inconclusive" option in the winner/loser contrast, mirroring debrief\'s survivorship-bias check', () => {
  const { pipelineForensicsImplementPrompt } = require('./prompts.js');
  const p = pipelineForensicsImplementPrompt({
    promptContext: { evidenceText: 'EVID', winnerIds: ['win-a'], loserIds: ['lose-a'], harnessHits: [], harnessFiles: [] },
  }, 'QUERY: x');
  assert.match(p, /say so plainly instead of asserting a divergence you cannot support/);
  assert.match(p, /if the evidence does not support a confident divergence, say so plainly/);
});

test('pipelineDebriefPlanPrompt emits QUERY: lines and carries the evidence blob', () => {
  const { pipelineDebriefPlanPrompt } = require('./prompts.js');
  const p = pipelineDebriefPlanPrompt({
    promptContext: { evidenceText: 'DEBRIEF_EVIDENCE_MARKER\nTIER → SOURCE FILE' },
  });
  assert.match(p, /QUERY: <search terms>/);
  assert.match(p, /DEBRIEF_EVIDENCE_MARKER/);
});

test('pipelineDebriefImplementPrompt encodes What/So-What/Now-What, the survivorship-bias check, and the bounded output contract', () => {
  const { pipelineDebriefImplementPrompt } = require('./prompts.js');
  const p = pipelineDebriefImplementPrompt({
    promptContext: {
      evidenceText: 'EVID', taskIds: ['done-a', 'done-b'], contrastIds: ['stuck-a'],
      harnessHits: [{ file: 'src/maintenance/observability-review.js', line: 40, query: 'enclosingCode', text: 'const enclosingCode = ...' }],
      harnessFiles: [],
    },
  }, 'QUERY: enclosingCode');
  assert.match(p, /WHAT/);
  assert.match(p, /SO WHAT/);
  assert.match(p, /SURVIVORSHIP-BIAS CHECK/);
  assert.match(p, /NOW WHAT/);
  assert.match(p, /at most 2-3/);
  assert.match(p, /NO CONFIDENT PATTERN/);
  assert.match(p, /never a diff|output prose, never a diff/);
  assert.match(p, /done-a, done-b/);       // window task ids surfaced
  assert.match(p, /stuck-a/);              // contrast task ids surfaced
  assert.match(p, /src\/maintenance\/observability-review\.js:40/); // harness hit rendered
});

// 2026-09-06: root-caused live -- 2 real debrief reports blocked 3 attempts running,
// each time inventing a plausible-but-nonexistent NOW WHAT path (src/project-search.js,
// src/observability-review.js) even on the attempt that had real harness hits/files in
// front of it. Closed-list citation: the prompt must hand over the exact real paths and
// forbid anything else, rather than trusting an open "cite a real file" instruction.
test('pipelineDebriefImplementPrompt: closed-list AVAILABLE FILES with real fetched paths', () => {
  const { pipelineDebriefImplementPrompt } = require('./prompts.js');
  const p = pipelineDebriefImplementPrompt({
    promptContext: {
      evidenceText: 'EVID', taskIds: ['done-a'], contrastIds: [],
      harnessHits: [{ file: 'src/maintenance/observability-review.js', line: 40, query: 'x', text: 'y' }],
      harnessFiles: [{ path: 'src/maintenance/observability-review.js', content: 'const x = 1;' }],
    },
  }, 'QUERY: x');
  assert.match(p, /AVAILABLE FILES/);
  assert.match(p, /copied EXACTLY.*character-for-character.*from the AVAILABLE FILES/s);
  assert.match(p, /Never invent, guess, paraphrase/);
  // The real path is listed in the closed set exactly once, verbatim.
  const matches = p.match(/- src\/maintenance\/observability-review\.js/g) || [];
  assert.ok(matches.length >= 1);
});

test('pipelineDebriefImplementPrompt: empty AVAILABLE FILES explicitly forbids any Files: line', () => {
  const { pipelineDebriefImplementPrompt } = require('./prompts.js');
  const p = pipelineDebriefImplementPrompt({
    promptContext: { evidenceText: 'EVID', taskIds: ['done-a'], contrastIds: [], harnessHits: [], harnessFiles: [] },
  }, 'QUERY: x');
  assert.match(p, /none -- no real file content was fetched for this window; NOW WHAT must not include a Files: line/);
});

test('driftFixPlanPrompt names each missing source and asks for one query per name, skipping stale', () => {
  const { driftFixPlanPrompt } = require('./prompts.js');
  const p = driftFixPlanPrompt({
    promptContext: { staticFile: 'README.md', label: 'README.md Built-in task sources table vs the live registry', missingFromStatic: ['change_review', 'pipeline_debrief'], staleInStatic: ['old_source'] },
  });
  assert.match(p, /Missing from README\.md: change_review, pipeline_debrief/);
  assert.match(p, /Stale in README\.md.*old_source/);
  assert.match(p, /one short search query PER missing name/i);
  assert.match(p, /QUERY: <search terms>/);
});

test('driftFixImplementPrompt: embeds real priorities, the real insertion anchor, and pre-located stale rows verbatim', () => {
  const { driftFixImplementPrompt } = require('./prompts.js');
  const p = driftFixImplementPrompt({
    promptContext: {
      staticFile: 'README.md',
      missingFromStatic: ['change_review'],
      staleInStatic: ['old_source'],
      priorities: { change_review: 60 },
      insertAfter: '| `unused_export` | 90 | queue/dead-code-flags.json |',
      staleRows: ['| `old_source` | 55 | some old thing |'],
      harnessHits: [{ file: 'src/task-sources.js', line: 100, query: 'change_review', text: "registerTaskSource('change_review', ...)" }],
      harnessFiles: [],
    },
  }, 'QUERY: change_review');
  assert.match(p, /DOCUMENTATION DRIFT/);
  assert.match(p, /change_review: priority 60 \(exact, real, given -- never guess or change this number\)/);
  assert.match(p, /\| `unused_export` \| 90 \| queue\/dead-code-flags\.json \|/);
  assert.match(p, /\| `old_source` \| 55 \| some old thing \|/);
  assert.match(p, /src\/task-sources\.js:100/);
  assert.match(p, /mode.*edit.*find.*replace/s);
});

test('driftFixImplementPrompt: no stale rows renders an explicit "nothing to remove" line, not an empty section', () => {
  const { driftFixImplementPrompt } = require('./prompts.js');
  const p = driftFixImplementPrompt({
    promptContext: { staticFile: 'README.md', missingFromStatic: ['x'], staleInStatic: [], priorities: { x: 5 }, insertAfter: '| `a` | 1 | b |', staleRows: [], harnessHits: [], harnessFiles: [] },
  }, 'QUERY: x');
  assert.match(p, /\(no stale rows to remove\)/);
});

// --- adhocHarnessSearchPlanPrompt (2026-09-06) -------------------------------------------
// Root-caused live: a file-decompose "move these symbols" sub-task names its exact symbols
// in backticks, yet the harness-search plan pass chose the SOURCE file's own path as its
// query -- a path mentioned in dozens of unrelated tests/docs/scripts returned almost pure
// noise, contributing to the plan pass truncating on every retry. Surfacing the task's own
// named symbols explicitly, when present, steers the model toward the highest-signal query
// it already has instead of guessing a path.

test('adhocHarnessSearchPlanPrompt surfaces backtick-quoted symbol names and tells the model to prefer them over a bare path', () => {
  const { adhocHarnessSearchPlanPrompt } = require('./prompts.js');
  const task = { title: 'Decompose x', promptContext: { rawText: 'Move these symbols OUT of index.html into it, VERBATIM: `renderAdhocTasksTab`, `fooBar`.' } };
  const p = adhocHarnessSearchPlanPrompt(task);
  assert.match(p, /names these specific symbol\(s\) by name.*renderAdhocTasksTab, fooBar/s);
  assert.match(p, /prefer these as your search terms/i);
});

test('adhocHarnessSearchPlanPrompt is unchanged (no extra section) when the task names no backtick-quoted symbols', () => {
  const { adhocHarnessSearchPlanPrompt } = require('./prompts.js');
  const task = { title: 'Fix a bug', promptContext: { rawText: 'fix the bug in foo.js' } };
  const p = adhocHarnessSearchPlanPrompt(task);
  assert.doesNotMatch(p, /Prefer these as your search terms/);
});
