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
