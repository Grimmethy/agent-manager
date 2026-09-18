'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planTargetGuard, isDeclaredCreateTarget } = require('./plan-target-guard.js');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-target-guard-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'real.js'), '// real\n');
  return dir;
}

test('blocked:false when the plan-declared target exists', () => {
  const repo = tmpRepo();
  const task = { title: 'Edit src/real.js to add a guard' };
  const r = planTargetGuard(task, 'Edit `src/real.js` to add a guard.', repo, ['src']);
  assert.equal(r.blocked, false);
});

test('blocked:true + missing list when a declared target does not exist and is not a create mention', () => {
  const repo = tmpRepo();
  const task = { title: 'Edit src/phantom.js to add a guard' };
  const planText = 'EDIT `src/phantom.js` to add the guard.';
  const r = planTargetGuard(task, planText, repo, ['src']);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.missing, ['src/phantom.js']);
  assert.match(r.reason, /^plan cites missing-file target\(s\): src\/phantom\.js$/);
});

test('a plan that explicitly proposes CREATING the target is not flagged', () => {
  const repo = tmpRepo();
  const task = { title: 'Create src/brand-new.js' };
  const planText = 'Create `src/brand-new.js` with the new helper.';
  const r = planTargetGuard(task, planText, repo, ['src']);
  assert.equal(r.blocked, false);
});

test('no declared targets -> not blocked (nothing to check)', () => {
  const repo = tmpRepo();
  const r = planTargetGuard({ title: 'Investigate the pipeline' }, 'Just some prose with no file mentions.', repo, ['src']);
  assert.equal(r.blocked, false);
});

test('missing repoRoot -> not blocked (advisory no-op)', () => {
  const task = { title: 'Edit src/phantom.js' };
  const r = planTargetGuard(task, 'EDIT `src/phantom.js`.', '', ['src']);
  assert.equal(r.blocked, false);
});

test('isDeclaredCreateTarget: true only when a creation verb precedes the mention closely', () => {
  assert.equal(isDeclaredCreateTarget('Create `src/new.js` now.', 'src/new.js'), true);
  assert.equal(isDeclaredCreateTarget('Add a new file at `src/new.js`.', 'src/new.js'), true);
  assert.equal(isDeclaredCreateTarget('Edit `src/new.js` carefully.', 'src/new.js'), false);
  assert.equal(isDeclaredCreateTarget('We created something earlier. Now edit `src/new.js`.', 'src/new.js'), false);
});

// Existence-acknowledgment signal (2026-09-18, pipeline hardening -- see
// plan-target-guard.js's own header for the 16-real-attempt incident this closes).
test('isDeclaredCreateTarget: true when the plan states the target does not exist yet, AFTER the mention (the real live phrasing)', () => {
  assert.equal(
    isDeclaredCreateTarget('`src/review-parity.test.js` does **not** exist yet (confirmed by the orientation report).', 'src/review-parity.test.js'),
    true,
  );
});

test('isDeclaredCreateTarget: true for "doesn\'t exist" contraction, and "not yet present/created" phrasing', () => {
  assert.equal(isDeclaredCreateTarget('`src/new.js` doesn\'t exist in the repo.', 'src/new.js'), true);
  assert.equal(isDeclaredCreateTarget('`src/new.js` is not yet present, so this task will add it.', 'src/new.js'), true);
  assert.equal(isDeclaredCreateTarget('`src/new.js` is not yet created.', 'src/new.js'), true);
});

test('isDeclaredCreateTarget: true when the existence-acknowledgment phrase precedes the mention', () => {
  assert.equal(isDeclaredCreateTarget('This file does not exist yet: `src/new.js`.', 'src/new.js'), true);
});

test('isDeclaredCreateTarget: an existence-acknowledgment phrase far away (outside the local window) does not blanket-exempt an unrelated mention', () => {
  const planText = `We confirmed src/other.js does not exist yet. ${'padding '.repeat(20)} Now EDIT \`src/new.js\` carefully.`;
  assert.equal(isDeclaredCreateTarget(planText, 'src/new.js'), false);
});

test('planTargetGuard end to end: the real "does not exist yet" phrasing is not blocked', () => {
  const repo = tmpRepo();
  const task = { title: 'Create src/review-parity.test.js' };
  const planText = '`src/review-parity.test.js` does **not** exist yet (confirmed by the orientation report). Write the parity tests there.';
  const r = planTargetGuard(task, planText, repo, ['src']);
  assert.equal(r.blocked, false);
});

test('does not import from the draft pipeline -- only adhoc-diff-sanity.js and fact-checker.js', () => {
  const src = fs.readFileSync(path.join(__dirname, 'plan-target-guard.js'), 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['./adhoc-diff-sanity.js', './fact-checker.js'].sort());
});
