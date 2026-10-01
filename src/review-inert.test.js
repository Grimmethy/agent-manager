'use strict';

// Tests for review-inert.js (the inert-addition check, brain dump #1665). Run: node --test src/review-inert.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { findInertAdditions, parseDiffFiles, topLevelDefinitions, isTestPath, MAX_CANDIDATES } = require('./review-inert.js');

function fileDiff(file, added, { isNew = false, start = 1, deleted = false } = {}) {
  const head = `diff --git a/${file} b/${file}\n${isNew ? 'new file mode 100644\n--- /dev/null\n' : deleted ? 'deleted file mode 100644\n--- a/' + file + '\n' : `--- a/${file}\n`}+++ b/${file}\n`;
  const n = added.length;
  return `${head}${isNew ? `@@ -0,0 +1,${n} @@` : `@@ -${start},0 +${start},${n} @@`}\n${added.map((l) => `+${l}`).join('\n')}\n`;
}
const noGrep = () => [];                                   // nothing on the base mentions the name
const find = (parts, grep = noGrep) => findInertAdditions({ rawDiff: parts.join(''), repoRoot: '/repo', baseRef: 'origin/master', grep });
const names = (r) => r.inert.map((i) => i.name);

test('parseDiffFiles reads status flags and the new-file line number of every added line', () => {
  const diff = fileDiff('src/a.js', ['one', 'two'], { start: 10 }) + fileDiff('src/new.js', ['x'], { isNew: true }) + fileDiff('src/old.js', ['y'], { deleted: true })
    + 'diff --git a/src/r1.js b/src/r2.js\nsimilarity index 90%\nrename from src/r1.js\nrename to src/r2.js\n';
  const files = parseDiffFiles(diff);
  assert.deepEqual(files.map((f) => [f.file, f.isNew, f.isDeleted, f.isRename]), [['src/a.js', false, false, false], ['src/new.js', true, false, false], ['src/old.js', false, true, false], ['src/r2.js', false, false, true]]);
  assert.deepEqual(files[0].added, [{ line: 10, text: 'one' }, { line: 11, text: 'two' }]);
  assert.deepEqual(parseDiffFiles(undefined), []);
});

test('topLevelDefinitions finds new top-level functions and classes in js and python, and skips methods, short names and the stoplist', () => {
  const js = parseDiffFiles(fileDiff('src/a.js', [
    'function plainHelper(a) {', '  function nestedHelper() {}', '}', 'async function fetchThing() {}', 'const arrowOne = (x) => x;', 'const arrowTwo = async x => x;',
    'const fnExpr = function () {};', 'class Widget {', '  method() {}', '}', 'function run() {}', 'function abc() {}', 'const value = 5;',
  ]))[0];
  assert.deepEqual(topLevelDefinitions(js).map((d) => [d.kind, d.name]), [['function', 'plainHelper'], ['function', 'fetchThing'], ['function', 'arrowOne'], ['function', 'arrowTwo'], ['function', 'fnExpr'], ['class', 'Widget']]);
  const py = parseDiffFiles(fileDiff('python/x.py', ['def top_level(a):', '    def inner_helper():', '        pass', 'async def fetch_all():', '    pass', 'class Thing:', '    def method(self):', '        pass']))[0];
  assert.deepEqual(topLevelDefinitions(py).map((d) => d.name), ['top_level', 'fetch_all', 'Thing']);
});

test('a new function nothing references is inert, and the report carries where it is', () => {
  const r = find([fileDiff('src/a.js', ['// header', 'function orphanHelper() {}'], { start: 20 })]);
  assert.deepEqual(r.inert, [{ kind: 'function', name: 'orphanHelper', file: 'src/a.js', line: 21 }]);
  assert.equal(r.considered, 1);
});

test('a call from another file the diff changes, or from another function in the same file, makes it used', () => {
  assert.deepEqual(find([fileDiff('src/a.js', ['function usedElsewhere() {}']), fileDiff('src/b.js', ['  return usedElsewhere();'], { start: 5 })]).inert, []);
  assert.deepEqual(find([fileDiff('src/a.js', ['function usedHere() {}', '', 'function caller() {', '  return usedHere();', '}'])]).inert.map((i) => i.name), ['caller']);
});

test('a use only in a test file, an export list or a comment does not count', () => {
  const def = fileDiff('src/a.js', ['function onlyTested() {}', 'function onlyExported() {}', 'function onlyCommented() {}', 'function onlyInBlock() {}', '// onlyCommented is wired later', 'module.exports = { onlyExported };']);
  const test_ = fileDiff('src/a.test.js', ["const { onlyTested } = require('./a.js');", 'onlyTested();']);
  assert.deepEqual(names(find([def, test_])).sort(), ['onlyCommented', 'onlyExported', 'onlyInBlock', 'onlyTested']);
  const block = fileDiff('src/c.js', ['function wrapped() {}', 'module.exports = {', '  wrapped,', '  other,', '};']);
  assert.deepEqual(names(find([block])), ['wrapped']);
  assert.deepEqual(names(find([fileDiff('src/c.js', ['function inAll() {}', "__all__ = ['inAll']"])])), ['inAll']);
});

test('a name the base already mentions in non-test code (a call site waiting for it) is used; a failed lookup is unknown, never inert', () => {
  const diff = [fileDiff('src/a.js', ['function waitedFor() {}'])];
  assert.deepEqual(find(diff, () => ['origin/master:src/caller.js']).inert, []);
  const r = find(diff, () => { throw new Error('git exploded'); });
  assert.deepEqual([r.inert, r.unknown], [[], 1]);
  const f = find([fileDiff('src/new-lib.js', ['function thing() {}'], { isNew: true })], () => { throw new Error('git exploded'); });
  assert.deepEqual([f.inert, f.unknown], [[], 1], 'the same for a new file');
});

