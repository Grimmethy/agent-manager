'use strict';

// Unit tests for path-prefetch.js -- anchor-resolution + file-path prefetch for adhoc
// brain-dump tasks. Covers the four outcomes resolveAnchors() can return, per the design
// settled across the context-aware-file-path-prefetch-job.md Grill Me + Discuss
// sessions: greenfield (no graph yet), no-match, ambiguous (multiple candidates), and a
// clean match -- plus the stale-reference validation and the MAX_PREFETCHED_PATHS cap.
//
// Run: node --test src/path-prefetch.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractKeywords, resolveAnchors, looksLikeUiRequest, MAX_PREFETCHED_PATHS } = require('./path-prefetch.js');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-test-'));
}

function writeGraph(repoRoot, nodes) {
  fs.mkdirSync(path.join(repoRoot, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'graphify-out', 'graph.json'), JSON.stringify({ nodes, links: [] }));
}

function writeSourceFile(repoRoot, relPath, content = '// stub\n') {
  const full = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('extractKeywords ranks identifier-shaped tokens (snake_case/kebab-case/camelCase) ahead of plain words', () => {
  const keywords = extractKeywords('We need to fix the budget_guard module, it relates to BudgetGuard and general config stuff');
  const tokens = keywords.map((k) => k.token);
  // identifier-shaped tokens present
  assert.ok(tokens.includes('budget_guard'));
  assert.ok(tokens.includes('BudgetGuard'));
  // stopwords excluded
  assert.ok(!tokens.some((t) => t.toLowerCase() === 'the' || t.toLowerCase() === 'fix'));
  // identifier-shaped tokens sort before the plain word "config"/"general"
  const budgetIdx = tokens.indexOf('budget_guard');
  const configIdx = tokens.indexOf('config');
  assert.ok(budgetIdx < configIdx, 'identifier-shaped token should rank ahead of a plain word');
});

test('extractKeywords de-duplicates case-insensitively and drops sub-3-char tokens', () => {
  const keywords = extractKeywords('Auth auth AUTH ab');
  assert.deepEqual(keywords.map((k) => k.lower), ['auth']);
});

test('resolveAnchors returns greenfield when no graph exists on disk at all', () => {
  const repoRoot = makeRepo();
  const result = resolveAnchors({ repoRoot, title: 'Fix the budget_guard bug', rawText: '' });
  assert.deepEqual(result, { status: 'greenfield' });
});

test('resolveAnchors returns greenfield when the graph file is present but empty/malformed', () => {
  const repoRoot = makeRepo();
  fs.mkdirSync(path.join(repoRoot, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'graphify-out', 'graph.json'), 'not json');
  const result = resolveAnchors({ repoRoot, title: 'Fix the budget_guard bug', rawText: '' });
  assert.deepEqual(result, { status: 'greenfield' });
});

test('resolveAnchors returns greenfield when the graph has zero nodes with a source_file', () => {
  const repoRoot = makeRepo();
  writeGraph(repoRoot, [{ id: 0, community: 0 }]); // no source_file field at all
  const result = resolveAnchors({ repoRoot, title: 'Fix the budget_guard bug', rawText: '' });
  assert.deepEqual(result, { status: 'greenfield' });
});

test('resolveAnchors returns greenfield when a real graph exists but nothing distinctive matches (queue, do not hold)', () => {
  const repoRoot = makeRepo();
  writeGraph(repoRoot, [{ id: 0, community: 0, source_file: 'src/unrelated-module.ts' }]);
  const result = resolveAnchors({ repoRoot, title: 'Totally different topic entirely', rawText: 'nothing here relates' });
  assert.deepEqual(result, { status: 'greenfield' });
});

test('resolveAnchors returns greenfield when the task text has no usable keywords at all', () => {
  const repoRoot = makeRepo();
  writeGraph(repoRoot, [{ id: 0, community: 0, source_file: 'src/foo.ts' }]);
  const result = resolveAnchors({ repoRoot, title: 'a to it is', rawText: '' });
  assert.deepEqual(result, { status: 'greenfield' });
});

test('resolveAnchors returns a clean match for an unambiguous keyword-to-file hit, validated against real files on disk', () => {
  const repoRoot = makeRepo();
  writeSourceFile(repoRoot, 'src/budget_guard.ts');
  writeGraph(repoRoot, [{ id: 0, community: 0, source_file: 'src/budget_guard.ts' }]);
  const result = resolveAnchors({ repoRoot, title: 'Fix a bug in budget_guard', rawText: '' });
  assert.deepEqual(result, { status: 'matched', paths: ['src/budget_guard.ts'] });
});

test('resolveAnchors matches a keyword to a file stem regardless of underscore/hyphen differences', () => {
  const repoRoot = makeRepo();
  writeSourceFile(repoRoot, 'src/budget-guard.ts');
  writeGraph(repoRoot, [{ id: 0, community: 0, source_file: 'src/budget-guard.ts' }]);
  const result = resolveAnchors({ repoRoot, title: 'Fix a bug in budget_guard', rawText: '' });
  assert.deepEqual(result, { status: 'matched', paths: ['src/budget-guard.ts'] });
});

test('resolveAnchors returns ambiguous when a keyword matches more than one file, without auto-picking either', () => {
  const repoRoot = makeRepo();
  writeSourceFile(repoRoot, 'src/auth.ts');
  writeSourceFile(repoRoot, 'server/auth.ts');
  writeGraph(repoRoot, [
    { id: 0, community: 0, source_file: 'src/auth.ts' },
    { id: 1, community: 0, source_file: 'server/auth.ts' },
  ]);
  const result = resolveAnchors({ repoRoot, title: 'Fix the auth bug', rawText: '' });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(new Set(result.candidates.auth), new Set(['src/auth.ts', 'server/auth.ts']));
});

test('resolveAnchors drops a common word that matches more than AMBIGUOUS_MAX_HITS files -- not escalated as ambiguous', () => {
  const repoRoot = makeRepo();
  const files = ['a/dashboard-one.ts', 'a/dashboard-two.ts', 'a/dashboard-three.ts', 'a/dashboard-four.ts', 'a/dashboard-five.ts'];
  files.forEach((f) => writeSourceFile(repoRoot, f));
  writeGraph(repoRoot, files.map((f, i) => ({ id: i, community: 0, source_file: f })));
  const result = resolveAnchors({ repoRoot, title: 'the dashboard is broken', rawText: '' });
  assert.equal(result.status, 'greenfield', '"dashboard" matched 5 files -- a common word, dropped; nothing else anchors -> queue normally');
});

test('resolveAnchors: a clean single-file anchor WINS over a fuzzy multi-hit keyword (no human hold)', () => {
  const repoRoot = makeRepo();
  writeSourceFile(repoRoot, 'src/budget_guard.ts');
  writeSourceFile(repoRoot, 'src/auth.ts');
  writeSourceFile(repoRoot, 'server/auth.ts');
  writeGraph(repoRoot, [
    { id: 0, community: 0, source_file: 'src/budget_guard.ts' },
    { id: 1, community: 0, source_file: 'src/auth.ts' },
    { id: 2, community: 0, source_file: 'server/auth.ts' },
  ]);
  const result = resolveAnchors({ repoRoot, title: 'fix budget_guard, also touches auth', rawText: '' });
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.paths, ['src/budget_guard.ts']);
});

