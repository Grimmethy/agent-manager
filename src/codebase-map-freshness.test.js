'use strict';

// Cheap freshness guard for docs/agents/codebase-map.md (see that file's own header and
// AGENTS.md's "Codebase map" agent-skill entry): the map is hand-maintained and grows by
// agents adding a row whenever they had to hunt for a path it didn't have. Nothing else
// keeps it fresh, so this test catches the most common way that kind of doc rots -- a
// cited file gets renamed, moved, or deleted -- without attempting a full content-drift
// check (rejected for this doc: it maps prose concepts to paths, not a clean enumerable
// registry the way src/task-sources.js's own drift-scan.js PAIRS mechanism expects).
//
// Deliberately proves ONLY that the file exists, never that a cited line range or
// function name inside it is still accurate -- the doc's own header states that
// limitation explicitly. A test that tried to verify line numbers too would need
// updating every time an unrelated edit shifted a few lines, which is exactly the kind
// of maintenance burden this mechanism exists to avoid.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'agents', 'codebase-map.md');

// The doc's own stated shorthand (see its header): a bare `app.py` means
// python/dashboard/app.py, and a bare `*.js` filename with no directory means
// python/dashboard/static/js/<name>.js. Every other backtick-quoted path is already
// repo-root-relative in full.
function resolveShorthand(citedPath) {
  if (citedPath === 'app.py') return 'python/dashboard/app.py';
  if (/^[A-Za-z0-9_-]+\.js$/.test(citedPath)) return path.posix.join('python/dashboard/static/js', citedPath);
  return citedPath;
}

// Extracts every backtick-quoted, extensioned, path-shaped token from the doc. Requires
// a recognized extension so a function-call snippet like `renderBranchesTab()` (no
// extension) or the header's own `<name>.js` placeholder (angle brackets excluded by the
// character class) never matches -- the doc's table format deliberately keeps file
// citations free of trailing `()` for exactly this reason.
// A cited path that does not exist is a stale row, EXCEPT a host-local file that git ignores (the map says so for plugins.json): it
// exists in the live checkout but never in a clean clone or worktree, so demanding it would make this test red in every automated
// context. Only a path git itself reports as ignored is skipped; if git is unavailable nothing is skipped.
function isGitIgnored(relPath) {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', relPath], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function findMissingCitations(cited, { exists, ignored }) {
  const missing = [];
  for (const citedPath of cited) {
    const resolved = resolveShorthand(citedPath);
    if (exists(resolved) || ignored(resolved)) continue;
    missing.push(`${citedPath} -> ${resolved}`);
  }
  return missing;
}

