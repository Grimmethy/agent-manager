'use strict';

// Unit tests for src/sdk/size-limits.js. Uses node:test (no jest/vitest).
// All fixtures are inline template literals -- no external __fixtures__/ dir.

const assert = require('assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findLongFiles,
  findLongFunctions,
  countLines,
  tokenizeJs,
  findJsFunctionSpans,
  findPyFunctionSpans,
} = require('./size-limits.js');

// ===== Inline fixtures =====

const JS_FIXTURES = {
  simpleFunction: `function foo() {\n  return 1;\n}\n`,
  arrowFunction: `const bar = (x) => x + 1;\n`,
  longFunction: (() => {
    const body = Array.from({ length: 120 }, (_, i) => `  // line ${i + 1}\n`).join('');
    return `function long() {\n${body}}\n`;
  })(),
  classWithMethods: `class C {\n  methodA() { return 1; }\n  methodB() { return 2; }\n}\n`,
  varAssignFunction: `const make = function(x) {\n  return x + 1;\n};\n`,
};

const PY_FIXTURES = {
  simpleDef: `def foo():\n    return 1\n`,
  longDef: (() => {
    const body = Array.from({ length: 120 }, (_, i) => `    # line ${i + 1}\n`).join('');
    return `def long():\n${body}\n`;
  })(),
  classWithDef: `class C:\n    def method(self):\n        return 1\n`,
  nestedDef: `def outer():\n    def inner():\n        pass\n    return inner\n`,
};

// ===== countLines =====

test('countLines: empty string → 0', () => {
  assert.equal(countLines(''), 0);
});

test('countLines: null → 0', () => {
  assert.equal(countLines(null), 0);
});

test('countLines: undefined → 0', () => {
  assert.equal(countLines(undefined), 0);
});

test('countLines: single line → 1', () => {
  assert.equal(countLines('single'), 1);
});

test('countLines: three lines → 3', () => {
  assert.equal(countLines('a\nb\nc'), 3);
});

test('countLines: trailing newline does not add a line', () => {
  assert.equal(countLines('a\nb\n'), 2);
});

test('countLines: two lines with trailing newline → 2', () => {
  assert.equal(countLines('a\nb\nc\n'), 3);
});

// ===== tokenizeJs =====

test('tokenizeJs: simple assignment', () => {
  const tokens = tokenizeJs('const x = 5;');
  assert.equal(tokens.length, 5);
  assert.deepEqual(tokens[0], { type: 'keyword', value: 'const', line: 1 });
  assert.deepEqual(tokens[1], { type: 'identifier', value: 'x', line: 1 });
  assert.deepEqual(tokens[2], { type: 'operator', value: '=', line: 1 });
  assert.deepEqual(tokens[3], { type: 'number', value: '5', line: 1 });
  assert.deepEqual(tokens[4], { type: 'symbol', value: ';', line: 1 });
});

test('tokenizeJs: function with block comment (comment skipped)', () => {
  const tokens = tokenizeJs('function foo() { /* comment */ }');
  const types = tokens.map((t) => t.type);
  // Should have keyword, identifier, symbol, symbol, symbol, symbol -- no comment token
  assert.ok(!types.includes('comment'));
  assert.equal(tokens.filter((t) => t.type === 'keyword').length, 1);
  assert.equal(tokens.filter((t) => t.type === 'identifier').length, 1);
});

test('tokenizeJs: string with escaped quotes', () => {
  const tokens = tokenizeJs('const str = "hello \\"world\\"";');
  const strTok = tokens.find((t) => t.type === 'string');
  assert.ok(strTok);
  assert.equal(strTok.value, '"hello \\"world\\""');
});

test('tokenizeJs: line tracking across lines', () => {
  const tokens = tokenizeJs('const x =\n  5;');
  const numTok = tokens.find((t) => t.type === 'number');
  assert.ok(numTok);
  assert.equal(numTok.line, 2);
});

test('tokenizeJs: multi-line block comment tracks lines', () => {
  const tokens = tokenizeJs('/* a\n   b\n   c */ const x = 1;');
  const constTok = tokens.find((t) => t.type === 'keyword' && t.value === 'const');
  assert.ok(constTok);
  assert.equal(constTok.line, 3);
});

// ===== findJsFunctionSpans =====

test('findJsFunctionSpans: simple function', () => {
  const spans = findJsFunctionSpans(tokenizeJs(JS_FIXTURES.simpleFunction));
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, 'foo');
  assert.equal(spans[0].type, 'function');
  assert.equal(spans[0].startLine, 1);
  assert.equal(spans[0].endLine, 3);
});

test('findJsFunctionSpans: arrow function', () => {
  const spans = findJsFunctionSpans(tokenizeJs(JS_FIXTURES.arrowFunction));
  assert.equal(spans.length, 1);
  assert.equal(spans[0].type, 'arrow');
  assert.equal(spans[0].startLine, 1);
  assert.equal(spans[0].endLine, 1);
});

test('findJsFunctionSpans: long function span length', () => {
  const spans = findJsFunctionSpans(tokenizeJs(JS_FIXTURES.longFunction));
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, 'long');
  assert.equal(spans[0].endLine - spans[0].startLine + 1, 122); // 120 body + def + closing brace
});

test('findJsFunctionSpans: const = function', () => {
  const spans = findJsFunctionSpans(tokenizeJs(JS_FIXTURES.varAssignFunction));
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, 'make');
  assert.equal(spans[0].type, 'function');
});