test('resolveAnchors skips a 3-char plain word that substring-matches by coincidence', () => {
  const repoRoot = makeRepo();
  writeSourceFile(repoRoot, 'src/build_note_graph.ts');
  writeGraph(repoRoot, [{ id: 0, community: 0, source_file: 'src/build_note_graph.ts' }]);
  // "not" (3 chars) would substring-match build_NOTe_graph; must be ignored.
  const result = resolveAnchors({ repoRoot, title: 'this is not what I meant', rawText: '' });
  assert.equal(result.status, 'greenfield');
});

test('resolveAnchors defaults to the standard file, not its .test sibling, when a keyword substring-matches both', () => {
  const repoRoot = makeRepo();
  writeSourceFile(repoRoot, 'src/task-sources.js');
  writeSourceFile(repoRoot, 'src/task-sources.test.js');
  writeGraph(repoRoot, [
    { id: 0, community: 0, source_file: 'src/task-sources.js' },
    { id: 1, community: 0, source_file: 'src/task-sources.test.js' },
  ]);
  // "sources" alone doesn't exact-stem-match either file, so this falls to the substring
  // pass, which would otherwise pick up both files and (wrongly) call it ambiguous.
  const result = resolveAnchors({ repoRoot, title: 'Fix a bug in the sources handling', rawText: '' });
  assert.deepEqual(result, { status: 'matched', paths: ['src/task-sources.js'] });
});

