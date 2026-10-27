'use strict';

// hit-count-gate.test.js -- deterministic grep hit-count pre-check for the review stage
// (pipeline-debrief Task 2 / Flag 2). Two required cases per the acceptance criteria:
// (1) criterion asserts "exactly 3 hits", the file actually has 2 -> verdict blocked,
//     reason carries both actual and expected, and review-task.js returns on that path
//     BEFORE its resolvedMajorityVote dispatch (model reviewer never called);
// (2) the count matches -> the gate is a no-op (null) and the review proceeds to the
//     model reviewer as before.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  extractHitCountAssertions,
  checkHitCountGate,
} = require('./hit-count-gate.js');

function makeTempFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hit-count-gate-'));
  const file = path.join(dir, 'sample.js');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { dir, file };
}

test('extractHitCountAssertions parses both documented shapes', () => {
  const criteria = [
    '`grep -n STRIPE_PRICE_ .env.tower.example` returns exactly 3 hits',
    'grep -n foo src/foo.js returns 2 hits',
    'unrelated criterion with no grep assertion',
  ];
  const out = extractHitCountAssertions(criteria);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { symbol: 'STRIPE_PRICE_', file: '.env.tower.example', expected: 3 });
  assert.deepEqual(out[1], { symbol: 'foo', file: 'src/foo.js', expected: 2 });
});

test('extractHitCountAssertions is a no-op for criteria without a hit-count assertion', () => {
  assert.deepEqual(extractHitCountAssertions(['something else entirely']), []);
  assert.deepEqual(extractHitCountAssertions(null), []);
});

test('mismatch: actual 2 vs expected 3 -> blocked verdict with both counts in the reason', () => {
  // temp file contains `foo` on exactly 2 lines -- `grep -c foo` will report 2.
  const { dir, file } = makeTempFile(['function foo() {}', 'const x = foo;', 'const y = 1;']);
  const gate = checkHitCountGate({
    repoRoot: dir,
    criteria: ['`grep -n foo sample.js` returns exactly 3 hits'],
  });
  assert.equal(gate.verdict, 'blocked');
  assert.match(gate.blockedReason, /actual 2/);
  assert.match(gate.blockedReason, /expected 3/);
});

test('mismatch is reachable only BEFORE the model reviewer: gate precedes the vote dispatch in review-task.js', () => {
  // The "model reviewer never called" invariant lives in review-task.js's control flow:
  // the gate block returns a blocked verdict, and it is positioned textually before the
  // resolvedMajorityVote({...}) dispatch. A textual ordering assertion is this repo's
  // established convention for review-stage ordering guarantees.
  const src = fs.readFileSync(path.join(__dirname, 'review-task.js'), 'utf8');
  const gateIdx = src.indexOf('checkHitCountGate({ repoRoot: repoRootForCheck');
  const voteIdx = src.indexOf('const voteResult = await resolvedMajorityVote({');
  assert.ok(gateIdx > -1, 'hit-count gate call must exist in review-task.js');
  assert.ok(voteIdx > -1, 'vote dispatch must exist in review-task.js');
  assert.ok(gateIdx < voteIdx, 'gate must run before the model-reviewer dispatch');
  // And the gate's mismatch path RETURNS from runReview -- no fall-through to the vote:
  const gateBlock = src.slice(gateIdx, src.indexOf('await waitForLocalAvailability', gateIdx));
  assert.match(gateBlock, /verdict: 'blocked'/);
});

test('match: actual count equals expected -> gate is a no-op (null), review proceeds to the model reviewer', () => {
  const { dir, file } = makeTempFile(['function foo() {}', 'const x = foo;', 'const y = 1;']);
  const gate = checkHitCountGate({
    repoRoot: dir,
    criteria: ['`grep -n foo sample.js` returns exactly 2 hits'],
  });
  assert.equal(gate, null);
});

test('no recognized assertions -> gate is a no-op (null) with no side effects', () => {
  const gate = checkHitCountGate({ repoRoot: os.tmpdir(), criteria: ['just a prose criterion'] });
  assert.equal(gate, null);
});

