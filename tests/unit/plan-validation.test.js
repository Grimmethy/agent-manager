'use strict';

// Tests for src/lib/plan-validation.js (HUB0316 · 1/4).
//
// Pure functions tested in isolation. HOME and state paths are set to temp dirs
// so no real filesystem state is touched.
//
// Run: node --test tests/unit/plan-validation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { isDegeneratePlan, isIncompletePlan, isExploratoryNarration } = require('../../src/lib/plan-validation.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-val-test-'));
  return tmp;
}

// ---------------------------------------------------------------------------
// isDegeneratePlan
// ---------------------------------------------------------------------------

test('isDegeneratePlan: empty string returns true', () => {
  assert.equal(isDegeneratePlan(''), true);
});

test('isDegeneratePlan: whitespace-only returns true', () => {
  assert.equal(isDegeneratePlan('   \n\t  '), true);
});

test('isDegeneratePlan: null/undefined returns true', () => {
  assert.equal(isDegeneratePlan(null), true);
  assert.equal(isDegeneratePlan(undefined), true);
});

test('isDegeneratePlan: very short text (under 50 chars) returns true', () => {
  assert.equal(isDegeneratePlan('hello world'), true);
  assert.equal(isDegeneratePlan('a'.repeat(49)), true);
});

test('isDegeneratePlan: exactly 50 chars returns false', () => {
  assert.equal(isDegeneratePlan('a'.repeat(50)), false);
});

test('isDegeneratePlan: normal valid plan returns false', () => {
  const plan = 'Step 1: Create the database schema. Step 2: Write the migration scripts. Step 3: Update the configuration files. Step 4: Run integration tests. Step 5: Deploy to staging environment.';
  assert.equal(isDegeneratePlan(plan), false);
});

test('isDegeneratePlan: short but valid plan (>= 50 chars) returns false', () => {
  const plan = 'Create the database schema, write the migration scripts, and run integration tests.';
  assert.equal(isDegeneratePlan(plan), false);
});

// ---------------------------------------------------------------------------
// isIncompletePlan
// ---------------------------------------------------------------------------

test('isIncompletePlan: empty string returns true', () => {
  assert.equal(isIncompletePlan(''), true);
});

test('isIncompletePlan: trailing "..." returns true', () => {
  assert.equal(isIncompletePlan('Step 1: Create the database. Step 2: ...'), true);
});

test('isIncompletePlan: no terminal punctuation returns true', () => {
  assert.equal(isIncompletePlan('Step 1: Create the database\nStep 2: Write migrations'), true);
});

test('isIncompletePlan: ends with period returns false', () => {
  assert.equal(isIncompletePlan('Step 1: Create the database. Step 2: Write migrations.'), false);
});

test('isIncompletePlan: ends with exclamation returns false', () => {
  assert.equal(isIncompletePlan('Step 1: Create the database! Step 2: Write migrations!'), false);
});

test('isIncompletePlan: ends with question mark returns false', () => {
  assert.equal(isIncompletePlan('Should we use PostgreSQL? Step 2: Write migrations.'), false);
});

test('isIncompletePlan: begins with "Let me..." returns true', () => {
  assert.equal(isIncompletePlan('Let me think about this. Step 1: ...'), true);
});

test('isIncompletePlan: begins with "I should..." returns true', () => {
  assert.equal(isIncompletePlan('I should create the database first. Then...'), true);
});

test('isIncompletePlan: begins with "I\'ll..." returns true', () => {
  assert.equal(isIncompletePlan("I'll start by creating the database schema. Then I'll..."), true);
});

test('isIncompletePlan: begins with "I will..." returns true', () => {
  assert.equal(isIncompletePlan('I will create the database. Then I will...'), true);
});

test('isIncompletePlan: begins with "I think..." returns true', () => {
  assert.equal(isIncompletePlan('I think we should use PostgreSQL. Then...'), true);
});