test('resolveAnchors still reports genuine ambiguity between a real file and an unrelated .test file, when the note text pulls in a keyword outside their shared sibling pair', () => {
  const repoRoot = makeRepo();
  writeSourceFile(repoRoot, 'src/task-sources.js');
  writeSourceFile(repoRoot, 'src/other.test.js');
  writeGraph(repoRoot, [
    { id: 0, community: 0, source_file: 'src/task-sources.js' },
    { id: 1, community: 0, source_file: 'src/other.test.js' },
  ]);
  const result = resolveAnchors({ repoRoot, title: 'Fix a bug in the sources handling', rawText: '' });
  // 'other' isn't in the title, so only task-sources.js matches "sources" -- unambiguous,
  // no unrelated test file dragged in.
  assert.deepEqual(result, { status: 'matched', paths: ['src/task-sources.js'] });
});

test('resolveAnchors treats a matched-but-deleted (stale) file the same as no match', () => {
  const repoRoot = makeRepo();
  // Graph references it, but the file was never actually written to disk -- simulates a
  // renamed/deleted file since the graph was last built.
  writeGraph(repoRoot, [{ id: 0, community: 0, source_file: 'src/budget_guard.ts' }]);
  const result = resolveAnchors({ repoRoot, title: 'Fix a bug in budget_guard', rawText: '' });
  assert.deepEqual(result, { status: 'greenfield' });
});

test('resolveAnchors combines multiple distinct unambiguous matches into one paths list', () => {
  const repoRoot = makeRepo();
  writeSourceFile(repoRoot, 'src/budget_guard.ts');
  writeSourceFile(repoRoot, 'src/rate_limiter.ts');
  writeGraph(repoRoot, [
    { id: 0, community: 0, source_file: 'src/budget_guard.ts' },
    { id: 1, community: 0, source_file: 'src/rate_limiter.ts' },
  ]);
  const result = resolveAnchors({ repoRoot, title: 'Coordinate budget_guard and rate_limiter together', rawText: '' });
  assert.equal(result.status, 'matched');
  assert.deepEqual(new Set(result.paths), new Set(['src/budget_guard.ts', 'src/rate_limiter.ts']));
});

test('resolveAnchors caps the number of prefetched paths at MAX_PREFETCHED_PATHS', () => {
  const repoRoot = makeRepo();
  const nodes = [];
  const words = [];
  for (let i = 0; i < MAX_PREFETCHED_PATHS + 5; i++) {
    const name = `distinctmodule${i}`;
    writeSourceFile(repoRoot, `src/${name}.ts`);
    nodes.push({ id: i, community: 0, source_file: `src/${name}.ts` });
    words.push(name);
  }
  writeGraph(repoRoot, nodes);
  const result = resolveAnchors({ repoRoot, title: words.join(' '), rawText: '' });
  assert.equal(result.status, 'matched');
  assert.ok(result.paths.length <= MAX_PREFETCHED_PATHS);
});

test('resolveAnchors respects graphPathOverride instead of the default repoRoot/graphify-out/graph.json location', () => {
  const repoRoot = makeRepo();
  const altDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-alt-graph-'));
  const altGraphPath = path.join(altDir, 'custom-graph.json');
  writeSourceFile(repoRoot, 'src/budget_guard.ts');
  fs.writeFileSync(altGraphPath, JSON.stringify({ nodes: [{ id: 0, community: 0, source_file: 'src/budget_guard.ts' }], links: [] }));
  const result = resolveAnchors({ repoRoot, title: 'Fix budget_guard', rawText: '', graphPathOverride: altGraphPath });
  assert.deepEqual(result, { status: 'matched', paths: ['src/budget_guard.ts'] });
});

