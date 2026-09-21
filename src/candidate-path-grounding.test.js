'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractFilesLine, checkCitedPaths, formatFabricatedReason,
  checkCitedSymbols, checkCitedSymbolsPerEntry, splitCandidateEntries, formatFabricatedSymbolsReason,
  symbolCheckBlocks, formatSymbolWarnings, resolveCitedFile, normalizeFilesLine,
} = require('./candidate-path-grounding.js');

// --- extractFilesLine -----------------------------------------------------------------

test('extractFilesLine: pulls the AC-NNN "Files:" line value', () => {
  const wu = [
    '### AC-042 · Something',
    'Strength: Strong',
    'Source: crewai — "..."',
    'Files: src/task-sources.js, src/config.js',
    '',
    'Problem:',
    'A paragraph that also mentions src/other.js hypothetically.',
  ].join('\n');
  assert.equal(extractFilesLine(wu), 'src/task-sources.js, src/config.js');
});

test('extractFilesLine: case-insensitive, tolerates leading markdown and bold', () => {
  assert.equal(extractFilesLine('- **Files:** a/b.py, c/d.py'), 'a/b.py, c/d.py');
  assert.equal(extractFilesLine('> files : one.js'), 'one.js');
});

test('extractFilesLine: empty when there is no Files: line', () => {
  assert.equal(extractFilesLine('Problem: files that changed were many.'), '');
  assert.equal(extractFilesLine(''), '');
});

// --- checkCitedPaths ----------------------------------------------------------------

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'real-one.js'), '// real\n');
  fs.writeFileSync(path.join(dir, 'src', 'real-two.js'), '// real\n');
  return dir;
}

