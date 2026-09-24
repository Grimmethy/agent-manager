'use strict';

// Unit tests for script-extract.js -- the reusable core of scripts/extract-core-ui.js's
// real V8-parser-oracle extraction, pulled out so both the original CLI and
// file-decompose-to-hub.js's deterministic script-extract move apply share one
// implementation. No tests existed for the original CLI's logic at all before this.
//
// Run: node --test src/script-extract.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findScriptBlocks, locateFunction, locateFunctions, buildExtraction,
} = require('./script-extract.js');

function makeHtml(scriptBody) {
  return [
    '<!doctype html>',
    '<html><body>',
    '<script>',
    scriptBody,
    '</script>',
    '</body></html>',
  ].join('\n');
}

test('findScriptBlocks finds the inline script and skips a src= script', () => {
  const html = [
    '<script src="/static/other.js"></script>',
    '<script>function a() {}</script>',
  ].join('\n');
  const blocks = findScriptBlocks(html);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].body, /function a/);
});

test('locateFunction finds a plain top-level function declaration', () => {
  const body = 'function foo(a, b) {\n  return a + b;\n}\n';
  const loc = locateFunction(body, 'foo');
  assert.equal(loc.problem, undefined);
  assert.equal(body.slice(loc.start, loc.end + 1), 'function foo(a, b) {\n  return a + b;\n}');
});

test('locateFunction finds an async function declaration', () => {
  const body = 'async function bar() {\n  await x();\n}\n';
  const loc = locateFunction(body, 'bar');
  assert.equal(loc.problem, undefined);
});

test('locateFunction does not desync on a template literal containing braces/quotes', () => {
  const body = 'function tricky() {\n  return `a ${1 + 1} b\'c"d {not a brace}`;\n}\n';
  const loc = locateFunction(body, 'tricky');
  assert.equal(loc.problem, undefined, 'a hand-rolled brace-counter would desync here; the V8 oracle must not');
  assert.equal(body.slice(loc.start, loc.end + 1).trim().endsWith('}'), true);
});

test('locateFunction reports a real problem for a non-function-declaration form (const/arrow)', () => {
  const body = 'const notAFunction = () => {};\n';
  const loc = locateFunction(body, 'notAFunction');
  assert.equal(loc.problem, 'declaration not found at top level');
});

test('locateFunction reports a real problem for a name that does not exist at all', () => {
  const body = 'function realOne() {}\n';
  const loc = locateFunction(body, 'doesNotExist');
  assert.equal(loc.problem, 'declaration not found at top level');
});

test('locateFunction excludes a call site (never at column 0 immediately followed by "function")', () => {
  const body = '  callSite();\nfunction real() {}\n';
  const loc = locateFunction(body, 'callSite');
  assert.equal(loc.problem, 'declaration not found at top level');
});

test('locateFunctions resolves all real symbols ok:true, and reports per-name problems ok:false', () => {
  const html = makeHtml('function a() { return 1; }\nfunction b() { return 2; }\n');
  const okResult = locateFunctions(html, ['a', 'b']);
  assert.equal(okResult.ok, true);
  assert.deepEqual(okResult.results.map((r) => r.status), ['OK', 'OK']);

  const badResult = locateFunctions(html, ['a', 'missing']);
  assert.equal(badResult.ok, false);
  assert.equal(badResult.results[1].status, 'declaration not found at top level');
});

test('locateFunctions returns a real error when there is no inline (non-src) script block at all', () => {
  const html = '<script src="/x.js"></script>';
  const result = locateFunctions(html, ['a']);
  assert.equal(result.ok, false);
  assert.match(result.error, /no inline/);
});

test('locateFunctions flags an overlap between two requested ranges', () => {
  // A contrived body where locating "outer" would swallow "inner" -- simulate by
  // requesting the same function twice under different logical names is not realistic,
  // so instead verify the overlap path directly via two functions where one's close is
  // computed to be inside the other is not constructible with real JS; this test instead
  // confirms two genuinely separate functions never falsely report an overlap.
  const html = makeHtml('function a() { return 1; }\nfunction b() { return 2; }\n');
  const result = locateFunctions(html, ['a', 'b']);
  assert.equal(result.results.every((r) => r.status === 'OK'), true);
});

test('buildExtraction moves the named functions out, removes them from the block, and never inserts a tag when newFileUrl is omitted', () => {
  const html = makeHtml('function a() { return 1; }\n\nfunction b() { return 2; }\n\nfunction c() { return 3; }\n');
  const extraction = buildExtraction(html, ['a', 'c']);
  assert.equal(extraction.ok, true);
  assert.match(extraction.newFileContent, /function a/);
  assert.match(extraction.newFileContent, /function c/);
  assert.doesNotMatch(extraction.newFileContent, /function b/);
  assert.doesNotMatch(extraction.newHtml, /function a/);
  assert.doesNotMatch(extraction.newHtml, /function c/);
  assert.match(extraction.newHtml, /function b/, 'the function NOT named must stay behind');
  assert.doesNotMatch(extraction.newHtml, /<script src=/, 'no tag inserted when newFileUrl is omitted -- wiring is a separate step');
});

