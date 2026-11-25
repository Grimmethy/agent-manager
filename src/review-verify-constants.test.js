'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractChangedSymbols, findTestsWithSymbolFallback } = require('./review-verify');

// A minimal unified diff for one file: `hunkCtx` is the text after the @@ header, `lines` are the hunk body lines (already prefixed).
function makeDiff(file, hunkCtx, lines) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,3 +1,3 @@${hunkCtx ? ` ${hunkCtx}` : ''}`,
    ...lines,
    '',
  ].join('\n');
}

test('a changed column-0 module constant is extracted as a symbol', () => {
  const diff = makeDiff('python/dashboard/routes/pipeline_ops_workers.py', '', [
    '-WORKERS = ("scout",)',
    '+WORKERS = (',
  ]);
  assert.ok(extractChangedSymbols(diff).includes('WORKERS'));
});

test('an indented assignment inside a def adds no symbol', () => {
  const diff = makeDiff('python/dashboard/routes/pipeline_ops_workers.py', '', [
    '-    LOCALS = 0',
    '+    LOCALS = 1',
  ]);
  const symbols = extractChangedSymbols(diff);
  assert.ok(!symbols.includes('LOCALS'));
  assert.deepStrictEqual(symbols, []);
});

test('the symbol fallback finds a registry test that mentions the changed constant', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvc-'));
  try {
    fs.mkdirSync(path.join(root, 'python/dashboard/routes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'python/dashboard/routes/foo.py'), 'WORKERS = (\n    "a",\n)\n');
    fs.writeFileSync(path.join(root, 'python/dashboard/test_foo_registry.py'), 'from routes.foo import WORKERS\n\n\ndef test_registry():\n    assert WORKERS\n');
    const diff = makeDiff('python/dashboard/routes/foo.py', '', ['-WORKERS = ()', '+WORKERS = (']);
    const res = findTestsWithSymbolFallback(root, ['python/dashboard/routes/foo.py'], diff);
    assert.ok(res.py.includes('python/dashboard/test_foo_registry.py'), JSON.stringify(res));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