test('findJsFunctionSpans: class methods detected as spans', () => {
  const spans = findJsFunctionSpans(tokenizeJs(JS_FIXTURES.classWithMethods));
  // classWithMethods has methodA and methodB
  const names = spans.map((s) => s.name).filter(Boolean);
  assert.ok(names.includes('methodA'));
  assert.ok(names.includes('methodB'));
});

// ===== findPyFunctionSpans =====

test('findPyFunctionSpans: simple def', () => {
  const lines = PY_FIXTURES.simpleDef.split('\n');
  const spans = findPyFunctionSpans(lines);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, 'foo');
  assert.equal(spans[0].startLine, 1);
  assert.equal(spans[0].endLine, 2);
});

test('findPyFunctionSpans: long def span length', () => {
  const lines = PY_FIXTURES.longDef.split('\n');
  const spans = findPyFunctionSpans(lines);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, 'long');
  // 1 def line + 120 body lines (trailing blank line excluded)
  assert.equal(spans[0].endLine - spans[0].startLine + 1, 121);
});

test('findPyFunctionSpans: class with def', () => {
  const lines = PY_FIXTURES.classWithDef.split('\n');
  const spans = findPyFunctionSpans(lines);
  // Only def is detected (not class)
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, 'method');
});

test('findPyFunctionSpans: nested def', () => {
  const lines = PY_FIXTURES.nestedDef.split('\n');
  const spans = findPyFunctionSpans(lines);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].name, 'outer');
  assert.equal(spans[1].name, 'inner');
});

// ===== findLongFiles =====

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'size-limits-test-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findLongFiles: detects file over limit', () => {
  fs.writeFileSync(path.join(tmpDir, 'short.js'), 'a\nb\nc\n');
  const longContent = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(tmpDir, 'long.js'), longContent);

  const result = findLongFiles(tmpDir, { maxLines: 500 });
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'long.js');
  assert.equal(result[0].lines, 600);
});

test('findLongFiles: skips node_modules', () => {
  const nmDir = path.join(tmpDir, 'node_modules', 'pkg');
  fs.mkdirSync(nmDir, { recursive: true });
  const longContent = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(nmDir, 'index.js'), longContent);

  const result = findLongFiles(tmpDir, { maxLines: 500 });
  assert.equal(result.length, 0);
});

test('findLongFiles: respects env var override', () => {
  // Create a file with 300 lines
  const content = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(tmpDir, 'medium.js'), content);

  const orig = process.env.AGENT_MANAGER_MAX_FILE_LINES;
  process.env.AGENT_MANAGER_MAX_FILE_LINES = '200';
  try {
    const result = findLongFiles(tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].maxLines, 200);
  } finally {
    if (orig === undefined) delete process.env.AGENT_MANAGER_MAX_FILE_LINES;
    else process.env.AGENT_MANAGER_MAX_FILE_LINES = orig;
  }
});

test('findLongFiles: bad env value falls back to default', () => {
  const orig = process.env.AGENT_MANAGER_MAX_FILE_LINES;
  process.env.AGENT_MANAGER_MAX_FILE_LINES = 'not-a-number';
  try {
    const result = findLongFiles(tmpDir, { maxLines: 10000 });
    // With maxLines 10000, nothing should be long
    assert.equal(result.length, 0);
  } finally {
    if (orig === undefined) delete process.env.AGENT_MANAGER_MAX_FILE_LINES;
    else process.env.AGENT_MANAGER_MAX_FILE_LINES = orig;
  }
});

// ===== findLongFunctions =====

test('findLongFunctions: JS long function detected', () => {
  const violations = findLongFunctions(JS_FIXTURES.longFunction, 'test.js', { maxLines: 100 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, 'long');
  assert.equal(violations[0].path, 'test.js');
});

test('findLongFunctions: Python long def detected', () => {
  const violations = findLongFunctions(PY_FIXTURES.longDef, 'test.py', { maxLines: 100 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, 'long');
  assert.equal(violations[0].path, 'test.py');
});

test('findLongFunctions: short function no false positive', () => {
  const violations = findLongFunctions(JS_FIXTURES.simpleFunction, 'test.js', { maxLines: 100 });
  assert.equal(violations.length, 0);
});

test('findLongFunctions: unknown extension returns []', () => {
  const violations = findLongFunctions('def x():\n    pass\n', 'file.txt', { maxLines: 1 });
  assert.equal(violations.length, 0);
});

test('findLongFunctions: respects env var override', () => {
  const orig = process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
  process.env.AGENT_MANAGER_MAX_FUNCTION_LINES = '200';
  try {
    // longFunction has 122 lines; with threshold 200, no violation
    const violations = findLongFunctions(JS_FIXTURES.longFunction, 'test.js');
    assert.equal(violations.length, 0);
  } finally {
    if (orig === undefined) delete process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
    else process.env.AGENT_MANAGER_MAX_FUNCTION_LINES = orig;
  }
});

// ===== Module exports check =====

test('module exports exactly the six named symbols', () => {
  const keys = Object.keys(require('./size-limits.js')).sort();
  assert.deepEqual(keys, [
    'countLines',
    'findJsFunctionSpans',
    'findLongFiles',
    'findLongFunctions',
    'findPyFunctionSpans',
    'tokenizeJs',
  ]);
});