// A citation may carry an optional anchor after the range: `path:start-end#symbol` or `path#symbol`, where symbol is a function or
// class name or a dotted `Class.method` (see the map's "Anchors" paragraph). The suffix MUST be accepted here: the pattern below
// matches the whole backtick span, so without it an anchored citation would not fail this test, it would silently not match and its
// file would stop being checked at all.
function extractCitedPaths(markdown) {
  const backtickSpans = markdown.match(/`[^`]+`/g) || [];
  const paths = new Set();
  for (const span of backtickSpans) {
    const content = span.slice(1, -1);
    const m = content.match(/^([A-Za-z0-9_./-]+\.(?:js|py|md|json))(?::[\d,\s-]+)?(?:#[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)?$/);
    if (m) paths.add(m[1]);
  }
  return [...paths];
}

test('every file path cited in docs/agents/codebase-map.md still exists', () => {
  const markdown = fs.readFileSync(DOC_PATH, 'utf8');
  const cited = extractCitedPaths(markdown);
  assert.ok(cited.length > 10, `expected to extract a substantial number of cited paths, got ${cited.length} -- extraction regex may be broken`);

  const missing = findMissingCitations(cited, { exists: (rel) => fs.existsSync(path.join(REPO_ROOT, rel)), ignored: isGitIgnored });
  assert.deepEqual(missing, [], `codebase-map.md cites path(s) that no longer exist -- fix or remove the row:\n${missing.join('\n')}`);
});

test('resolveShorthand expands the two documented shorthand rules', () => {
  assert.equal(resolveShorthand('app.py'), 'python/dashboard/app.py');
  assert.equal(resolveShorthand('core-ui.js'), 'python/dashboard/static/js/core-ui.js');
  assert.equal(resolveShorthand('src/task-sources.js'), 'src/task-sources.js');
  assert.equal(resolveShorthand('docs/PLUGIN_API.md'), 'docs/PLUGIN_API.md');
});

test('extractCitedPaths ignores function-call snippets and the header placeholder', () => {
  const fake = [
    'See `renderBranchesTab()` (L1) and `renderBranchDetailModal()` (L156).',
    'a bare `*.js` filename means `python/dashboard/static/js/<name>.js`.',
    'A real path: `src/task-log-store.js` and `app.py:6276-6679`.',
  ].join('\n');
  const found = extractCitedPaths(fake);
  assert.deepEqual(found.sort(), ['app.py', 'src/task-log-store.js'].sort());
});

test('extractCitedPaths yields the path for path, path:range, path#symbol and path:range#symbol citations (including Class.method)', () => {
  const fake = [
    'plain `src/a.js`, ranged `src/b.js:10-20`, multi-range `app.py:5, 9-12`,',
    'anchored `src/c.js#registerThing`, ranged and anchored `python/dashboard/routes/x.py:394-416#api_thing`,',
    'a method anchor `src/d.js#Widget.render` and a dollar name `src/e.js#$helper`.',
  ].join('\n');
  assert.deepEqual(extractCitedPaths(fake).sort(),
    ['app.py', 'python/dashboard/routes/x.py', 'src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js'].sort());
});

test('extractCitedPaths ignores malformed anchors, like any other span that is not a citation', () => {
  const fake = ['`src/a.js#`', '`src/a.js#1abc`', '`src/a.js#a b`', '`src/a.js#a-b`', '`src/a.js#.x`', '`src/a.js#x.`', '`src/a.js##x`', '`src/a.js#x#y`'].join(' ');
  assert.deepEqual(extractCitedPaths(fake), []);
});

test('an anchored citation of a MISSING file is still reported by the existence check', () => {
  const fake = 'Row: `src/definitely-not-a-real-file.js:1-9#someFunction` and a real one `src/codebase-map-freshness.test.js#extractCitedPaths`.';
  const cited = extractCitedPaths(fake);
  assert.deepEqual(cited.sort(), ['src/codebase-map-freshness.test.js', 'src/definitely-not-a-real-file.js']);
  const missing = findMissingCitations(cited, { exists: (rel) => fs.existsSync(path.join(__dirname, '..', rel)), ignored: () => false });
  assert.deepEqual(missing, ['src/definitely-not-a-real-file.js -> src/definitely-not-a-real-file.js']);
});

test('findMissingCitations skips a missing path only when it is git-ignored (host-local), and reports every other missing path', () => {
  const exists = (rel) => rel === 'src/real.js';
  const ignored = (rel) => rel === 'plugins.json';
  assert.deepEqual(findMissingCitations(['src/real.js', 'plugins.json'], { exists, ignored }), []);
  assert.deepEqual(findMissingCitations(['src/real.js', 'plugins.json', 'src/gone.js', 'other.json'], { exists, ignored }),
    ['src/gone.js -> src/gone.js', 'other.json -> other.json']);
  assert.deepEqual(findMissingCitations(['review-task.js'], { exists, ignored }), ['review-task.js -> python/dashboard/static/js/review-task.js'],
    'a bare name still resolves through the documented shorthand, so a wrong bare citation is reported');
});

test('isGitIgnored is true for the real host-local plugins.json and false for a tracked file', () => {
  assert.equal(isGitIgnored('plugins.json'), true);
  assert.equal(isGitIgnored('docs/agents/codebase-map.md'), false);
});
