'use strict';

// test-command-recogniser.js: recognises shell commands that run a test suite (node --test, npm test, pytest, python -m unittest, jest, vitest, go test, ...)
// and decides whether a test run's result is red. Pure functions: no I/O, no timers, no spawns.

const SEPARATORS = /&&|\|\||;|\||\n/;

const TEST_PATTERNS = [
  ['node --test', /^node\s.*--test\b/],
  ['npm test', /^npm\s+(?:run\s+)?test\b/],
  ['pytest', /^(?:python3?\s+-m\s+)?pytest\b/],
  ['unittest', /\bpython3?\s+-m\s+unittest\b/],
  ['jest', /^(?:npx\s+)?jest\b/],
  ['vitest', /^(?:npx\s+)?vitest\b/],
  ['go test', /^go\s+test\b/],
  ['mocha', /^(?:npx\s+)?mocha\b/],
  ['cargo test', /^cargo\s+test\b/],
  ['rspec', /^(?:bundle\s+exec\s+)?rspec\b/],
];

const FAIL_COUNT_LINE = /^\s*#\s*fail\s+(\d+)\s*$/gm;
const UNITTEST_FAILED = /^FAILED\s*\(/m;

// Collapse whitespace runs to one space and trim. Idempotent.
function normaliseCommand(cmd) {
  return String(cmd ?? '').replace(/\s+/g, ' ').trim();
}

// Split a compound command on && || ; | and newlines, then test each segment (leading VAR=value assignments ignored).
function classifyTestCommand(cmd) {
  for (const raw of String(cmd ?? '').split(SEPARATORS)) {
    const seg = normaliseCommand(raw).replace(/^(?:[A-Za-z_]\w*=\S+\s+)+/, '');
    for (const [framework, re] of TEST_PATTERNS) {
      if (re.test(seg)) return { isTest: true, framework };
    }
  }
  return { isTest: false, framework: null };
}

// Red when: test command AND (timedOut, or exit null/non-zero, or a '# fail N' line with N > 0, or a unittest FAILED summary).
// Non-test commands and error-only results (an error with no output) are not red.
function isRedRun(result) {
  const r = result || {};
  if (!classifyTestCommand(r.command).isTest) return false;
  if (r.timedOut === true) return true;
  const output = String(r.output ?? '');
  const hasOutput = output.trim().length > 0;
  if (!hasOutput && r.error) return false;
  if (r.exitCode === null || (typeof r.exitCode === 'number' && r.exitCode !== 0)) return true;
  if (!hasOutput) return false;
  for (const m of output.matchAll(FAIL_COUNT_LINE)) {
    if (Number(m[1]) > 0) return true;
  }
  return UNITTEST_FAILED.test(output);
}

// The last n characters of trimmed text, behind a '...' prefix when truncated.
function tailOf(text, n = 500) {
  const t = String(text ?? '').trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
}

module.exports = { normaliseCommand, classifyTestCommand, isRedRun, tailOf };
