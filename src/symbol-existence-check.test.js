'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { symbolDefinedInFile, appendDismissal } = require('./symbol-existence-check.js');

function tmpFile(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-check-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

test('matches python def, async def and class', () => {
  const p = tmpFile('a.py', 'x = 1\ndef foo(a):\n    pass\n');
  assert.deepEqual(symbolDefinedInFile(p, 'foo'), { found: true, line: 2, kind: 'def' });
  const q = tmpFile('b.py', 'async def bar(x):\n    pass\n');
  assert.deepEqual(symbolDefinedInFile(q, 'bar'), { found: true, line: 1, kind: 'def' });
  const r = tmpFile('c.py', 'class Baz:\n    pass\n');
  assert.deepEqual(symbolDefinedInFile(r, 'Baz'), { found: true, line: 1, kind: 'class' });
});

test('matches js function, export, async, class and const/let/var', () => {
  const p = tmpFile('a.js', 'function f() {}\nexport async function g() {}\nexport class K {}\nconst c = 1;\nlet l = 2;\nvar v = 3;\n');
  assert.deepEqual(symbolDefinedInFile(p, 'f'), { found: true, line: 1, kind: 'function' });
  assert.deepEqual(symbolDefinedInFile(p, 'g'), { found: true, line: 2, kind: 'function' });
  assert.deepEqual(symbolDefinedInFile(p, 'K'), { found: true, line: 3, kind: 'class' });
  assert.deepEqual(symbolDefinedInFile(p, 'c'), { found: true, line: 4, kind: 'const' });
  assert.deepEqual(symbolDefinedInFile(p, 'l'), { found: true, line: 5, kind: 'let' });
  assert.deepEqual(symbolDefinedInFile(p, 'v'), { found: true, line: 6, kind: 'var' });
});

test('a bare substring in a comment or string does not match', () => {
  const p = tmpFile('c.js', '// symbol foo used here\nconst s = "function foo";\nconst x = foo();\n');
  assert.deepEqual(symbolDefinedInFile(p, 'foo'), { found: false, line: null, kind: null });
});

test('regex metacharacters in the symbol are literal', () => {
  const p = tmpFile('d.js', 'function axb() {}\n');
  assert.equal(symbolDefinedInFile(p, 'a.b').found, false);
  assert.equal(symbolDefinedInFile(p, 'axb').found, true);
});

test('missing file returns found:false', () => {
  assert.deepEqual(
    symbolDefinedInFile(path.join(os.tmpdir(), 'no-such-dir-xyz', 'nope.js'), 'foo'),
    { found: false, line: null, kind: null }
  );
});

test('appendDismissal creates nested dir and appends two JSON lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismiss-'));
  const log = path.join(dir, 'nested', 'deep', 'dismissals.jsonl');
  const rec = { taskId: 't1', claim: 'c', path: 'src/x.js', symbol: 'foo', line: 3 };
  appendDismissal(rec, log);
  appendDismissal(rec, log);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const l of lines) {
    const obj = JSON.parse(l);
    for (const k of ['taskId', 'claim', 'path', 'symbol', 'line', 'timestamp']) {
      assert.ok(k in obj, 'missing ' + k);
    }
  }
});
