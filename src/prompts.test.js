'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const { buildCritiquePrompt, buildPlanPrompt, buildImplementPrompt, formatFileContents } = require('./prompts.js');

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