test('checkCitedPaths: flags only the path that resolves nowhere', () => {
  const repo = tmpRepo();
  const { fabricated } = checkCitedPaths('src/real-one.js, src/made-up.js', repo, ['src']);
  assert.equal(fabricated.length, 1);
  assert.equal(fabricated[0].claimedPath, 'src/made-up.js');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedPaths: a bare filename that resolves via an extraRoot is NOT fabricated', () => {
  const repo = tmpRepo();
  // "real-two.js" with no src/ prefix -- resolves once `src` is prepended (resolvedVia 'prefix')
  const { fabricated } = checkCitedPaths('real-two.js', repo, ['src']);
  assert.equal(fabricated.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedPaths: all-real Files line -> nothing fabricated', () => {
  const repo = tmpRepo();
  const { fabricated } = checkCitedPaths('src/real-one.js, src/real-two.js', repo, ['src']);
  assert.equal(fabricated.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedPaths: empty line or missing repoRoot -> no-op', () => {
  assert.deepEqual(checkCitedPaths('', '/x', []), { fabricated: [], checked: [] });
  assert.deepEqual(checkCitedPaths('src/x.js', '', []), { fabricated: [], checked: [] });
});

test('checkCitedPaths: only considers path-extensioned tokens (a directory citation is ignored)', () => {
  const repo = tmpRepo();
  const { fabricated } = checkCitedPaths('src/dashboard/, src/real-one.js', repo, ['src']);
  assert.equal(fabricated.length, 0); // "src/dashboard/" has no file extension -> not extracted at all
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- formatFabricatedReason -------------------------------------------------------

test('formatFabricatedReason: names every fabricated path and starts with the classifier prefix', () => {
  const reason = formatFabricatedReason([{ claimedPath: 'src/a.js' }, { claimedPath: 'src/b.py' }]);
  assert.match(reason, /^fabricated file path\(s\): src\/a\.js, src\/b\.py\b/);
  // The full blockedReason becomes "Ungrounded draft: " + this; the classifier keys on
  // /^ungrounded draft:\s*fabricated file path/i.
  assert.match(`Ungrounded draft: ${reason}`, /^ungrounded draft:\s*fabricated file path/i);
});

// --- checkCitedSymbols ----------------------------------------------------------------

function checkedFor(repo, relPath) {
  const resolvedPath = path.join(repo, relPath);
  return [{ claimedPath: relPath, exists: true, resolvedPath }];
}

test('checkCitedSymbols: flags a backtick-quoted symbol absent from the cited (real) file', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'src', 'real-one.js'), 'function realFn() {}\n');
  const text = 'Problem: `realFn` never calls `fakeHelper` before returning.';
  const { fabricated, checked } = checkCitedSymbols(text, checkedFor(repo, 'src/real-one.js'));
  assert.deepEqual(checked.sort(), ['fakeHelper', 'realFn'].sort());
  assert.equal(fabricated.length, 1);
  assert.equal(fabricated[0].name, 'fakeHelper');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedSymbols: a create-mode mention ("add a `newHelper`") is not flagged', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'src', 'real-one.js'), 'function realFn() {}\n');
  const text = 'Solution: add a `newHelper` function that realFn can call.';
  const { fabricated } = checkCitedSymbols(text, checkedFor(repo, 'src/real-one.js'));
  assert.equal(fabricated.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedSymbols: a backtick-quoted filename is not a symbol claim', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'src', 'core.ts'), 'export function api() {}\n');
  const text = 'Problem: In `core.ts`, `api` drops the body; `client.ts` and `App.tsx` never see it.';
  const { fabricated, checked } = checkCitedSymbols(text, checkedFor(repo, 'src/core.ts'));
  assert.deepEqual(checked, ['api']);
  assert.deepEqual(fabricated, []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedSymbols: names proposed in Solution: are not checked, but Problem: still is', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'src', 'real-one.js'), 'function realFn() {}\n');
  const text = [
    '### AC-001 · One',
    'Files: src/real-one.js',
    '',
    'Problem:',
    '`realFn` never calls `fakeHelper`.',
    '',
    'Solution:',
    'Export a single `LEGAL_DOCS` array and extract a `resetResults()` helper (e.g. `Thing.rawBody`).',
    '',
    'Benefits:',
    'Fewer edits.',
    '',
    '### AC-002 · Two',
    'Problem:',
    '`alsoFake` is called twice.',
    '',
    'Solution:',
    'Introduce `BrandNew`.',
  ].join('\n');
  const { fabricated } = checkCitedSymbols(text, checkedFor(repo, 'src/real-one.js'));
  assert.deepEqual(fabricated.map((f) => f.name).sort(), ['alsoFake', 'fakeHelper']);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedSymbols: skips stopwords and short tokens', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'src', 'real-one.js'), '// real\n');
  const text = 'Uses `this`, `return`, and `ab` inline.';
  const { checked } = checkCitedSymbols(text, checkedFor(repo, 'src/real-one.js'));
  assert.deepEqual(checked, []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedSymbols: no-op when no cited path actually exists (Check 0 already caught it)', () => {
  const { fabricated, checked } = checkCitedSymbols('`missingFn` is broken.', [{ claimedPath: 'src/nope.js', exists: false, resolvedPath: null }]);
  assert.deepEqual(fabricated, []);
  assert.deepEqual(checked, []);
});

test('checkCitedSymbols: all-real symbols -> nothing fabricated', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'src', 'real-one.js'), 'function realFn() { return otherReal(); }\nfunction otherReal() {}\n');
  const text = '`realFn` calls `otherReal`.';
  const { fabricated } = checkCitedSymbols(text, checkedFor(repo, 'src/real-one.js'));
  assert.equal(fabricated.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- formatFabricatedSymbolsReason -------------------------------------------------

test('formatFabricatedSymbolsReason: names every fabricated symbol and starts with the classifier prefix', () => {
  const reason = formatFabricatedSymbolsReason([{ name: 'fakeHelper' }, { name: 'ghostFn' }]);
  assert.match(reason, /^fabricated symbol citation\(s\): `fakeHelper`, `ghostFn`/);
  assert.match(`Ungrounded draft: ${reason}`, /^ungrounded draft:\s*fabricated symbol citation/i);
});

test('checkCitedSymbolsPerEntry: each entry is checked against its OWN Files: line', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'src', 'one.js'), 'function alphaFn() {}\n');
  fs.writeFileSync(path.join(repo, 'src', 'two.js'), 'function betaFn() {}\n');
  const text = [
    '### AC-001 · One', 'Files: src/one.js', '', 'Problem:', '`alphaFn` is duplicated.', '',
    '### AC-002 · Two', 'Files: src/two.js', '', 'Problem:', '`betaFn` is duplicated and `ghostFn` is invented.',
  ].join('\n');
  const { fabricated } = checkCitedSymbolsPerEntry(text, repo, ['src']);
  assert.deepEqual(fabricated.map((f) => f.name), ['ghostFn']); // betaFn is real in AC-002's file
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedSymbolsPerEntry: a symbol real only in ANOTHER entry\'s file is still flagged', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'src', 'one.js'), 'function alphaFn() {}\n');
  fs.writeFileSync(path.join(repo, 'src', 'two.js'), 'function betaFn() {}\n');
  const text = ['### AC-001 · One', 'Files: src/one.js', 'Problem:', '`betaFn` lives here?'].join('\n');
  assert.deepEqual(checkCitedSymbolsPerEntry(text, repo, ['src']).fabricated.map((f) => f.name), ['betaFn']);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('splitCandidateEntries: text without ### headers is one entry', () => {
  assert.deepEqual(splitCandidateEntries('Files: a.js\nProblem: x'), ['Files: a.js\nProblem: x']);
});

test('checkCitedSymbols: names only in Benefits: are not checked (hypothetical/post-change prose)', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'src', 'real-one.js'), 'function realFn() {}\n');
  const text = [
    'Files: src/real-one.js', '', 'Problem:', '`realFn` is duplicated.', '',
    'Solution:', 'Extract a helper.', '', 'Benefits:',
    'Adding a new field (e.g. a `totalPages` counter) touches one place; `resetResults` handles it.',
  ].join('\n');
  assert.deepEqual(checkCitedSymbols(text, checkedFor(repo, 'src/real-one.js')).fabricated, []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('symbolCheckBlocks: warn-only by default, opt back in with AGENT_MANAGER_SYMBOL_CHECK_BLOCKING=true', () => {
  const saved = process.env.AGENT_MANAGER_SYMBOL_CHECK_BLOCKING;
  try {
    delete process.env.AGENT_MANAGER_SYMBOL_CHECK_BLOCKING;
    assert.equal(symbolCheckBlocks(), false);
    process.env.AGENT_MANAGER_SYMBOL_CHECK_BLOCKING = 'true';
    assert.equal(symbolCheckBlocks(), true);
    process.env.AGENT_MANAGER_SYMBOL_CHECK_BLOCKING = 'false';
    assert.equal(symbolCheckBlocks(), false);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_SYMBOL_CHECK_BLOCKING; else process.env.AGENT_MANAGER_SYMBOL_CHECK_BLOCKING = saved;
  }
});

test('formatSymbolWarnings: one advisory line naming every symbol; empty in, empty out', () => {
  assert.deepEqual(formatSymbolWarnings([]), []);
  const [w] = formatSymbolWarnings([{ name: 'a' }, { name: 'b' }]);
  assert.match(w, /`a`, `b`/);
  assert.doesNotMatch(w, /fabricated/i);
});

// --- one shared Files: resolver (2026-09-19, PropertyForager arch-review-ac-1) -------------------------

function tsxRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-tsx-'));
  fs.mkdirSync(path.join(repo, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'components', 'SearchView.tsx'), 'export const SearchView = 1;\n');
  return repo;
}

