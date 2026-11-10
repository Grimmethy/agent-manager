'use strict';

// Hard-fail size ratchet: a source file over AGENT_MANAGER_MAX_FILE_LINES (500) or a function over AGENT_MANAGER_MAX_FUNCTION_LINES (100) fails this test unless it is
// frozen on config/size-ratchet-allowlist.json, and a frozen entry fails it when it grows past its cap. Tests count. Lower an entry with scripts/size-ratchet-regen.js.
// The three failure modes are demonstrated below on temporary trees; the last test runs the real check on this repository.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanOffenders, allowlistPath, repoRoot } = require('../scripts/size-ratchet-regen.js');

const LIMITS = { maxFileLines: 500, maxFunctionLines: 100 };

// -> readable violations: offenders that are not on the allowlist, and listed offenders above their cap.
function checkRatchet(current, allowlist) {
  const problems = [];
  for (const kind of ['files', 'functions']) {
    const label = kind === 'files' ? 'file' : 'function';
    for (const [key, lines] of Object.entries(current[kind])) {
      const cap = (allowlist[kind] || {})[key];
      if (cap === undefined) problems.push(`${label} ${key} has ${lines} lines and is not on the allowlist`);
      else if (lines > cap) problems.push(`${label} ${key} grew to ${lines} lines (cap ${cap})`);
    }
  }
  return problems;
}

function tempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'size-ratchet-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const longFile = (n) => 'const x = 1;\n'.repeat(n);
const longFunction = (n) => `function big() {\n${'  const y = 1;\n'.repeat(n - 2)}}\n`;

test('failure mode 1: a file over the limit that is not on the allowlist', () => {
  const root = tempTree({ 'src/big.js': longFile(501) });
  const problems = checkRatchet(scanOffenders(root, LIMITS), { files: {}, functions: {} });
  assert.deepEqual(problems, ['file src/big.js has 501 lines and is not on the allowlist']);
});

test('failure mode 2: a function over the limit that is not on the allowlist', () => {
  const root = tempTree({ 'src/fn.js': longFunction(120) });
  const problems = checkRatchet(scanOffenders(root, LIMITS), { files: {}, functions: {} });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /function src\/fn\.js::big has 120 lines and is not on the allowlist/);
});

test('failure mode 3: a listed entry that grew beyond its cap', () => {
  const root = tempTree({ 'src/big.js': longFile(520) });
  const problems = checkRatchet(scanOffenders(root, LIMITS), { files: { 'src/big.js': 510 }, functions: {} });
  assert.deepEqual(problems, ['file src/big.js grew to 520 lines (cap 510)']);
});

test('a listed entry at or under its cap, and a file at the limit, pass', () => {
  const root = tempTree({ 'src/big.js': longFile(510), 'src/ok.js': longFile(500) });
  assert.deepEqual(checkRatchet(scanOffenders(root, LIMITS), { files: { 'src/big.js': 510 }, functions: {} }), []);
});

test('non-source files are never counted', () => {
  const root = tempTree({ 'docs/long.md': longFile(900), 'data.json': longFile(900) });
  assert.deepEqual(scanOffenders(root, LIMITS), { files: {}, functions: {} });
});

test('this repository: every offender is frozen on the allowlist and none has grown', () => {
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath(), 'utf8'));
  const problems = checkRatchet(scanOffenders(repoRoot()), allowlist);
  assert.deepEqual(problems, [], `size ratchet violations (lower with scripts/size-ratchet-regen.js, never raise a cap):\n  ${problems.join('\n  ')}`);
});
