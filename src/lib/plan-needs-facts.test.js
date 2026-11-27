'use strict';

// Tests for plan-needs-facts.js -- the pure detection module that flags when a plan
// response needs an orient pass (part 1 of 2 of the one-time re-orient plan).

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPlanNeedsFacts, buildReorientFocus } = require('./plan-needs-facts.js');

// --- Empty plan fixtures ---

test('isPlanNeedsFacts: empty string returns true (needs facts)', () => {
  assert.equal(isPlanNeedsFacts(''), true);
});

test('isPlanNeedsFacts: whitespace-only string returns true (needs facts)', () => {
  assert.equal(isPlanNeedsFacts('   \n  '), true);
});

test('isPlanNeedsFacts: undefined returns true (needs facts)', () => {
  assert.equal(isPlanNeedsFacts(undefined), true);
});

test('isPlanNeedsFacts: null returns true (needs facts)', () => {
  assert.equal(isPlanNeedsFacts(null), true);
});

test('isPlanNeedsFacts: allowEmpty option suppresses empty flag', () => {
  assert.equal(isPlanNeedsFacts('', { allowEmpty: true }), false);
  assert.equal(isPlanNeedsFacts('   ', { allowEmpty: true }), false);
  assert.equal(isPlanNeedsFacts(undefined, { allowEmpty: true }), false);
});

test('isPlanNeedsFacts: allowEmpty false explicitly still flags empty', () => {
  assert.equal(isPlanNeedsFacts('', { allowEmpty: false }), true);
});

// --- Tool-call markup fixtures ---

test('isPlanNeedsFacts: <tool_call markup returns true', () => {
  assert.equal(isPlanNeedsFacts('I will use <tool_call> to read the file'), true);
});

test('isPlanNeedsFacts: <invoke markup returns true', () => {
  assert.equal(isPlanNeedsFacts('Let me <invoke name="read_file">'), true);
});

test('isPlanNeedsFacts: <function markup returns true', () => {
  assert.equal(isPlanNeedsFacts('Calling <function read_file> now'), true);
});

test('isPlanNeedsFacts: tool-call markup anywhere in text returns true', () => {
  assert.equal(isPlanNeedsFacts('Here is the plan:\n1. Use <tool_call>\n2. Done'), true);
});

// --- Stop-to-read phrase fixtures ---

test('isPlanNeedsFacts: "let me start by reading" returns true', () => {
  assert.equal(isPlanNeedsFacts('let me start by reading the code'), true);
});

test('isPlanNeedsFacts: "let me read the key files" returns true', () => {
  assert.equal(isPlanNeedsFacts('let me read the key files first'), true);
});

test('isPlanNeedsFacts: "before creating the plan" returns true', () => {
  assert.equal(isPlanNeedsFacts('I need to understand the codebase before creating the plan'), true);
});

test('isPlanNeedsFacts: "let me read the relevant files" returns true', () => {
  assert.equal(isPlanNeedsFacts('let me read the relevant files'), true);
});

test('isPlanNeedsFacts: case-insensitive stop-to-read match', () => {
  assert.equal(isPlanNeedsFacts('LET ME START BY READING'), true);
  assert.equal(isPlanNeedsFacts('Let Me Start By Reading'), true);
});

test('isPlanNeedsFacts: stop-to-read phrase detected anywhere in text', () => {
  // Phrase in middle of text should trigger
  assert.equal(isPlanNeedsFacts('First let me start by reading the code, then I will write a plan'), true);
  // At the end it should also trigger
  assert.equal(isPlanNeedsFacts('I need to look at the code, let me start by reading'), true);
});

// --- Real plan fixtures (should return false) ---

test('isPlanNeedsFacts: plan with numbered steps and CRITERIA returns false', () => {
  const plan = `1. Inspect the current code
2. Make the change
3. Verify

CRITERIA:
- Tests pass
- No regressions`;
  assert.equal(isPlanNeedsFacts(plan), false);
});

test('isPlanNeedsFacts: plan with markdown heading steps and CRITERIA returns false', () => {
  const plan = `## 1. Locate the detail modal
The modal is rendered in src/ui.js.

## 2. Adjust the header layout
Update the flex container.

### 3. Verify
Run the dashboard.

CRITERIA:
- Header renders at 320px
- Header renders at 1280px`;
  assert.equal(isPlanNeedsFacts(plan), false);
});

test('isPlanNeedsFacts: structured plan with only steps (no CRITERIA) is not flagged as needing facts', () => {
  // A plan with numbered steps but no CRITERIA block is still a real plan
  const plan = `1. Do step one
2. Do step two
3. Do step three`;
  assert.equal(isPlanNeedsFacts(plan), false);
});

// --- buildReorientFocus fixtures ---

test('buildReorientFocus: returns named file when present', () => {
  assert.equal(
    buildReorientFocus('let me start by reading src/foo.js'),
    'src/foo.js'
  );
});

test('buildReorientFocus: returns first file path found', () => {
  assert.equal(
    buildReorientFocus('I need to look at src/bar.py and python/baz.ts'),
    'src/bar.py'
  );
});

test('buildReorientFocus: handles python/ paths', () => {
  assert.equal(
    buildReorientFocus('let me read python/dashboard/routes/task.py'),
    'python/dashboard/routes/task.py'
  );
});

test('buildReorientFocus: handles docs/ paths', () => {
  assert.equal(
    buildReorientFocus('before creating the plan, let me read docs/README.md'),
    'docs/README.md'
  );
});

test('buildReorientFocus: returns fixed question when no file named', () => {
  const expected = 'which files and symbols does this task touch, and what is their current state';
  assert.equal(
    buildReorientFocus('let me start by reading'),
    expected
  );
});

test('buildReorientFocus: returns fixed question for empty text', () => {
  const expected = 'which files and symbols does this task touch, and what is their current state';
  assert.equal(
    buildReorientFocus(''),
    expected
  );
});

test('buildReorientFocus: returns fixed question for undefined', () => {
  const expected = 'which files and symbols does this task touch, and what is their current state';
  assert.equal(
    buildReorientFocus(undefined),
    expected
  );
});

test('buildReorientFocus: normalizes leading ./ in paths', () => {
  assert.equal(
    buildReorientFocus('let me read ./src/foo.js'),
    'src/foo.js'
  );
});

test('buildReorientFocus: handles lib/ paths', () => {
  assert.equal(
    buildReorientFocus('I need to understand lib/draft-context.js'),
    'lib/draft-context.js'
  );
});

test('buildReorientFocus: handles tests/ paths', () => {
  assert.equal(
    buildReorientFocus('let me read tests/test_plan.js'),
    'tests/test_plan.js'
  );
});

test('buildReorientFocus: handles scripts/ paths', () => {
  assert.equal(
    buildReorientFocus('before writing the plan, let me read scripts/run.sh'),
    'scripts/run.sh'
  );
});