test('unresolvable target file -> skipped, never a false block', () => {
  const gate = checkHitCountGate({
    repoRoot: os.tmpdir(),
    criteria: ['`grep -n foo no-such-file-xyz.js` returns exactly 3 hits'],
  });
  assert.equal(gate, null);
});

// The criterion describes the file AFTER the draft; the checkout holds it BEFORE. These tests use the real grep and real git diffs
// (nothing injected) so they exercise the post-image counting, not just the count comparison.
const { execFileSync } = require('node:child_process');

function repoWithDraft(before, after, file = 'src/heartbeat.js') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hit-count-repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), before.join('\n') + '\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(dir, file), after.join('\n') + '\n');
  const rawDiff = git('diff');
  git('checkout', '-q', '--', file); // the checkout is back to the pre-draft state, as in review
  return { dir, rawDiff };
}

const CRITERION = '`grep -n writeAtomicSync src/heartbeat.js` returns exactly 2 hits';

test('hit-count gate counts the draft post-image: a correct draft is not blocked for the pre-draft count', () => {
  const { dir, rawDiff } = repoWithDraft(
    ['const a = 1;', 'writeAtomicSync(x);'],
    ['const a = 1;', 'writeAtomicSync(x);', 'writeAtomicSync(y);'],
  );
  assert.equal(checkHitCountGate({ repoRoot: dir, criteria: [CRITERION], rawDiff }), null);
  // Without the diff the same criterion is counted against the unmodified file (1 hit) -- the false block this fixes.
  const blind = checkHitCountGate({ repoRoot: dir, criteria: [CRITERION] });
  assert.equal(blind.verdict, 'blocked');
});

test('hit-count gate still blocks when the post-image count is wrong, and reports the post-image count', () => {
  const { dir, rawDiff } = repoWithDraft(
    ['writeAtomicSync(x);'],
    ['writeAtomicSync(x);', 'writeAtomicSync(y);', 'writeAtomicSync(z);'],
  );
  const gate = checkHitCountGate({ repoRoot: dir, criteria: [CRITERION], rawDiff });
  assert.equal(gate.verdict, 'blocked');
  assert.match(gate.blockedReason, /actual 3, expected 2/);
});

test('hit-count gate counts the live file when the draft does not touch it', () => {
  const { dir } = repoWithDraft(['writeAtomicSync(a);', 'writeAtomicSync(b);'], ['writeAtomicSync(a);', 'writeAtomicSync(b);', '// edit']);
  const other = repoWithDraft(['x'], ['x', 'y'], 'src/other.js').rawDiff;
  assert.equal(checkHitCountGate({ repoRoot: dir, criteria: [CRITERION], rawDiff: other }), null);
});

test('hit-count gate skips (never blocks) when the draft section does not apply or deletes the file', () => {
  const { dir } = repoWithDraft(['writeAtomicSync(a);'], ['writeAtomicSync(a);', 'writeAtomicSync(b);']);
  const stale = repoWithDraft(['totally different'], ['totally different', 'writeAtomicSync(q);', 'writeAtomicSync(r);', 'writeAtomicSync(s);']).rawDiff;
  assert.equal(checkHitCountGate({ repoRoot: dir, criteria: [CRITERION], rawDiff: stale }), null, 'a section that does not apply is skipped');
  const del = [
    'diff --git a/src/heartbeat.js b/src/heartbeat.js',
    'deleted file mode 100644',
    '--- a/src/heartbeat.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-writeAtomicSync(a);',
    '',
  ].join('\n');
  assert.equal(checkHitCountGate({ repoRoot: dir, criteria: [CRITERION], rawDiff: del }), null, 'a deleted file is skipped');
});

test('hit-count gate removes its scratch directory', () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('hit-count-gate-'));
  const { dir, rawDiff } = repoWithDraft(['writeAtomicSync(x);'], ['writeAtomicSync(x);', 'writeAtomicSync(y);']);
  checkHitCountGate({ repoRoot: dir, criteria: [CRITERION], rawDiff });
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('hit-count-gate-'));
  assert.deepEqual(after.filter((n) => !before.includes(n)).length, 0);
});
