'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planTargetNoLongerBlocks, ungroundedUrlsAreTestFixtures } = require('./gate-readmit.js');

const repo = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-readmit-')); fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'real.js'), '//\n'); return d; };
const planBlocked = (over = {}) => ({
  id: 't', title: '`res.json()` on a non-JSON 200 response throws', promptContext: { rawText: 'In `real.js` line 3 the body may be HTML.' },
  planResponse: 'Edit `src/real.js` to wrap `await res.json()` in a try.',
  blockedReason: 'plan cites missing-file target(s): res.json', blockedStage: 'pre-implement',
  needsClarification: { reason: 'fabricated-file-path', openQuestions: 'plan cites missing-file target(s): res.json' }, ...over,
});

test('planTargetNoLongerBlocks: a misfire the fixed guard lets through is re-admitted', () => {
  assert.equal(planTargetNoLongerBlocks(planBlocked(), repo()), true);
});

test('planTargetNoLongerBlocks: a genuinely fabricated target, another reason, no plan and no repo are NOT re-admitted', () => {
  const r = repo();
  const fabricated = planBlocked({ title: 'Edit src/invented.js to add a guard', planResponse: 'Edit `src/invented.js` to add a guard.', blockedReason: 'plan cites missing-file target(s): src/invented.js' });
  assert.equal(planTargetNoLongerBlocks(fabricated, r), false, 'still blocks');
  assert.equal(planTargetNoLongerBlocks(planBlocked({ blockedReason: 'Implement pass degenerate', needsClarification: { reason: 'x' } }), r), false, 'a different block');
  assert.equal(planTargetNoLongerBlocks(planBlocked({ planResponse: '', lastGoodPlan: '' }), r), false, 'no plan to re-run');
  assert.equal(planTargetNoLongerBlocks(planBlocked(), null), false, 'no repo');
  assert.equal(planTargetNoLongerBlocks(null, r), false);
});

const DIFF = (file, line) => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}`;
const ungrounded = (flags, impl, over = {}) => ({
  id: 'u', blockedReason: `Deterministic gate: draft cites a value that appears nowhere in its real grounding source -- ${flags}. This fact-check flag is high-precision.`,
  implementResponse: impl, needsClarification: { reason: 'fabricated-ungrounded-claim', openQuestions: '1. older attempt -- ungrounded-field: OLD_FLAG_FROM_EARLIER_DRAFT' }, ...over,
});

test('ungroundedUrlsAreTestFixtures: only-URL flags that live in an added test file are re-admitted, whatever an EARLIER attempt was flagged for', () => {
  const impl = DIFF('pkg/tests/test_x.py', 'url = "http://ex.com/a.pdf"');
  assert.equal(ungroundedUrlsAreTestFixtures(ungrounded('ungrounded-url: http://ex.com/a.pdf', impl)), true);
  assert.equal(ungroundedUrlsAreTestFixtures(ungrounded('ungrounded-url: http://ex.com/a.pdf; ungrounded-url: http://ex.com/a.pdf', impl)), true);
});

test('ungroundedUrlsAreTestFixtures: reads only the LATEST block reason, never the attempt history in needsClarification.openQuestions', () => {
  const impl = DIFF('pkg/tests/test_x.py', 'url = "http://ex.com/a.pdf"');
  const noBlockedReason = { id: 'u', implementResponse: impl, needsClarification: { reason: 'Deterministic gate: draft cites a value that appears nowhere in its real grounding source -- ungrounded-url: http://ex.com/a.pdf. x', openQuestions: '1. older attempt -- ungrounded-field: OLD_FLAG_FROM_EARLIER_DRAFT' } };
  assert.equal(ungroundedUrlsAreTestFixtures(noBlockedReason), true, 'the old field flag in the history must not veto');
});

test('ungroundedUrlsAreTestFixtures: when only SOME flagged URLs are fixtures the task is NOT re-admitted', () => {
  const impl = DIFF('pkg/tests/test_x.py', 'url = "http://ex.com/a.pdf"');
  assert.equal(ungroundedUrlsAreTestFixtures(ungrounded('ungrounded-url: http://ex.com/a.pdf; ungrounded-url: http://other.com/b', impl)), false);
});

test('ungroundedUrlsAreTestFixtures: a field flag, a URL outside test files, an unknown URL and a different reason are NOT re-admitted', () => {
  const impl = DIFF('pkg/tests/test_x.py', 'url = "http://ex.com/a.pdf"');
  assert.equal(ungroundedUrlsAreTestFixtures(ungrounded('ungrounded-url: http://ex.com/a.pdf; ungrounded-field: SOME_FIELD', impl)), false, 'a field is flagged too');
  assert.equal(ungroundedUrlsAreTestFixtures(ungrounded('ungrounded-url: http://ex.com/a.pdf', DIFF('pkg/cache.py', 'URL = "http://ex.com/a.pdf"'))), false, 'production file');
  assert.equal(ungroundedUrlsAreTestFixtures(ungrounded('ungrounded-url: http://other.com/b', impl)), false, 'not a fixture of this draft');
  assert.equal(ungroundedUrlsAreTestFixtures({ ...ungrounded('ungrounded-url: http://ex.com/a.pdf', impl), blockedReason: 'Implement pass degenerate' }), false);
  assert.equal(ungroundedUrlsAreTestFixtures(ungrounded('', impl)), false, 'no parsable flag');
  assert.equal(ungroundedUrlsAreTestFixtures(null), false);
});
