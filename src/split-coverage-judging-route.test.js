'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  originalAskInjectionLines,
  coverageGuidanceOverride,
  completenessQuestionOverride,
  getSplitCoverageJudging,
  setSplitCoverageJudging,
  DEFAULT_SPLIT_COVERAGE_JUDGING,
} = require('./split-coverage-judging-route.js');

test('originalAskInjectionLines: empty when not a split proposal', () => {
  const out = originalAskInjectionLines({ promptContext: { rawText: 'do the thing' } }, false);
  assert.deepEqual(out, []);
});

test('originalAskInjectionLines: empty when a split proposal but no original ask text', () => {
  const out = originalAskInjectionLines({ promptContext: {} }, true);
  assert.deepEqual(out, []);
});

test('originalAskInjectionLines: injects the full rawText when a split proposal', () => {
  const out = originalAskInjectionLines({ promptContext: { rawText: 'build the plugin catalog and endpoints' } }, true);
  assert.equal(out.length, 3);
  assert.equal(out[0], '');
  assert.match(out[1], /ORIGINAL REQUEST/);
  assert.equal(out[2], 'build the plugin catalog and endpoints');
});

test('originalAskInjectionLines: falls back to promptContext.body when rawText is absent', () => {
  const out = originalAskInjectionLines({ promptContext: { body: 'Files: src/a.js' } }, true);
  assert.equal(out[2], 'Files: src/a.js');
});

test('originalAskInjectionLines: truncates past 8000 chars with a marker', () => {
  const longAsk = 'x'.repeat(9000);
  const out = originalAskInjectionLines({ promptContext: { rawText: longAsk } }, true);
  assert.ok(out[2].endsWith('...[truncated]'));
  assert.equal(out[2].length, 8000 + '\n...[truncated]'.length);
});

test('coverageGuidanceOverride: null when the task has no candidateSplitProposals', () => {
  assert.equal(coverageGuidanceOverride({}), null);
  assert.equal(coverageGuidanceOverride({ adhocResolution: 'decompose', subTaskProposals: [1, 2] }), null);
});

test('coverageGuidanceOverride: the coverage-judging text when candidateSplitProposals is present', () => {
  const out = coverageGuidanceOverride({ candidateSplitProposals: [{ title: 'a' }, { title: 'b' }] });
  assert.match(out, /COVERAGE IS THE MAIN TEST/);
  assert.match(out, /deliberately no code or diff here, and that is NOT a reason to reject/);
});

test('completenessQuestionOverride: null when the task has no candidateSplitProposals', () => {
  assert.equal(completenessQuestionOverride({}), null);
});

test('completenessQuestionOverride: the split-specific question when candidateSplitProposals is present', () => {
  const out = completenessQuestionOverride({ candidateSplitProposals: [{ title: 'a' }, { title: 'b' }] });
  assert.match(out, /well-formed JSON array of sub-candidates/);
});

test('getSplitCoverageJudging/setSplitCoverageJudging: a single overridable swap point, resettable to the default', () => {
  assert.equal(getSplitCoverageJudging(), DEFAULT_SPLIT_COVERAGE_JUDGING);
  const fake = { originalAskInjectionLines: () => [], coverageGuidanceOverride: () => null, completenessQuestionOverride: () => null };
  setSplitCoverageJudging(fake);
  assert.equal(getSplitCoverageJudging(), fake);
  setSplitCoverageJudging(null);
  assert.equal(getSplitCoverageJudging(), DEFAULT_SPLIT_COVERAGE_JUDGING);
});