test('a new source file is inert unless something names it: require, script tag, base reference; entrypoints, tests and docs are not judged', () => {
  const lib = fileDiff('src/new-lib.js', ['function thing() {}'], { isNew: true });
  assert.deepEqual(find([lib]).inert, [{ kind: 'file', name: 'new-lib.js', file: 'src/new-lib.js', line: 1 }]);
  assert.deepEqual(find([lib, fileDiff('src/b.js', ["const x = require('./new-lib.js');"])]).inert, []);
  assert.deepEqual(find([lib, fileDiff('src/b.js', ["const x = require('./new-lib');"])]).inert, []);
  assert.deepEqual(find([lib, fileDiff('templates/index.html', ['<script src="/static/js/new-lib.js"></script>'])]).inert, []);
  assert.deepEqual(find([lib], () => ['origin/master:templates/index.html']).inert, [], 'the base template already loads it');
  assert.deepEqual(find([fileDiff('src/cli.js', ['#!/usr/bin/env node', 'run();'], { isNew: true })]).inert, []);
  assert.deepEqual(find([fileDiff('src/tool.js', ['if (require.main === module) main();'], { isNew: true })]).inert, []);
  assert.deepEqual(find([fileDiff('src/x.test.js', ['test(1)'], { isNew: true }), fileDiff('docs/x.md', ['hi'], { isNew: true })]).inert, []);
  assert.deepEqual(find([lib, fileDiff('src/new-lib.test.js', ["require('./new-lib.js')"], { isNew: true })]).inert.length, 1, 'only its own test references it');
});

test('a new file under static/ is served to the browser, so a require() does not load it: only a script tag, link or import does', () => {
  const asset = fileDiff('python/dashboard/static/js/lib/models.js', ['function render() {}'], { isNew: true });
  const viaRequire = fileDiff('python/dashboard/static/js/core-ui.js', ["const { render } = require('./lib/models.js');"], { start: 2 });
  assert.equal(find([asset, viaRequire]).inert.length, 1, 'require() in a browser file is not a load');
  assert.deepEqual(find([asset, fileDiff('python/dashboard/templates/index.html', ['<script src="{{ url_for(\'static\', filename=\'js/lib/models.js\') }}"></script>'])]).inert, []);
  assert.deepEqual(find([asset, fileDiff('python/dashboard/static/js/core-ui.js', ["import { render } from './lib/models.js';"])]).inert, []);
  assert.deepEqual(find([asset], () => ['origin/master:python/dashboard/templates/index.html']).inert, [], 'the base template already loads it');
  assert.equal(find([asset], () => ['origin/master:python/dashboard/static/js/other.js']).inert.length, 1, 'a base js file merely mentioning it does not load it');
  const nodeSide = fileDiff('src/new-lib.js', ['function thing() {}'], { isNew: true });
  assert.deepEqual(find([nodeSide, fileDiff('src/b.js', ["require('./new-lib.js');"])]).inert, [], 'outside static/ a require() is a real use');
});

test('a new python module is used by an import elsewhere', () => {
  const mod = fileDiff('python/dashboard/branch_thing.py', ['def build_thing():', '    return 1'], { isNew: true });
  assert.equal(find([mod]).inert.length, 1);
  assert.deepEqual(find([mod, fileDiff('python/dashboard/app.py', ['from branch_thing import build_thing'], { start: 3 })]).inert, []);
});

test('deleted and renamed files are ignored, at most MAX_CANDIDATES are looked at, and garbage input never throws', () => {
  assert.deepEqual(find([fileDiff('src/gone.js', ['function removedHelper() {}'], { deleted: true })]).inert, []);
  const many = fileDiff('src/m.js', Array.from({ length: MAX_CANDIDATES + 10 }, (_, i) => `function helperNumber${i}() {}`));
  assert.equal(find([many]).considered, MAX_CANDIDATES);
  for (const bad of [undefined, null, '', 12, 'not a diff at all']) assert.deepEqual(findInertAdditions({ rawDiff: bad }).inert, []);
  assert.doesNotThrow(() => findInertAdditions({ rawDiff: fileDiff('src/a.js', ['function whatever() {}']), grep: 'nope' }));
  assert.equal(isTestPath('python/dashboard/test_x.py'), true);
});

test('integration: with real git, a helper the base already calls is used, an orphan helper and an unreferenced new file are inert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-inert-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q', '-b', 'master');
    fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'templates'));
    fs.writeFileSync(path.join(dir, 'src', 'caller.js'), 'const x = waitedForHelper();\n');
    fs.writeFileSync(path.join(dir, 'templates', 'index.html'), '<script src="/static/js/widget.js"></script>\n');
    fs.writeFileSync(path.join(dir, 'src', 'caller.test.js'), 'orphanHelper();\n');
    git('add', '-A'); git('commit', '-q', '-m', 'base');
    const diff = [fileDiff('src/lib.js', ['function waitedForHelper() {}', 'function orphanHelper() {}']), fileDiff('static/js/widget.js', ['var w = 1;'], { isNew: true }), fileDiff('static/js/orphan.js', ['var o = 1;'], { isNew: true })].join('');
    const r = findInertAdditions({ rawDiff: diff, repoRoot: dir, baseRef: 'HEAD' });
    assert.deepEqual(r.inert.map((i) => i.name).sort(), ['orphan.js', 'orphanHelper'], 'a mention only in a base TEST file does not make orphanHelper used');
    assert.equal(r.unknown, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
