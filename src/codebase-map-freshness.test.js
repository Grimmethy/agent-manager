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
function extractCitedPaths(markdown) {
  const backtickSpans = markdown.match(/`[^`]+`/g) || [];
  const paths = new Set();
  for (const span of backtickSpans) {
    const content = span.slice(1, -1);
    const m = content.match(/^([A-Za-z0-9_./-]+\.(?:js|py|md|json))(?::[\d,\s-]+)?$/);
    if (m) paths.add(m[1]);
  }
  return [...paths];
}

test('every file path cited in docs/agents/codebase-map.md still exists', () => {
  const markdown = fs.readFileSync(DOC_PATH, 'utf8');
  const cited = extractCitedPaths(markdown);
  assert.ok(cited.length > 10, `expected to extract a substantial number of cited paths, got ${cited.length} -- extraction regex may be broken`);

  const missing = [];
  for (const citedPath of cited) {
    const resolved = resolveShorthand(citedPath);
    if (!fs.existsSync(path.join(REPO_ROOT, resolved))) missing.push(`${citedPath} -> ${resolved}`);
  }
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