test('resolveCitedFile: exact, bare basename, and an EXTENSION-LESS name all resolve to the repo-relative file', () => {
  const repo = tsxRepo();
  for (const claimed of ['src/components/SearchView.tsx', 'SearchView.tsx', 'SearchView', '`SearchView`']) {
    const r = resolveCitedFile(repo, claimed, ['src']);
    assert.equal(r.exists, true, claimed);
    assert.equal(r.relPath, 'src/components/SearchView.tsx', claimed);
    assert.equal(r.isFile, true);
  }
  assert.equal(resolveCitedFile(repo, 'src/components', ['src']).isFile, false, 'a directory resolves but is not a file');
  assert.equal(resolveCitedFile(repo, 'Nope', ['src']).exists, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('resolveCitedFile: an ambiguous bare name (two files, none under a code dir) does not resolve', () => {
  const repo = tsxRepo();
  fs.mkdirSync(path.join(repo, 'a'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'b'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a', 'Dup.ts'), 'x');
  fs.writeFileSync(path.join(repo, 'b', 'Dup.ts'), 'x');
  assert.equal(resolveCitedFile(repo, 'Dup', []).exists, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedPaths: an extension-less Files: entry naming a REAL file passes; an invented one is fabricated; prose/globs are ignored', () => {
  const repo = tsxRepo();
  assert.deepEqual(checkCitedPaths('SearchView', repo, ['src']).fabricated, []);
  assert.deepEqual(checkCitedPaths('SearchView, the search component, src/*', repo, ['src']).fabricated, []);
  const bad = checkCitedPaths('SearchView, SearchViwe', repo, ['src']).fabricated;
  assert.deepEqual(bad.map((f) => f.claimedPath), ['SearchViwe']);
  // Regression: this exact line used to yield NO checked paths at all (no extension for the regex).
  assert.equal(checkCitedPaths('SearchView', repo, ['src']).checked.length, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('normalizeFilesLine: rewrites bare/extension-less entries to the real path; leaves exact, unresolved and unrelated text alone', () => {
  const repo = tsxRepo();
  assert.equal(
    normalizeFilesLine('SearchView, SearchView.tsx, src/components/SearchView.tsx, Ghost, src/*', repo, ['src']),
    'src/components/SearchView.tsx, src/components/SearchView.tsx, src/components/SearchView.tsx, Ghost, src/*',
  );
  assert.equal(normalizeFilesLine('Ghost', repo, ['src']), 'Ghost');
  assert.equal(normalizeFilesLine('', repo, ['src']), '');
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- origin/<main> rescue (2026-09-21, PF arch-discovery-community-5) ---------------------
// A real bare origin + clone, with the checkout then moved to a stale branch that lacks the file: the exact incident shape.
const { execFileSync } = require('child_process');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function staleCheckoutRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-main-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(work, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(work, 'README.md'), 'x\n');
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'base'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  git(work, 'branch', 'stale');                                  // a branch cut BEFORE the file exists
  fs.writeFileSync(path.join(work, 'src', 'lib', 'dealCsv.ts'), '// real\n');
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'add dealCsv'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  git(work, 'checkout', '-q', 'stale');                          // the shared checkout is left here
  return { root, work };
}

test('checkCitedPaths: a file missing from a stale working tree but present on origin/main is NOT fabricated', () => {
  const { root, work } = staleCheckoutRepo();
  assert.ok(!fs.existsSync(path.join(work, 'src', 'lib', 'dealCsv.ts')), 'premise: the working tree lacks the file');
  const { fabricated, checked } = checkCitedPaths('src/lib/dealCsv.ts', work, []);
  assert.deepEqual(fabricated, []);
  assert.equal(checked[0].resolvedVia, 'origin-main');
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkCitedPaths: a path on neither the working tree nor origin/main is STILL fabricated', () => {
  const { root, work } = staleCheckoutRepo();
  const { fabricated } = checkCitedPaths('src/lib/dealCsv.ts, src/lib/invented.ts', work, []);
  assert.deepEqual(fabricated.map((f) => f.claimedPath), ['src/lib/invented.ts']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkCitedPaths: an extension-less entry that exists on origin/main is rescued too', () => {
  const { root, work } = staleCheckoutRepo();
  assert.deepEqual(checkCitedPaths('src/lib/dealCsv', work, []).fabricated, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkCitedPaths: AGENT_MANAGER_CANDIDATE_GROUNDING_MAIN_REF=false restores the working-tree-only verdict', () => {
  const { root, work } = staleCheckoutRepo();
  process.env.AGENT_MANAGER_CANDIDATE_GROUNDING_MAIN_REF = 'false';
  try {
    assert.equal(checkCitedPaths('src/lib/dealCsv.ts', work, []).fabricated.length, 1);
  } finally { delete process.env.AGENT_MANAGER_CANDIDATE_GROUNDING_MAIN_REF; }
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkCitedPaths: a non-git repo root keeps the old verdict (no throw)', () => {
  const repo = tmpRepo();
  assert.equal(checkCitedPaths('src/made-up.js', repo, ['src']).fabricated.length, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('parseFabricatedPaths: inverts formatFabricatedReason and ignores other wording', () => {
  const reason = formatFabricatedReason([{ claimedPath: 'a/b.ts' }, { claimedPath: 'c.ts' }]);
  assert.deepEqual(require('./candidate-path-grounding.js').parseFabricatedPaths(`Ungrounded draft: ${reason}`), ['a/b.ts', 'c.ts']);
  assert.deepEqual(require('./candidate-path-grounding.js').parseFabricatedPaths('fabricated symbol citation(s): `x` -- not found'), []);
});