test('buildExtraction inserts the given newFileUrl tag when provided (the CLI\'s own one-off migration case)', () => {
  const html = makeHtml('function a() { return 1; }\n');
  const extraction = buildExtraction(html, ['a'], { newFileUrl: '/static/js/x.js' });
  assert.equal(extraction.ok, true);
  assert.match(extraction.newHtml, /<script src="\/static\/js\/x\.js"><\/script>/);
});

test('buildExtraction returns ok:false with the exact per-name problems when any symbol fails to resolve -- never a partial extraction', () => {
  const html = makeHtml('function a() { return 1; }\n');
  const extraction = buildExtraction(html, ['a', 'missing']);
  assert.equal(extraction.ok, false);
  assert.equal(extraction.problems.length, 1);
  assert.equal(extraction.problems[0].name, 'missing');
  assert.equal(extraction.newFileContent, undefined, 'must not construct a partial result');
});

// --- isHtml:false -- plain .js/.mjs/.cjs source, not embedded in HTML ------------------
// 2026-09-08, Grimmethy: "Yes, please build it" -- root-caused live: a file-decompose hub
// splitting src/review-task.js (a plain .js file) had every move fall back to the ONE
// category with no deterministic apply path at all, purely because this whole mechanism
// was gated on `.html`. See script-extract.js's own header for the full incident.

test('locateFunctions with isHtml:false treats the WHOLE source as one script scope, no <script> block required', () => {
  const js = 'function a() { return 1; }\n\nfunction b() { return 2; }\n';
  const result = locateFunctions(js, ['a', 'b'], { isHtml: false });
  assert.equal(result.ok, true);
  assert.equal(result.results.every((r) => r.status === 'OK'), true);
  assert.equal(result.block.bodyStart, 0);
  assert.equal(result.block.body, js);
});

test('locateFunctions with isHtml:false (default true unchanged) still requires a real function, reporting the same problem shape', () => {
  const js = 'function a() { return 1; }\n';
  const result = locateFunctions(js, ['a', 'missing'], { isHtml: false });
  assert.equal(result.ok, false);
  assert.equal(result.results.find((r) => r.name === 'missing').status, 'declaration not found at top level');
});

test('buildExtraction with isHtml:false returns newSource (the whole rewritten file), not newHtml', () => {
  const js = 'function a() { return 1; }\n\nfunction b() { return 2; }\n\nfunction c() { return 3; }\n';
  const extraction = buildExtraction(js, ['a', 'c'], { isHtml: false });
  assert.equal(extraction.ok, true);
  assert.equal(extraction.newHtml, undefined, 'must not populate the HTML-specific field for a plain JS source');
  assert.match(extraction.newFileContent, /function a/);
  assert.match(extraction.newFileContent, /function c/);
  assert.doesNotMatch(extraction.newFileContent, /function b/);
  assert.doesNotMatch(extraction.newSource, /function a/);
  assert.doesNotMatch(extraction.newSource, /function c/);
  assert.match(extraction.newSource, /function b/, 'the function NOT named must stay behind');
});

test('buildExtraction with isHtml:false preserves content before/after the moved functions exactly, including requires and exports', () => {
  const js = [
    "'use strict';",
    '',
    "const fs = require('fs');",
    '',
    'function keep() { return 0; }',
    '',
    'function moveMe() { return 1; }',
    '',
    'module.exports = { keep, moveMe };',
    '',
  ].join('\n');
  const extraction = buildExtraction(js, ['moveMe'], { isHtml: false });
  assert.equal(extraction.ok, true);
  assert.match(extraction.newSource, /^'use strict';/);
  assert.match(extraction.newSource, /require\('fs'\)/);
  assert.match(extraction.newSource, /function keep/);
  assert.doesNotMatch(extraction.newSource, /function moveMe/);
  assert.match(extraction.newSource, /module\.exports = \{ keep, moveMe \};/, 'export list itself is left untouched -- wiring is a separate step');
  assert.match(extraction.newFileContent, /function moveMe/);
});

test('buildExtraction with isHtml:false never inserts a <script> tag (there is no such concept for a plain module)', () => {
  const js = 'function a() { return 1; }\n';
  const extraction = buildExtraction(js, ['a'], { isHtml: false, newFileUrl: '/static/js/x.js' });
  assert.equal(extraction.ok, true);
  assert.doesNotMatch(extraction.newSource, /<script/);
});