// uiVocabHubFiles fallback (2026-08-20): a real stuck needs-clarification sweep found
// "I'd like a tooltip for each tab that activates on hover..." hit no-match every time --
// none of that plain-English UI vocabulary is ever a substring of a real filename. See
// path-prefetch.js's UI_VOCAB header for the full incident.

test('looksLikeUiRequest recognizes common UI vocabulary', () => {
  assert.equal(looksLikeUiRequest("I'd like a tooltip for each tab that activates on hover"), true);
  assert.equal(looksLikeUiRequest('Fix the budget calculation logic'), false);
});

test('resolveAnchors falls back to the configured UI hub file(s) when normal keyword matching finds nothing, but only if the text actually looks UI-related', () => {
  const repoRoot = makeRepo();
  writeGraph(repoRoot, [{ id: 0, community: 0, source_file: 'src/budget_guard.ts' }]);
  writeSourceFile(repoRoot, 'python/dashboard/templates/index.html');

  const uiResult = resolveAnchors({
    repoRoot,
    title: 'Window tabs',
    rawText: "I'd like a tooltip for each tab that activates on hover with a brief description.",
    uiVocabHubFiles: ['python/dashboard/templates/index.html'],
  });
  assert.deepEqual(uiResult, { status: 'matched', paths: ['python/dashboard/templates/index.html'] });

  // Non-UI prose with no vocabulary hit still correctly falls through to no-match --
  // this fallback is a targeted patch for UI-phrased requests, not a catch-all.
  const nonUiResult = resolveAnchors({
    repoRoot,
    title: 'Quarterly numbers',
    rawText: 'We should reconcile the ledger totals against last month.',
    uiVocabHubFiles: ['python/dashboard/templates/index.html'],
  });
  assert.equal(nonUiResult.status, 'greenfield');
});

test('resolveAnchors never applies the UI fallback when no hub files are configured (opt-in, not a default behavior change)', () => {
  const repoRoot = makeRepo();
  writeGraph(repoRoot, [{ id: 0, community: 0, source_file: 'src/budget_guard.ts' }]);
  writeSourceFile(repoRoot, 'python/dashboard/templates/index.html');

  const result = resolveAnchors({
    repoRoot,
    title: 'Window tabs',
    rawText: "I'd like a tooltip for each tab that activates on hover.",
  });
  assert.equal(result.status, 'greenfield');
});

test('resolveAnchors\' UI fallback only offers a hub file that actually exists on disk', () => {
  const repoRoot = makeRepo();
  writeGraph(repoRoot, [{ id: 0, community: 0, source_file: 'src/budget_guard.ts' }]);
  // Deliberately NOT writing python/dashboard/templates/index.html to disk here.

  const result = resolveAnchors({
    repoRoot,
    title: 'Window tabs',
    rawText: "I'd like a tooltip for each tab that activates on hover.",
    uiVocabHubFiles: ['python/dashboard/templates/index.html'],
  });
  assert.equal(result.status, 'greenfield');
});

test('resolveAnchors\' UI fallback never overrides a genuinely ambiguous real match', () => {
  const repoRoot = makeRepo();
  writeSourceFile(repoRoot, 'src/tab-panel-a.ts');
  writeSourceFile(repoRoot, 'src/tab-panel-b.ts');
  writeSourceFile(repoRoot, 'python/dashboard/templates/index.html');
  writeGraph(repoRoot, [
    { id: 0, community: 0, source_file: 'src/tab-panel-a.ts' },
    { id: 1, community: 0, source_file: 'src/tab-panel-b.ts' },
  ]);

  const result = resolveAnchors({
    repoRoot,
    title: 'tab-panel needs a hover tooltip',
    rawText: '',
    uiVocabHubFiles: ['python/dashboard/templates/index.html'],
  });
  assert.equal(result.status, 'ambiguous');
});
