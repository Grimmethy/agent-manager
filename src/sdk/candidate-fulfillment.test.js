'use strict';

// Unit coverage for the confidence-aware anchoring added 2026-09-05 (context-trim-sweep
// plan): windowFetchedFileContent now returns { text, confidence, anchorCount,
// usedSnippetFuzzyMatch } instead of a bare string, and a too-generic (>MAX_ANCHOR_
// OCCURRENCES) symbol is demoted to a weak rank-3 fallback instead of being dropped
// entirely. See src/task-sources.test.js's much larger pre-existing windowFetchedFileContent
// suite (re-exported via task-sources.js) for the original anchor-selection behavior this
// builds on -- this file covers only the NEW confidence-tier surface.

const assert = require('assert/strict');
const { test } = require('node:test');
const { windowFetchedFileContent, collectAnchorHits } = require('./candidate-fulfillment.js');

test('windowFetchedFileContent: content under the cap is returned unchanged with strong confidence', () => {
  const content = 'small content, well under the cap';
  const result = windowFetchedFileContent(content, 'Problem:\n`whatever`', 2000);
  assert.equal(result.text, content);
  assert.equal(result.confidence, 'strong');
});

test('windowFetchedFileContent: a real quoted-symbol anchor yields strong confidence, no low-confidence marker', () => {
  const padding = 'x'.repeat(9000);
  const content = `${padding}\nfunction realTarget() { return 1; }\n${padding}`;
  const section = 'Problem:\nThe `realTarget` function has a bug.\n\nSolution:\nFix it.';

  const result = windowFetchedFileContent(content, section, 2000);

  assert.equal(result.confidence, 'strong');
  assert.equal(result.usedSnippetFuzzyMatch, false);
  assert.match(result.text, /realTarget/);
  assert.doesNotMatch(result.text, /LOW-CONFIDENCE GROUNDING/);
});

test('windowFetchedFileContent: a fuzzy-matched Snippet: field yields strong confidence with usedSnippetFuzzyMatch true', () => {
  const padding = 'x'.repeat(9000);
  const content = `${padding}\nfunction realTarget() { return 1; }\n${padding}`;
  const section = [
    'Files: foo.js',
    'Snippet:',
    '```',
    'function realTarget() { return 1; }',
    '```',
    '',
    'Problem:\nSomething paraphrased and unhelpful.',
  ].join('\n');

  const result = windowFetchedFileContent(content, section, 2000);

  assert.equal(result.confidence, 'strong');
  assert.equal(result.usedSnippetFuzzyMatch, true);
});

test('windowFetchedFileContent: a symbol occurring more than MAX_ANCHOR_OCCURRENCES times falls back to a single weak window instead of being dropped', () => {
  // 30 occurrences of `result` (too generic) plus one real, specific symbol elsewhere in
  // the file that the candidate does NOT quote -- so the only anchor available is the
  // over-common one, and it must still produce a targeted (non-flat-truncated) window.
  const noisyLine = 'const result = compute();\n';
  const content = noisyLine.repeat(400) + 'function neverQuoted() {}\n';
  const section = 'Solution:\nFix how `result` is handled throughout.';

  const result = windowFetchedFileContent(content, section, 2000);

  assert.equal(result.confidence, 'weak');
  assert.equal(result.anchorCount, 1);
  assert.equal(result.usedSnippetFuzzyMatch, false);
  assert.match(result.text, /LOW-CONFIDENCE GROUNDING/);
  assert.match(result.text, /result = compute/, 'the weak fallback must still center on the (over-common) anchor, not byte 0');
});

test('windowFetchedFileContent: zero anchors at all falls back to flat truncation with confidence "none" and the low-confidence marker', () => {
  const content = `start-marker\n${'x'.repeat(9000)}`;
  const section = 'Problem:\nSomething about `aSymbolThatIsNotInTheFile`.\n\nSolution:\nFix it.';

  const result = windowFetchedFileContent(content, section, 2000);

  assert.equal(result.confidence, 'none');
  assert.equal(result.anchorCount, 0);
  assert.match(result.text, /start-marker/);
  assert.match(result.text, /LOW-CONFIDENCE GROUNDING/);
});

// Direct regression test for observability-fix-ac-111 (2026-09-04): the frozen Snippet
// referenced a function that no longer exists, and every other candidate symbol occurred
// more than MAX_ANCHOR_OCCURRENCES times in the real file -- before this fix, ALL of them
// were dropped, leaving only unrelated/false-positive matches spread across the whole
// budget as if confident. After this fix, a too-common symbol still anchors (weakly) and
// is never treated as confident enough to justify the multi-region path.
test('windowFetchedFileContent: AC-111 regression -- stale Snippet + all-too-common symbols degrade to weak, not silent false confidence', () => {
  const commonLine = 'logger.info("noop")\n';
  const content = commonLine.repeat(50)
    + 'def handle_request():\n    pass\n'
    + commonLine.repeat(50);
  const section = [
    'Files: app.py',
    'Snippet:',
    '```',
    'def _reports_root():\n    return ROOT', // no longer exists in `content`
    '```',
    '',
    'Problem:\nThe `logger.info` calls in handle_request swallow real errors.',
    '\nSolution:\nFix it.',
  ].join('\n');

  const result = windowFetchedFileContent(content, section, 1000);

  assert.equal(result.usedSnippetFuzzyMatch, false, 'the stale Snippet must not fuzzy-match the current file');
  assert.equal(result.confidence, 'weak');
  assert.equal(result.anchorCount, 1, 'only ONE weak anchor, never a multi-region spread across too-common hits');
  assert.match(result.text, /LOW-CONFIDENCE GROUNDING/);
});

test('collectAnchorHits: a too-common symbol is still returned (rank 3), not dropped outright', () => {
  const content = Array.from({ length: 30 }, () => 'const result = get();').join('\n') + '\nfunction theOneThing() {}\n';
  const hits = collectAnchorHits(content, 'Solution:\nfix `result` handling in `theOneThing`.');

  const resultHit = hits.find((h) => content.slice(h.index).startsWith('result'));
  assert.ok(resultHit, '`result` must still appear as SOME hit (rank 3), not be dropped entirely');
  assert.equal(resultHit.rank, 3);

  const theOneThingHit = hits.find((h) => content.slice(h.index).startsWith('theOneThing'));
  assert.ok(theOneThingHit);
  assert.equal(theOneThingHit.rank, 1);
});
