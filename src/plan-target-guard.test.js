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

// --- stacked tasks: a target that exists only on the chain branch is real (2026-09-20, PF HUB0005-01) --------------------------------------------
test('existsAtRef rescues a plan target the working tree lacks but the stacked branch has', () => {
  const repo = tmpRepo();
  const task = { title: 'Add latLngToPx to src/lib/tileGrid.ts' };
  const planText = 'Modify `src/lib/tileGrid.ts` to export latLngToPx.';
  assert.equal(planTargetGuard(task, planText, repo, ['src']).blocked, true, 'without a ref the file reads as fabricated');
  const seen = [];
  const r = planTargetGuard(task, planText, repo, ['src'], (p) => { seen.push(p); return p === 'src/lib/tileGrid.ts'; });
  assert.equal(r.blocked, false);
  assert.deepEqual(seen, ['src/lib/tileGrid.ts']);
});

test('existsAtRef only rescues: false, a throw, or a non-function leaves a fabricated target blocked', () => {
  const repo = tmpRepo();
  const task = { title: 'Edit src/phantom.js to add a guard' };
  const planText = 'EDIT `src/phantom.js` to add the guard.';
  for (const cb of [() => false, () => { throw new Error('git gone'); }, 'nope', () => 'truthy-but-not-true']) {
    const r = planTargetGuard(task, planText, repo, ['src'], cb);
    assert.equal(r.blocked, true);
    assert.deepEqual(r.missing, ['src/phantom.js']);
  }
});

test('existsAtRef is not consulted for a target that exists in the working tree', () => {
  const repo = tmpRepo();
  let called = 0;
  const r = planTargetGuard({ title: 'Edit src/real.js' }, 'Edit `src/real.js` to add a guard.', repo, ['src'], () => { called += 1; return false; });
  assert.equal(r.blocked, false);
  assert.equal(called, 0);
});

// 2026-10-08 (HUB0011-02 "Create test_or_columbia_value.py"): the task's own create verb and an "is absent" acknowledgement both declare a create target.
test('a task titled "Create <file>" makes that file a create target even when the plan only calls the full path "absent"', () => {
  const repo = tmpRepo();
  const task = { title: 'HUB0011 · 2/2 · Create test_or_columbia_value.py', promptContext: { rawText: 'Create or extend enrichers/test_or_columbia_value.py with a test that mocks the Playwright instance.' } };
  const plan = 'A grep for the name returned zero hits, confirming `enrichers/test_or_columbia_value.py` is absent. This step writes the test.';
  assert.equal(planTargetGuard(task, plan, repo, ['src']).blocked, false);
  assert.equal(isDeclaredCreateTarget(plan, 'test_or_columbia_value.py', task.title), true);
});

test('the TASK\'s own "Create <file>" exempts the target even when the plan says nothing about creating or absence (isolates the task-level signal)', () => {
  const repo = tmpRepo();
  const task = { title: 'HUB0011 · 2/2 · Create brand_new_check.test.js', promptContext: { rawText: 'Write the first test.' } };
  const plan = 'Add the tests to `brand_new_check.test.js` covering the reset path.';
  assert.equal(isDeclaredCreateTarget(plan, 'brand_new_check.test.js'), false, 'the plan alone gives no signal');
  assert.equal(isDeclaredCreateTarget(plan, 'brand_new_check.test.js', task.title), true, 'the task title does');
  assert.equal(planTargetGuard(task, plan, repo, ['src']).blocked, false);
  assert.equal(planTargetGuard({ title: 'Update brand_new_check.test.js' }, plan, repo, ['src']).blocked, true, 'without the create verb it is a missing target');
});

test('"is absent", "not present", "not found" and "no such file" next to the path are existence acknowledgements', () => {
  for (const phrase of ['`new.js` is absent', '`new.js` is not present', '`new.js` is not found', '`new.js`: no such file', 'the file `new.js` was absent']) {
    assert.equal(isDeclaredCreateTarget(`Note: ${phrase} in the tree.`, 'new.js'), true, phrase);
  }
  assert.equal(isDeclaredCreateTarget('The helper in `new.js` is present and used widely.', 'new.js'), false);
});

test('a fabricated path with no create signal anywhere is STILL blocked, and a create verb about a different file does not exempt it', () => {
  const repo = tmpRepo();
  const task = { title: 'Edit src/invented.js to add a guard', promptContext: { rawText: 'Create a summary of the problem first, then edit src/invented.js.' } };
  const r = planTargetGuard(task, 'Edit `src/invented.js` to add a guard.', repo, ['src']);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.missing, ['src/invented.js']);
  const far = { title: 'Create the docs/overview.md page and then, once a long and detailed description of everything that happens on that page has been written out in full, fix src/invented.js' };
  assert.equal(isDeclaredCreateTarget('Edit `src/invented.js`.', 'src/invented.js', far.title), false, 'the create verb is about another file, > 80 chars away');
});

test('planTargetGuard no longer blocks a title that is a call expression (res.json())', () => {
  const repo = tmpRepo();
  const task = { title: '`res.json()` on a non-JSON 200 response throws inside the try', promptContext: { rawText: 'In `real.js` line 3 the body may be HTML.' } };
  assert.equal(planTargetGuard(task, 'Edit `src/real.js` to wrap `await res.json()` in a try.', repo, ['src']).blocked, false);
});
