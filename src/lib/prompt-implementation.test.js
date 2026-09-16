'use strict';

// Regression test for the requiresResearch field's own instruction text (2026-09-16):
// root-caused live via 2 real stuck research_task tasks -- both were internal-repo
// verification notes ("confirm this config default", "confirm a truncated task ID"),
// misclassified requiresResearch:true by the (weak, cheap) brain_dump_sort classifier
// because the old wording ("web search, reading real sources") never distinguished
// EXTERNAL sources from this repo's own code/config/queue state. research_task requires
// the Claude Code CLI (WebSearch/WebFetch), which is not guaranteed enabled on every
// deployment -- a false positive here can strand a note that an ordinary adhoc task's own
// local grep/harness-search grounding could have resolved directly, with no web access at
// all. This only asserts the INSTRUCTION TEXT, not the classifier's real judgment (that's
// still a local-model call, out of scope for a deterministic test) -- the goal is just to
// make sure a future edit can't silently drop the external-vs-internal distinction again.

const test = require('node:test');
const assert = require('node:assert/strict');

const { brainDumpSortImplementPrompt } = require('./prompt-implementation.js');

function promptText() {
  return brainDumpSortImplementPrompt({ promptContext: { rawText: 'a test note' } }, 'plan text');
}

test('brainDumpSortImplementPrompt: requiresResearch instruction explicitly requires EXTERNAL sources, not just "real sources"', () => {
  const text = promptText();
  assert.match(text, /requiresResearch/);
  assert.match(text, /EXTERNAL sources/i, 'must say EXTERNAL, not just "real sources" -- the old wording\'s exact ambiguity');
});

test('brainDumpSortImplementPrompt: requiresResearch instruction explicitly excludes this repo\'s own code/config/queue verification', () => {
  const text = promptText();
  assert.match(text, /never true for a note that just needs THIS repo.s own code, config, or queue state/i);
});

test('brainDumpSortImplementPrompt: requiresResearch instruction warns that research_task may not have web access on every deployment', () => {
  const text = promptText();
  assert.match(text, /research_task tasks are NOT guaranteed to have web access enabled/i);
});
