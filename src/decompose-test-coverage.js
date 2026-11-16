'use strict';

// Test-coverage helpers for decompose (HUB0519 1/3). Pure string logic: no I/O, no timers,
// no network. queueSubTasks in src/apply-adhoc-diff.js (HUB0519 2/3) calls these to block a
// decompose whose parent task asks for tests when no piece writes any test file.

const TESTS_REASON = 'no piece writes the tests the task asks for';

// Word-bounded and case-insensitive: Tests, test, Done when, mutant. Words such as testing do not match.
const TEST_REQUIREMENT_RE = /\b(?:Tests?|test|Done\s+when|mutant)\b/i;

// Repo-relative test-file shapes. The first pattern is ^tests/ (with the slash, as the contract
// writes it), so a path such as testsuite/x.js does not count.
const TEST_FILE_PATTERNS = [/^tests\//, /\.test\.js$/, /(^|\/)test_[^/]*\.py$/];

// True when any sentence of the parent task text asks for tests, a Done-when check, or mutants.
// Sentences are split on terminal punctuation followed by whitespace, and on newlines. This is a
// heuristic: abbreviations such as e.g. can split early, which is acceptable for this check.
function parentRequiresTests(parentText) {
  if (typeof parentText !== 'string' || !parentText.trim()) return false;
  return parentText
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => TEST_REQUIREMENT_RE.test(sentence));
}

// True when any of the piece's declared repo-relative paths is a test file.
function pieceNamesTestFile(piece) {
  if (!piece || !Array.isArray(piece.files)) return false;
  return piece.files.some(
    (file) => typeof file === 'string' && TEST_FILE_PATTERNS.some((re) => re.test(file))
  );
}

module.exports = { parentRequiresTests, pieceNamesTestFile, TESTS_REASON };
