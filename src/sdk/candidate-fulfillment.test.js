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

// ---- long quoted code + file tail anchors (2026-10-04, arch-review-ac-42) ----------------------------------------------------------------------------------------------
// The drafter was shown 6943 of 15614 chars (confidence 'strong') and never the file's last statement, which the candidate quoted flattened onto one line and which the file
// lays out over several. A backtick span > 80 chars is now an anchor (rank 0.5, whitespace-insensitive), and a tail cue adds an end-of-file anchor that only ever sits NEXT TO a real anchor.
const pad = (n) => 'x'.repeat(n);
const SYMBOLS = ['alphaOne', 'betaTwo', 'gammaThree', 'deltaFour', 'epsilonFive'];
const EARLY = SYMBOLS.map((s) => `${pad(600)}\nfunction ${s}() {}\n`).join('');
const TAIL_STMT = "run()\n  .catch((e) => { console.error('FAILED:', e); process.exitCode = 1; })\n  .finally(async () => { await db.close(); });\n";
const TAIL_QUOTE = "`run().catch((e) => { console.error('FAILED:', e); process.exitCode = 1; }).finally(async () => { await db.close(); })`";
const LONG_FILE = EARLY + pad(9000) + '\n' + TAIL_STMT;

test('windowFetchedFileContent: a long quoted statement near the END of the file is inside the window next to five early symbol anchors (the AC-42 shape)', () => {
  const section = `Problem:\nThe file uses ${SYMBOLS.map((s) => `\`${s}\``).join(', ')} and calls ${TAIL_QUOTE} unconditionally.`;
  const result = windowFetchedFileContent(LONG_FILE, section, 3000);
  assert.equal(result.confidence, 'strong');
  assert.match(result.text, /\.finally\(async \(\) => \{ await db\.close\(\); \}\);/, 'the quoted statement, laid out over several lines in the file, must be in the window');
  assert.match(result.text, /function alphaOne/, 'the earlier regions must still be shown');
  const without = windowFetchedFileContent(LONG_FILE, `Problem:\nThe file uses ${SYMBOLS.map((s) => `\`${s}\``).join(', ')}.`, 3000);
  assert.doesNotMatch(without.text, /await db\.close/, 'sanity: without the quoted statement the window misses the tail (the bug)');
});

test('windowFetchedFileContent: a tail cue with a real anchor also shows the last lines of the file', () => {
  const content = `${pad(600)}\nfunction alphaOne() {}\n${pad(9000)}\nfinalCall();\n`;
  const result = windowFetchedFileContent(content, 'Problem:\nThe file ends with an unconditional call. The `alphaOne` helper is wrong.', 3000);
  assert.equal(result.confidence, 'strong');
  assert.match(result.text, /finalCall\(\);/);
  assert.match(result.text, /function alphaOne/);
  const noCue = windowFetchedFileContent(content, 'Problem:\nThe `alphaOne` helper is wrong.', 3000);
  assert.doesNotMatch(noCue.text, /finalCall/, 'sanity: without the cue the tail is not shown');
});

test('windowFetchedFileContent: a tail cue with NO real anchor creates no confidence -- still the flat truncation, confidence none, with the low-confidence marker', () => {
  const content = `${pad(9000)}\nfinalCall();\n${pad(500)}`;
  const result = windowFetchedFileContent(content, 'Problem:\nThe file ends with an unconditional call.', 2000);
  assert.equal(result.confidence, 'none');
  assert.equal(result.anchorCount, 0);
  assert.match(result.text, /^\[LOW-CONFIDENCE GROUNDING/);
  assert.doesNotMatch(result.text, /finalCall/);
});

test('windowFetchedFileContent: a section with neither a long quoted span nor a tail cue gets exactly the single window it always did', () => {
  const content = `${pad(9000)}\nfunction realTarget() {}\n${pad(9000)}\nfinalCall();\n`;
  const result = windowFetchedFileContent(content, 'Problem:\nThe `realTarget` function has a bug.', 2000);
  const idx = content.indexOf('realTarget');
  const expected = `...[truncated]...\n${content.slice(Math.max(0, idx - 1000), idx + 'realTarget'.length + 1000)}\n...[truncated]`;
  assert.equal(result.text, expected);
  assert.equal(result.confidence, 'strong');
  assert.equal(result.anchorCount, 1);
});

test('windowFetchedFileContent: a long quoted span whose prefix occurs more than MAX_ANCHOR_OCCURRENCES times is ignored, not used as a fallback', () => {
  const content = `${EARLY}${(`${pad(700)}\n${TAIL_STMT}`).repeat(7)}`;
  const base = `Problem:\nThe file uses \`alphaOne\` and \`betaTwo\``;
  const withSpan = windowFetchedFileContent(content, `${base} and calls ${TAIL_QUOTE}.`, 3000);
  const withoutSpan = windowFetchedFileContent(content, `${base}.`, 3000);
  assert.deepEqual(withSpan, withoutSpan);
});

