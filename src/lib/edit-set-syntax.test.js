'use strict';

// edit-set-syntax.js: every file a Group B edit set creates or edits must still parse after the set is applied in order.
// Run: node --test src/lib/edit-set-syntax.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkEditSetSyntax, syntaxFeedbackFor, syntaxSignature, syntaxGateMode, nearestPackageType } = require('./edit-set-syntax.js');
const { resolvePython } = require('./syntax-check.js');

const PY = resolvePython({});
const needPy = { skip: PY ? false : 'no python interpreter on this machine' };

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-set-syntax-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}
const PYSRC = 'import os\nfrom util import (\n    a, b,\n)\n\ndef run(x):\n    return x + 1\n';

test('AC-271 shape: an edit that splits a python import leaves the file unparsable -> failed, with the line and the lines of the RESULTING file', needPy, () => {
  const dir = repo({ 'svc/img.py': PYSRC });
  const r = checkEditSetSyntax([
    { mode: 'edit', file: 'svc/img.py', find: 'from util import', replace: 'from util import\nfrom constants import YEAR' },
  ], dir, { env: {} });
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].file, 'svc/img.py');
  assert.equal(r.failed[0].line, 2);
  assert.match(r.failed[0].error, /^svc\/img\.py:2 SyntaxError/);
  assert.match(r.failed[0].excerpt, /2\| from util import\n3\| from constants import YEAR \(/, 'the excerpt shows the file as the edit would leave it');
  const fb = syntaxFeedbackFor(r.failed);
  assert.match(fb, /leaves svc\/img\.py with a syntax error/);
  assert.match(fb, /Change the edit so the result parses/);
  assert.equal(syntaxSignature(r.failed), 'svc/img.py:2');
});

test('the corrected edit parses (checked), and nothing is written to the repo either way', needPy, () => {
  const dir = repo({ 'svc/img.py': PYSRC });
  const before = fs.readFileSync(path.join(dir, 'svc/img.py'), 'utf8');
  const r = checkEditSetSyntax([{ mode: 'edit', file: 'svc/img.py', find: 'import os', replace: 'import os\nfrom constants import YEAR' }], dir, { env: {} });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.checked, ['svc/img.py']);
  assert.equal(fs.readFileSync(path.join(dir, 'svc/img.py'), 'utf8'), before, 'the repo file is untouched');
});

test('only the RESULT of the whole set counts: a later edit that repairs an earlier one passes; a file that was already broken is preexisting, not failed', needPy, () => {
  const dir = repo({ 'a.py': PYSRC, 'broken.py': 'def f(:\n  pass\n' });
  const repaired = checkEditSetSyntax([
    { mode: 'edit', file: 'a.py', find: 'return x + 1', replace: 'return (x +' },
    { mode: 'edit', file: 'a.py', find: 'return (x +', replace: 'return x + 2' },
  ], dir, { env: {} });
  assert.deepEqual(repaired.failed, []);
  const pre = checkEditSetSyntax([{ mode: 'edit', file: 'broken.py', find: 'pass', replace: 'return 1' }], dir, { env: {} });
  assert.deepEqual(pre.failed, []);
  assert.deepEqual(pre.preexisting, ['broken.py']);
});

test('a CREATED file that does not parse fails (it cannot be "already broken"); a deleted file and an unknown type are not checked / skipped with a reason', needPy, () => {
  const dir = repo({ 'old.py': PYSRC, 'notes.md': '# x' });
  const r = checkEditSetSyntax([
    { mode: 'create', file: 'new.py', content: 'def f(:\n' },
    { mode: 'delete', file: 'old.py' },
    { mode: 'edit', file: 'notes.md', find: '# x', replace: '# y' },
  ], dir, { env: {} });
  assert.deepEqual(r.failed.map((f) => f.file), ['new.py']);
  assert.ok(!r.checked.includes('old.py'));
  assert.deepEqual(r.skipped, [{ file: 'notes.md', reason: 'no syntax checker for this file type' }]);
});

test('json and node: a broken .json fails; a broken .js fails; valid ones pass; ESM syntax follows the nearest package.json "type"', () => {
  const dir = repo({
    'cfg.json': '{"a": 1}', 'lib/a.js': 'const a = 1;\n', 'pkg/package.json': '{"type":"module"}', 'pkg/m.js': 'export const m = 1;\n', 'cjs/x.js': 'const q = 1;\n',
  });
  const bad = checkEditSetSyntax([
    { mode: 'edit', file: 'cfg.json', find: '1}', replace: '1,}' },
    { mode: 'edit', file: 'lib/a.js', find: 'const a = 1;', replace: 'const a = ;' },
  ], dir, { env: {} });
  assert.deepEqual(bad.failed.map((f) => f.file).sort(), ['cfg.json', 'lib/a.js']);
  const lineOf = bad.failed.find((f) => f.file === 'lib/a.js');
  assert.match(lineOf.error, /^lib\/a\.js:1 SyntaxError/);
  const ok = checkEditSetSyntax([
    { mode: 'edit', file: 'pkg/m.js', find: 'export const m = 1;', replace: 'export const m = 2;\nexport const n = 3;' },
    { mode: 'edit', file: 'cjs/x.js', find: 'const q = 1;', replace: 'const q = require("fs");' },
  ], dir, { env: {} });
  assert.deepEqual(ok.failed, []);
  assert.deepEqual(ok.checked.sort(), ['cjs/x.js', 'pkg/m.js']);
  assert.equal(nearestPackageType(dir, 'pkg/m.js'), 'module');
  assert.equal(nearestPackageType(dir, 'cjs/x.js'), 'commonjs');
});

function fakeEsbuildTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ess-tools-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'esbuild'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'esbuild', 'package.json'), '{"name":"esbuild","main":"index.js"}');
  fs.writeFileSync(path.join(dir, 'node_modules', 'esbuild', 'index.js'),
    "exports.transformSync = (t, o) => { const m = /BAD(\\d*)/.exec(String(t)); if (m) { const e = new Error('x'); e.errors = [{ text: 'Unexpected BAD', location: { line: Number(m[1] || 1), column: 0 } }]; throw e; } return { code: '' }; };");
  return path.join(dir, 'node_modules');
}

test('.tsx and .ts are parsed through esbuild when AGENT_MANAGER_TS_TOOLS points at it; without it .tsx is skipped with the reason and .ts uses Node\'s parser', () => {
  const dir = repo({ 'web/App.tsx': 'export const A = () => <div/>;\n', 'web/api.ts': 'export const a = 1;\n' });
  const env = { AGENT_MANAGER_TS_TOOLS: fakeEsbuildTools() };
  const bad = checkEditSetSyntax([{ mode: 'edit', file: 'web/App.tsx', find: '<div/>', replace: 'BAD3' }], dir, { env });
  assert.equal(bad.failed.length, 1);
  assert.equal(bad.failed[0].line, 3);
  assert.match(bad.failed[0].error, /^web\/App\.tsx:3 Unexpected BAD/);
  const good = checkEditSetSyntax([{ mode: 'edit', file: 'web/App.tsx', find: '<div/>', replace: '<span/>' }, { mode: 'edit', file: 'web/api.ts', find: '= 1', replace: '= 2' }], dir, { env });
  assert.deepEqual(good.checked.sort(), ['web/App.tsx', 'web/api.ts']);
  const none = checkEditSetSyntax([{ mode: 'edit', file: 'web/App.tsx', find: '<div/>', replace: '<span/>' }], dir, { env: {} });
  assert.match(none.skipped[0].reason, /no \.tsx parser/);
  assert.deepEqual(none.failed, []);
  if (typeof require('node:module').stripTypeScriptTypes === 'function') {
    const ts = checkEditSetSyntax([{ mode: 'edit', file: 'web/api.ts', find: 'export const a = 1;', replace: 'export function g( {' }], dir, { env: {} });
    assert.deepEqual(ts.failed.map((f) => f.file), ['web/api.ts']);
  }
});

test('no python interpreter -> python files are skipped, not failed; a find failure leaves the text unchanged; garbage input never throws; mode env', () => {
  const dir = repo({ 'a.py': PYSRC });
  const r = checkEditSetSyntax([{ mode: 'edit', file: 'a.py', find: 'import os', replace: 'import (' }], dir, { env: {}, py: null });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.skipped, [{ file: 'a.py', reason: 'no python interpreter available' }]);
  assert.deepEqual(checkEditSetSyntax(null, '/nope'), { checked: [], skipped: [], failed: [], preexisting: [] });
  assert.deepEqual(checkEditSetSyntax([null, 5, { mode: 'edit' }], '/nope'), { checked: [], skipped: [], failed: [], preexisting: [] });
  assert.equal(syntaxGateMode({}), 'block');
  assert.equal(syntaxGateMode({ AGENT_MANAGER_EDIT_SYNTAX_GATE: 'ADVISORY' }), 'advisory');
  assert.equal(syntaxGateMode({ AGENT_MANAGER_EDIT_SYNTAX_GATE: 'off' }), 'off');
});

test('ESM syntax in a file whose package is CommonJS is a module-format ambiguity: SKIPPED with a reason, never a syntax failure', () => {
  const dir = repo({ 'package.json': '{}', 'x.js': 'const a = 1;\n' });
  const r = checkEditSetSyntax([{ mode: 'edit', file: 'x.js', find: 'const a = 1;', replace: 'import fs from "fs";\nexport const a = 1;' }], dir, { env: {} });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.skipped, [{ file: 'x.js', reason: 'module-format ambiguity (not a syntax error)' }]);
});