test('isIncompletePlan: begins with "first, "... returns true', () => {
  assert.equal(isIncompletePlan('First, create the database. Then...'), true);
});

test('isIncompletePlan: normal valid plan returns false', () => {
  const plan = 'Step 1: Create the database schema. Step 2: Write the migration scripts. Step 3: Update the configuration files. Step 4: Run integration tests. Step 5: Deploy to staging environment.';
  assert.equal(isIncompletePlan(plan), false);
});

test('isIncompletePlan: null/undefined returns true', () => {
  assert.equal(isIncompletePlan(null), true);
  assert.equal(isIncompletePlan(undefined), true);
});

// ---------------------------------------------------------------------------
// isExploratoryNarration
// ---------------------------------------------------------------------------

test('isExploratoryNarration: empty string returns true', () => {
  assert.equal(isExploratoryNarration(''), true);
});

test('isExploratoryNarration: null/undefined returns true', () => {
  assert.equal(isExploratoryNarration(null), true);
  assert.equal(isExploratoryNarration(undefined), true);
});

test('isExploratoryNarration: incomplete plan returns false (handled separately)', () => {
  assert.equal(isExploratoryNarration('Step 1: ...'), false);
});

test('isExploratoryNarration: hedging without actionable steps returns true', () => {
  const narration = 'I think maybe we could use PostgreSQL, or perhaps MongoDB. I\'m not sure which is better. Maybe we should consider the trade-offs.';
  assert.equal(isExploratoryNarration(narration), true);
});

test('isExploratoryNarration: speculative text without steps returns true', () => {
  const narration = 'I\'m thinking about using a microservices architecture. What if we went with a monolith instead? I wonder if that would be simpler.';
  assert.equal(isExploratoryNarration(narration), true);
});

test('isExploratoryNarration: text with clear action items returns false', () => {
  const plan = 'Step 1: Create the database schema. Step 2: Maybe use PostgreSQL. Step 3: Write migrations.';
  assert.equal(isExploratoryNarration(plan), false);
});

test('isExploratoryNarration: text with numbered list returns false', () => {
  const plan = '1. Create the database. 2. Write migrations. 3. Deploy.';
  assert.equal(isExploratoryNarration(plan), false);
});

test('isExploratoryNarration: text with imperative verbs returns false', () => {
  const plan = 'Create the database schema, then update the configuration files and run tests.';
  assert.equal(isExploratoryNarration(plan), false);
});

test('isExploratoryNarration: text with high question ratio returns true', () => {
  const narration = 'What if we use PostgreSQL? How about MongoDB? Should we go with a monolith? What are the trade-offs?';
  assert.equal(isExploratoryNarration(narration), true);
});

test('isExploratoryNarration: text with clear plan structure returns false', () => {
  const plan = 'Plan: First, create the database. Second, write migrations. Finally, deploy.';
  assert.equal(isExploratoryNarration(plan), false);
});

test('isExploratoryNarration: text with todo list returns false', () => {
  const plan = 'Action items: create the database, write migrations, deploy to staging.';
  assert.equal(isExploratoryNarration(plan), false);
});

// ---------------------------------------------------------------------------
// Integration: HOME / temp dir isolation
// ---------------------------------------------------------------------------

test('tests set HOME to a temp directory for isolation', () => {
  const tmpHome = makeTempHome();
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    // Functions should work regardless of HOME value — they are pure.
    assert.equal(isDegeneratePlan(''), true);
    assert.equal(isIncompletePlan('Step 1: ...'), true);
    assert.equal(isExploratoryNarration('I think maybe we could use PostgreSQL.'), true);
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('all three functions are deterministic for the same input', () => {
  const input = 'Step 1: Create the database schema. Step 2: Write migrations.';
  assert.equal(isDegeneratePlan(input), isDegeneratePlan(input));
  assert.equal(isIncompletePlan(input), isIncompletePlan(input));
  assert.equal(isExploratoryNarration(input), isExploratoryNarration(input));
});
