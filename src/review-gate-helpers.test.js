'use strict';

// review-gate-helpers.js: helpers the deterministic review gates use (P6.4a). review-task.js must keep exporting the same functions.

process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR || require('node:os').tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const helpers = require('./review-gate-helpers.js');
const reviewTask = require('./review-task.js');
const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');

test('review-task.js still exports the helpers it exported before the move, as the same functions', () => {
  for (const name of ['NON_IMPL_PATTERNS', 'namesExtractedPieces', 'verifyDeterministicScriptExtractDraft', 'verifyDeterministicOnePassDecomposeDraft']) {
    assert.equal(reviewTask[name], helpers[name], name);
  }
});

test('isEmptyApprovalSource and isAdvisoryProseSource read the source registration flags', () => {
  clearRegistry();
  registerTaskSource('gh_empty', { priority: 5, next: () => null, emptyApproval: true });
  registerTaskSource('gh_prose', { priority: 5, next: () => null, advisoryProse: true });
  registerTaskSource('gh_plain', { priority: 5, next: () => null });
  assert.equal(helpers.isEmptyApprovalSource('gh_empty'), true);
  assert.equal(helpers.isEmptyApprovalSource('gh_prose'), false);
  assert.equal(helpers.isAdvisoryProseSource('gh_prose'), true);
  assert.equal(helpers.isAdvisoryProseSource('gh_plain'), false);
  assert.equal(helpers.isEmptyApprovalSource('gh_unknown'), false);
  clearRegistry();
});

test('isEffectivelyEmpty accepts nothing, an empty JSON string, and nothing else', () => {
  assert.equal(helpers.isEffectivelyEmpty(''), true);
  assert.equal(helpers.isEffectivelyEmpty('""'), true);
  assert.equal(helpers.isEffectivelyEmpty("''"), true);
  assert.equal(helpers.isEffectivelyEmpty('x'), false);
});

test('NON_IMPL_PATTERNS match a "let me read" meta-comment and not a diff', () => {
  const hit = (t) => helpers.NON_IMPL_PATTERNS.some((p) => p.test(t));
  assert.equal(hit("Let me read the file first"), true);
  assert.equal(hit('diff --git a/x b/x'), false);
});

test('decodeGroupBContent joins content, find and replace of an edit set and gives "" for non-JSON', () => {
  const text = JSON.stringify([{ mode: 'create', file: 'a.js', content: 'CONTENT' }, { mode: 'edit', file: 'b.js', find: 'FIND', replace: 'REPL' }]);
  assert.equal(helpers.decodeGroupBContent(text), 'CONTENT\n \nFIND\n \nREPL');
  assert.equal(helpers.decodeGroupBContent('not json'), '');
});

test('namesExtractedPieces needs two longer snake or camel case names in the Solution paragraph', () => {
  assert.equal(helpers.namesExtractedPieces('Solution: extract parse_header and buildFooter into helpers\n\nBenefits: x'), true);
  assert.equal(helpers.namesExtractedPieces('Solution: extract parse_header only\n\nBenefits: x'), false);
  assert.equal(helpers.namesExtractedPieces(''), false);
});

test('verifyDeterministic* hooks dispatch to the registered verifier only for their own deterministicApply kinds', () => {
  const reg = require('./decompose-review-registry.js');
  const saved = [];
  for (const kind of ['script-extract', 'one-pass-decompose', 'node-module-decompose', 'blueprint-decompose', 'something-else']) {
    reg.registerDeterministicReview(kind, { verify: (task, root, ref) => ({ ok: true, kind, root, ref }) });
    saved.push(kind);
  }
  try {
    const t = (kind) => ({ promptContext: { deterministicApply: kind } });
    assert.equal(helpers.verifyDeterministicScriptExtractDraft(t('script-extract'), '/r', 'refX').ref, 'refX');
    assert.equal(helpers.verifyDeterministicScriptExtractDraft(t('one-pass-decompose'), '/r', null), null);
    assert.equal(helpers.verifyDeterministicScriptExtractDraft({}, '/r', null), null);
    for (const kind of ['one-pass-decompose', 'node-module-decompose', 'blueprint-decompose']) {
      assert.equal(helpers.verifyDeterministicOnePassDecomposeDraft(t(kind), '/r').kind, kind);
    }
    assert.equal(helpers.verifyDeterministicOnePassDecomposeDraft(t('script-extract'), '/r'), null);
    assert.equal(helpers.verifyDeterministicOnePassDecomposeDraft(t('something-else'), '/r'), null);
    assert.equal(helpers.verifyDeterministicOnePassDecomposeDraft({}, '/r'), null);
  } finally { reg.clearDeterministicReviewRegistry(); }
});

test('validateRelocatedDraftSymbols keeps a symbol found nowhere, and forgives one present in the frozen window or the draft file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-helpers-'));
  fs.writeFileSync(path.join(root, 'frozen.js'), 'const old = 1;\n');
  fs.writeFileSync(path.join(root, 'moved.js'), 'const MOVED_SYMBOL = 2;\n');
  const diff = 'diff --git a/moved.js b/moved.js\n--- a/moved.js\n+++ b/moved.js\n@@ -1 +1 @@\n-x\n+y\n';
  const task = { rawDiff: diff, promptContext: { fetchedFiles: [{ path: 'frozen.js', context: 'window text WINDOW_SYMBOL' }] } };
  const flags = [{ type: 'ungrounded-field', detail: 'MOVED_SYMBOL' }, { type: 'ungrounded-field', detail: 'WINDOW_SYMBOL' }, { type: 'ungrounded-field', detail: 'NOWHERE_SYMBOL' }, { type: 'ungrounded-url' }];
  const out = helpers.validateRelocatedDraftSymbols(task, flags, root);
  assert.deepEqual(out.validated.map((v) => v.symbol).sort(), ['MOVED_SYMBOL', 'WINDOW_SYMBOL']);
  assert.equal(out.validated.find((v) => v.symbol === 'MOVED_SYMBOL').draftFile, 'moved.js');
  assert.deepEqual(out.remaining.map((f) => f.detail), ['NOWHERE_SYMBOL', undefined]);
});

test('the helpers module does not require review-task.js (no import cycle)', () => {
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/review-gate-helpers.js'].includes('src/review-task.js'), false);
});
