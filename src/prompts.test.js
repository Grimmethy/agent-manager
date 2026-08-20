'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const { buildCritiquePrompt, buildPlanPrompt, buildImplementPrompt } = require('./prompts.js');

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