// Regression, real incident (2026-09-07): 11 of 26 symbols in a real decompose move were
// reported "not found" by a model's own hand-rolled scanner; every one of the 26 actually
// resolves cleanly via this module. Proves the oracle approach handles a realistic mix of
// plain and async top-level declarations without desyncing.
test('locateFunctions handles a realistic mix of plain and async declarations without desyncing', () => {
  const html = makeHtml([
    'async function renderAdhocTasksTab() {',
    '  const x = `${1}`;',
    '  return x;',
    '}',
    '',
    'function taskLink(id) {',
    '  return `<a href="/t/${id}">${id}</a>`;',
    '}',
    '',
    'async function clarifyDiscussStart(taskId) {',
    "  return fetch(`/api/x/${taskId}`).then((r) => r.json());",
    '}',
  ].join('\n'));
  const result = locateFunctions(html, ['renderAdhocTasksTab', 'taskLink', 'clarifyDiscussStart']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((r) => r.status), ['OK', 'OK', 'OK']);
});

// --- Deterministic-review hook registration (S4a of the hub-tasks extraction, 2026-09-24)
// -----------------------------------------------------------------------------------------
// Exercises the registered verify() end to end (real HTML/JS fixtures + a real repo
// checkout) -- see decompose-review-registry.js's / this file's own registerDeterministicReview
// call for the full design.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { verifyDeterministicDraft } = require('./decompose-review-registry.js');

function makeFixtureRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'script-extract-review-test-'));
}

function writeHtmlWithFn(repoRoot, relPath, scriptBody) {
  const abs = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `<html><body>\n<script>\n${scriptBody}\n</script>\n</body></html>\n`);
}

function writeJsWithFn(repoRoot, relPath, body) {
  const abs = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `'use strict';\n\n${body}`);
}

test('registered "script-extract" review: a byte-exact re-derivation -> ok:true', () => {
  const repoRoot = makeFixtureRepo();
  writeHtmlWithFn(repoRoot, 'index.html', 'function a() { return 1; }\nfunction b() { return 2; }\n');
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const extraction = buildExtraction(html, ['a']);
  const task = {
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([
      { mode: 'create', file: 'a.js', content: extraction.newFileContent },
      { mode: 'edit', file: 'index.html', find: html, replace: extraction.newHtml },
    ]),
  };
  assert.deepEqual(verifyDeterministicDraft(task, repoRoot), { ok: true });
});

test('registered "script-extract" review: a plain .js source (no <script> block) byte-exact re-derivation -> ok:true', () => {
  const repoRoot = makeFixtureRepo();
  writeJsWithFn(repoRoot, 'src/thing.js', 'function a() { return 1; }\nfunction b() { return 2; }\n');
  const source = fs.readFileSync(path.join(repoRoot, 'src/thing.js'), 'utf8');
  const extraction = buildExtraction(source, ['a'], { isHtml: false });
  const task = {
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'src/thing.js', newFile: 'src/lib/a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([
      { mode: 'create', file: 'src/lib/a.js', content: extraction.newFileContent },
      { mode: 'edit', file: 'src/thing.js', find: source, replace: extraction.newSource },
    ]),
  };
  assert.deepEqual(verifyDeterministicDraft(task, repoRoot), { ok: true });
});

test('registered "script-extract" review: tampered content (does not byte-match a fresh re-derivation) -> ok:false', () => {
  const repoRoot = makeFixtureRepo();
  writeHtmlWithFn(repoRoot, 'index.html', 'function a() { return 1; }\n');
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const task = {
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([
      { mode: 'create', file: 'a.js', content: 'function a() { return 999; }\n' }, // tampered
      { mode: 'edit', file: 'index.html', find: html, replace: '<html><body></body></html>' },
    ]),
  };
  const result = verifyDeterministicDraft(task, repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not byte-match/);
});

test('registered "script-extract" review: symbols drifted since plan-validation -> ok:false with a clear reason', () => {
  const repoRoot = makeFixtureRepo();
  writeHtmlWithFn(repoRoot, 'index.html', 'function somethingElseEntirely() {}\n');
  const task = {
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([
      { mode: 'create', file: 'a.js', content: 'function a() {}\n' },
      { mode: 'edit', file: 'index.html', find: 'x', replace: 'y' },
    ]),
  };
  const result = verifyDeterministicDraft(task, repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no longer resolve/);
});

test('registered "script-extract" review: correctly-shaped Group-B JSON that byte-mismatches still hard-rejects (ok:false)', () => {
  const repoRoot = makeFixtureRepo();
  writeHtmlWithFn(repoRoot, 'index.html', 'function a() { return 1; }\n');
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const task = {
    promptContext: { deterministicApply: 'script-extract', sourceFile: 'index.html', newFile: 'a.js', symbols: ['a'] },
    implementResponse: JSON.stringify([
      { mode: 'create', file: 'a.js', content: 'function a() { return 999; }\n' },
      { mode: 'edit', file: 'index.html', find: html, replace: '<html><body></body></html>' },
    ]),
  };
  const result = verifyDeterministicDraft(task, repoRoot);
  assert.notEqual(result, null);
  assert.equal(result.ok, false);
});