test('windowFetchedFileContent: a long-span anchor is rank 0.5 and never sets usedSnippetFuzzyMatch, while a real Snippet match still does', () => {
  const section = `Problem:\nThe file calls ${TAIL_QUOTE} unconditionally.`;
  const hits = collectAnchorHits(LONG_FILE, section);
  const spanHit = hits.find((h) => LONG_FILE.slice(h.index).replace(/\s+/g, '').startsWith('run().catch('));
  assert.ok(spanHit, 'the quoted statement must produce a hit');
  assert.equal(spanHit.rank, 0.5);
  assert.equal(windowFetchedFileContent(LONG_FILE, section, 3000).usedSnippetFuzzyMatch, false);

  const withSnippet = `Files: x.js\nSnippet:\n\`\`\`\nfunction alphaOne() {}\n\`\`\`\n\n${section}`;
  assert.equal(windowFetchedFileContent(LONG_FILE, withSnippet, 3000).usedSnippetFuzzyMatch, true);
});

test('windowFetchedFileContent: a tail cue next to FIVE symbol anchors still shows the file end (the tail hit is not the one the region cap drops)', () => {
  const content = EARLY + pad(9000) + '\nfinalCall();\n';
  const section = `Problem:\nThe file uses ${SYMBOLS.map((s) => `\`${s}\``).join(', ')} and the file ends with an unconditional call.`;
  const result = windowFetchedFileContent(content, section, 3000);
  assert.equal(result.confidence, 'strong');
  assert.match(result.text, /finalCall\(\);/);
  assert.match(result.text, /function alphaOne/);
});

test('windowFetchedFileContent: ordinary prose ("last line read", "ends with", "trailing") is NOT a tail cue', () => {
  const content = EARLY + pad(9000) + '\nfinalCall();\n';
  const syms = SYMBOLS.map((s) => `\`${s}\``).join(', ');
  const plain = windowFetchedFileContent(content, `Problem:\nThe file uses ${syms}.`, 3000);
  for (const prose of ['bounds the gap between last line read and process reaped', 'a string that ends with a slash', 'remove the trailing quote on line 208']) {
    const result = windowFetchedFileContent(content, `Problem:\nThe file uses ${syms}; it ${prose}.`, 3000);
    assert.deepEqual(result, plain, `"${prose}" must not add an end-of-file region`);
  }
});

// The 'weak partial' branch (a Snippet whose only match is under 30% of it) must ignore a tail hit: a cue next to a guess is still a guess. Pins strongHits -> realStrongHits.
test('windowFetchedFileContent: a weak partial Snippet match plus a tail cue stays weak -- the cue neither upgrades it nor adds a region', () => {
  const head = 'function distinctiveHeadOne(alpha, beta) { const gammaValue = alpha * beta + computeSomethingUnusual(alpha); return gammaValue; }\n'
    + 'function distinctiveHeadTwo(delta) { return delta.map((x) => x * transformFactorOne).filter(Boolean).reduce((a, b) => a + b, 0); }\n';
  const staleTail = Array.from({ length: 24 }, (_, i) => `const staleLine${i} = deprecatedHelper${i}(argumentValue${i}, secondArgument${i});`).join('\n');
  const content = `${pad(9000)}\n${head}${pad(9000)}\nfinalCall();\n`;
  const section = `Files: x.js\nSnippet:\n\`\`\`\n${head}${staleTail}\n\`\`\`\n\nProblem:\nThe file ends with an unconditional call.`;
  const withCue = windowFetchedFileContent(content, section, 3000);
  const withoutCue = windowFetchedFileContent(content, section.replace('The file ends with an unconditional call.', 'Nothing about position.'), 3000);
  assert.equal(withoutCue.confidence, 'weak', 'sanity: this Snippet is only a weak partial match');
  assert.equal(withCue.confidence, 'weak');
  assert.equal(withCue.anchorCount, 1);
  assert.deepEqual(withCue, withoutCue, 'the tail cue must change nothing next to a weak partial guess');
  assert.doesNotMatch(withCue.text, /finalCall/);
});
